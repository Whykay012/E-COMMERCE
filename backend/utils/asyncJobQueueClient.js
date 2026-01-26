// utils/asyncJobQueueClient.js (JobClient: Throttled, Deduped, Idempotent Submission, TRACED)

// --- External Dependencies ---
const QueueConnector = require('./queueingSystemClient'); // Assumed Queue Client wrapper
const Logger = require('./logger'); // Upgraded Pino/Worker Logger
const Metrics = require('./metricsClient');
const CacheClient = require('./highSpeedCacheClient'); 
const JobThrottler = require('./policyRateLimiterClient'); 
const { InternalServerError } = require('../errors/custom-errors'); 
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const Tracing = require('./tracingClient'); // FULLY UPGRADED OpenTelemetry Client

// --- Configuration ---
const DEFAULT_QUEUE = process.env.JOB_QUEUE_NAME || 'default_async_jobs';
const DEDUP_WINDOW_SECONDS = 30; 
const SUBMISSION_RPS_LIMIT = 50; 

const jobSubmissionLimiter = new JobThrottler({ 
    limit: SUBMISSION_RPS_LIMIT, 
    interval: 1000 
});

const JobClient = {
    VERSION: '1.5.0',

    _getDedupKey(jobName, entityId) {
        const hash = crypto.createHash('sha256').update(`${jobName}:${entityId}`).digest('hex');
        return `job:dedup:${hash}`;
    },

    /**
     * @desc Submits a new structured job to the async queue with throttling, deduping, and tracing.
     */
    async submit(payload, queueName = DEFAULT_QUEUE) {
        
        // 🚀 CRITICAL UPGRADE: Wrap the entire submission flow in a span.
        // This ensures all subsequent logs and I/O operations (Cache, Queue) are tied 
        // to a single traceable operation. 
        return Tracing.withSpan('JobClient.submit', async (span) => {
            const { jobName, entityId, data } = payload;
            
            // --- 1. Validation ---
            if (!jobName || !entityId || !data) {
                Metrics.security('jobqueue.submit.validation_fail');
                // Record the error before throwing
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: "Missing required payload fields." });
                throw new InternalServerError("Job submission requires jobName, entityId, and data.");
            }

            // --- 2. Rate Limiting / Throttling ---
            if (!jobSubmissionLimiter.canProceed()) {
                Metrics.increment('jobqueue.submit.throttled');
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: "Rate limit exceeded." });
                throw new InternalServerError(`Job submission rate exceeded the limit of ${SUBMISSION_RPS_LIMIT} RPS.`);
            }
            
            // 💡 TRACING: Add core attributes to the span
            span.setAttribute('job.name', jobName);
            span.setAttribute('entity.id', entityId);
            span.setAttribute('queue.name', queueName);

            // --- 3. Deduplication Check ---
            const dedupKey = JobClient._getDedupKey(jobName, entityId);
            const cachedJobId = await CacheClient.get(dedupKey); 

            if (cachedJobId && cachedJobId !== 'null') {
                Metrics.increment('jobqueue.submit.deduped');
                Logger.warn('JOB_SUBMIT_DEDUPED', { jobName, entityId, existingJobId: cachedJobId });
                // 💡 TRACING: Mark as deduped and finish the span successfully
                span.setAttribute('job.deduped', true);
                span.setAttribute('job.status', 'DEDUPED');
                return cachedJobId; 
            }
            
            span.setAttribute('job.deduped', false);

            const jobId = uuidv4();
            const structuredJob = { jobId, queueTime: new Date().toISOString(), status: 'SUBMITTED', ...payload };

            try {
                // --- 4. Enqueue Job ---
                await QueueConnector.enqueue(queueName, structuredJob, { delaySeconds: payload.delaySeconds || 0 });

                // --- 5. Set Deduping Marker ---
                await CacheClient.set(dedupKey, jobId, DEDUP_WINDOW_SECONDS); 

                Metrics.increment(`jobqueue.submit.success.${jobName}`);
                Logger.info('JOB_SUBMIT_SUCCESS', { jobId, jobName, queueName });
                
                // Span status is automatically set to OK (Code 1) upon successful exit from Tracing.withSpan
                return jobId;

            } catch (error) {
                Metrics.critical(`jobqueue.submit.fail.${jobName}`);
                Logger.error('JOB_SUBMIT_FAIL', { jobId, jobName, error: error.message });
                
                // 🛑 CRITICAL TRACING: Ensure error is recorded and status is set on failure
                span.recordException(error);
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: error.message });

                throw new InternalServerError(`Failed to submit job ${jobName}.`);
            }
        }); // Tracing.withSpan handles span.end() and context management
    },
    
    initialize: async () => {
        await QueueConnector.connect();
        Logger.info('JOB_QUEUE_CLIENT_INITIALIZED', { version: JobClient.VERSION, rpsLimit: SUBMISSION_RPS_LIMIT });
    },
    
    shutdown: async () => {
        await QueueConnector.disconnect();
        Logger.info('JOB_QUEUE_CLIENT_SHUTDOWN');
    }
};

module.exports = JobClient;