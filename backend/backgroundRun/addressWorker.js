// queues/addressWorker.js (Adaptive Concurrency & Full Tracing)

const { Queue, Worker, QueueScheduler, Job } = require('bullmq'); 
const logger = require('../config/logger'); 
const Tracing = require('../utils/tracingClient'); 
const AuditLogger = require('../services/auditLogger'); 
const LockManager = require('../utils/lockManager'); // Assuming LockManager.js exists
const { CircuitBreaker } = require('../utils/circuitBreaker'); // Assuming CircuitBreaker.js exists
const { geocodeAddressExternal, geocoderQuotaService } = require('../integrations/geocoder'); // Assuming external integration helpers exist
const addressModel = require('../model/address'); // Assuming Mongoose model exists
const { RateLimiterMemory } = require('rate-limiter-flexible'); 
const metrics = require('../config/metrics'); // Assuming metrics client exists

// --- CONFIGURATION ---
const INITIAL_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
const MAX_CONCURRENCY = 20; 
const MIN_CONCURRENCY = 1;
const LATENCY_THRESHOLD_MS = 1200; // Geocoding takes time; allow 1.2s before throttling

// --- REDIS CONNECTION ---
const REDIS_CONFIG = { 
    port: process.env.REDIS_PORT || 6379, 
    host: process.env.REDIS_HOST || '127.0.0.1',
    maxRetriesPerRequest: null, 
    enableReadyCheck: false 
};
const connection = REDIS_CONFIG;

// --- QUEUE NAMES ---
const QUEUE_NAME = 'address-processing';
const DLQ_QUEUE_NAME = 'address-dlq';

// --- ADAPTIVE CONCURRENCY STATE (Global/Module Scope) ---
let currentConcurrency = INITIAL_CONCURRENCY;
let lastTenDurations = []; // Simple sliding window for average calculation

// --- EXTERNAL API PROTECTION ---
const GEOCORDER_RPS_LIMIT = 10; 
const sharedApiLimiter = new RateLimiterMemory({
    points: GEOCORDER_RPS_LIMIT, duration: 1, keyPrefix: 'geocode_api_limit',
});

// 🚀 Circuit Breaker instance (needs to be defined globally)
const geocoderCircuitBreaker = new CircuitBreaker(geocodeAddressExternal, {
    failureThreshold: 5,
    resetTimeout: 60000, 
    timeout: 5000 
});


// --- Custom Errors ---
class JobAlreadyProcessedError extends Error { 
    constructor(message) {
        super(message);
        this.name = 'JobAlreadyProcessedError';
    }
}
class QuotaExceededError extends Error { 
    constructor(message) {
        super(message);
        this.name = 'QuotaExceededError';
    }
}
class CircuitOpenError extends Error { 
    constructor(message = "Geocoding service is currently unavailable (Circuit Open)") {
        super(message);
        this.name = 'CircuitOpenError';
    }
}


// 1. Queue and Scheduler Setup
const addressQueue = new Queue(QUEUE_NAME, { connection });
const scheduler = new QueueScheduler(QUEUE_NAME, { connection });
const addressDLQ = new Queue(DLQ_QUEUE_NAME, { connection });


// 🚀 NEW: Function to perform ADAPTIVE CONCURRENCY adjustment
const adjustConcurrency = async (jobDurationMs) => {
    // 1. Update sliding window
    lastTenDurations.push(jobDurationMs);
    if (lastTenDurations.length > 10) {
        lastTenDurations.shift();
    }
    
    // 2. Calculate average duration
    const averageDuration = lastTenDurations.reduce((a, b) => a + b, 0) / lastTenDurations.length;

    // 3. Throttle down if consistently slow
    if (averageDuration > LATENCY_THRESHOLD_MS && currentConcurrency > MIN_CONCURRENCY) {
        currentConcurrency = Math.max(MIN_CONCURRENCY, currentConcurrency - 1); // Decrease linearly
        logger.warn('CONCURRENCY_DECREASED', { old: worker.concurrency, new: currentConcurrency, avg_latency: averageDuration.toFixed(0) });
        worker.concurrency = currentConcurrency;
        metrics.gauge('worker_current_concurrency', currentConcurrency);
    } 
    // 4. Scale up if consistently fast
    else if (averageDuration < LATENCY_THRESHOLD_MS / 2 && currentConcurrency < MAX_CONCURRENCY) {
        currentConcurrency = Math.min(MAX_CONCURRENCY, currentConcurrency + 1); // Increase linearly
        logger.debug('CONCURRENCY_INCREASED', { old: worker.concurrency, new: currentConcurrency, avg_latency: averageDuration.toFixed(0) });
        worker.concurrency = currentConcurrency;
        metrics.gauge('worker_current_concurrency', currentConcurrency);
    }
};


// 2. The Job Processor (Worker) Logic
const geocodeProcessor = async (job) => {
    const { addressId, fullAddress, priority, traceContext, userId } = job.data;
    let lockAcquired = false;
    
    // 🚀 CRITICAL: Restore Tracing context for end-to-end visibility
    return Tracing.context.with(Tracing.deserializeContext(traceContext), async () => {
        return Tracing.withSpan(`Worker:${job.name}`, async (span) => {
            span.setAttributes({ 'job.id': job.id, 'address.id': addressId, 'job.attempts_made': job.attemptsMade });
            const startTime = process.hrtime.bigint(); // Start timing before locks/checks

            try {
                // 1. Distributed Lock for Strong Idempotency
                if (!await LockManager.acquireLock(addressId)) {
                    throw new JobAlreadyProcessedError(`Address ${addressId} lock unavailable.`);
                }
                lockAcquired = true;

                // 2. Quota, Rate Limit, and Circuit Breaker Checks
                if (await geocoderQuotaService.isQuotaExceeded()) {
                    throw new QuotaExceededError("Daily geocoding quota exceeded.");
                }
                await sharedApiLimiter.consume(addressId);
                
                if (geocoderCircuitBreaker.isClosed === false) {
                    throw new CircuitOpenError();
                }

                // 3. High-Latency External API Call via Circuit Breaker
                const coordinates = await geocoderCircuitBreaker.execute(fullAddress);
                
                // 4. Atomic Database Update (Idempotency Check 2)
                const updateResult = await addressModel.findOneAndUpdate({
                    _id: addressId,
                    'metadata.isGeocoded': { $ne: true } 
                }, { 
                    $set: { 
                        'metadata.isGeocoded': true,
                        'location.type': 'Point',
                        'location.coordinates': [coordinates.longitude, coordinates.latitude],
                    }
                }, { 
                    new: true, 
                    runValidators: true,
                    writeConcern: { w: 'majority' } 
                }).lean();

                if (!updateResult) {
                    throw new JobAlreadyProcessedError(`Address ${addressId} already geocoded or not found.`);
                }
                
                // 5. METRICS, TRACING & ADAPTIVE CONCURRENCY
                const endTime = process.hrtime.bigint();
                const durationMs = Number(endTime - startTime) / 1000000;

                await adjustConcurrency(durationMs); // Adjust worker pool size based on performance

                metrics.histogram('geocode_job_duration', durationMs, { status: 'success' });
                span.setStatus({ code: Tracing.SpanStatusCode.OK });
                
                AuditLogger.log({ level: 'INFO', event: 'ADDRESS_GEOCODING_SUCCESS', userId: userId, details: { addressId, durationMs: durationMs, jobId: job.id } });

                return { success: true, coordinates, jobId: job.id };

            } catch (error) {
                span.recordException(error);
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: error.message });
                
                // Handle No-Retry Errors (Idempotency, Quota, Circuit)
                if (error instanceof JobAlreadyProcessedError || error instanceof QuotaExceededError || error instanceof CircuitOpenError) {
                    logger.warn(`[${job.id}] Discarding job (no-retry error): ${error.name}`);
                    
                    // Mark as completed to remove from queue without retrying
                    job.moveToCompleted({ message: error.name }, job.id, false); 
                    
                    if (error instanceof QuotaExceededError || error instanceof CircuitOpenError) {
                         AuditLogger.log({ level: 'CRITICAL', event: 'GEOCODER_BLOCKED', details: { addressId, reason: error.name } });
                    }
                    return; 
                }

                // Standard Failure Reporting
                metrics.counter('geocode_job_failures', 1, { status: error.name.includes('RateLimit') || error instanceof Error ? 'retriable' : 'critical' });
                logger.error(`[${job.id}] Retriable failure: ${error.message}`);
                
                throw error; // Let BullMQ handle the retry mechanism
            } finally {
                if (lockAcquired) {
                    await LockManager.releaseLock(addressId);
                }
            }
        }); 
    }); 
};


// 3. Worker Instance
let worker = new Worker(QUEUE_NAME, geocodeProcessor, {
    connection,
    concurrency: currentConcurrency, 
    autorun: false,
    // Add job-level metrics tracking for better observability
    metrics: { maxDataPoints: 100, retainData: 3600 } 
});


// 4. Event Listeners and Graceful Shutdown
worker.on('failed', async (job, error) => {
    logger.error(`[${job.id}] Job failed permanently. Moving to DLQ.`, { error: error.message });
    
    await addressDLQ.add('permanent-failure', { 
        originalJob: job.data, 
        finalError: { message: error.message, stack: error.stack },
        failedAt: new Date().toISOString()
    });
    
    // Explicit removal since removeOnFail was false
    await job.remove(); 
    
    AuditLogger.log({ level: 'CRITICAL', event: 'ADDRESS_GEOCODING_FAILURE_DLQ', details: { addressId: job.data.addressId, error: error.message } });
});

worker.on('error', (error) => {
    logger.critical(`BullMQ Worker Error: ${error.message}`, { queue: QUEUE_NAME, err: error });
    metrics.counter('queue_operational_errors', 1);
});

worker.on('stalled', (jobId) => {
    logger.warn(`Job ${jobId} in queue ${QUEUE_NAME} stalled.`);
    metrics.counter('queue_stalled_jobs', 1);
});


const shutdown = async () => {
    logger.warn('Received shutdown signal. Starting graceful exit...');
    // Draining prevents new jobs from being pulled
    await worker.close(); 
    await scheduler.close();
    logger.info('BullMQ worker and scheduler closed gracefully.');
    process.exit(0); 
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 5. Module Export: Worker Starter
module.exports = {
    start: () => {
        worker.run();
        logger.info(`BullMQ Worker started with initial concurrency: ${currentConcurrency}`);
        metrics.gauge('worker_current_concurrency', currentConcurrency);
    },
    addressQueue // Export the queue for producers (addressService)
};