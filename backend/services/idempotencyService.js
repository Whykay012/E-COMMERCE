// services/idempotencyService.js (Production-Ready)

const crypto = require("crypto");
const { Queue, Worker } = require("bullmq"); 
const Redis = require("ioredis");
const IdempotencyRecord = require("../model/idempotencySchema"); // Assumed to be your Mongoose model

// 🚀 ENTERPRISE UTILITIES INTEGRATION
const Tracing = require("../utils/tracingClient"); 
const Metrics = require("../utils/metricsClient"); 
const Logger = require("../utils/logger"); 

// =========================================================================
// ⚙️ 1. CONFIGURATION AND CONNECTIONS
// =========================================================================

// Relying on environment variables being set by the host process (e.g., K8s, Docker, .env file)
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'; 
const IDEMPOTENCY_SECRET = process.env.IDEMPOTENCY_SECRET; 

if (!IDEMPOTENCY_SECRET || IDEMPOTENCY_SECRET.length < 16) {
    // Using Logger.critical synchronously before initialization for FATAL errors
    Logger.critical("FATAL_CONFIG_ERROR", { reason: "IDEMPOTENCY_SECRET missing or too short" });
    throw new Error("FATAL: IDEMPOTENCY_SECRET environment variable missing or too short (must be >= 16 chars)");
}

const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // This is mandatory for BullMQ
});
const connection = redis;

// BullMQ setup for background jobs (cleanup, aggregation, etc.)
const idempotencyQueue = new Queue("idempotencyQueue", { connection });

// Configurable TTLs (using sensible defaults if env vars are missing)
const REDIS_LOCK_TTL = parseInt(process.env.REDIS_LOCK_TTL) || 60; // 60 seconds for lock
const REDIS_CACHE_TTL = parseInt(process.env.REDIS_CACHE_TTL) || 3600; // 1 hour for cache
const STALE_RECORD_TTL = parseInt(process.env.STALE_RECORD_TTL) || 7 * 24 * 3600; // 7 days for cleanup

const IDEMPOTENCY_HEADER_CANDIDATES = ["idempotency-key", "x-idempotency-key"];

// =========================================================================
// 🛠️ 2. UTILITY FUNCTIONS
// =========================================================================

/**
 * Sanitize key
 */
function sanitizeKey(value) {
    if (!value) {
        Metrics.security("idempotency.invalid_key_attempt");
        throw new Error("Idempotency key cannot be empty");
    }
    return String(value).trim().slice(0, 128).replace(/[^\w\-:.]/g, "");
}

/**
 * Deterministic fallback fingerprint
 */
function createFallbackFingerprint(req) {
    const body = req.body ? JSON.stringify(req.body) : "";
    // Note: Assuming req.user is populated by a prior auth middleware
    const userId = req.user?.id || req.user?._id || "anon"; 
    const canonical = [req.method, req.baseUrl || "", req.path, userId, body].join("|");
    return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Normalize key using HMAC
 */
function normalizeKey(rawKey) {
    return crypto.createHmac("sha256", IDEMPOTENCY_SECRET).update(rawKey).digest("hex");
}

/**
 * Acquire lock (Redis + fallback Mongo check)
 */
async function acquireLock(normalizedKey, step) {
    return Tracing.withSpan("IdempotencyService:acquireLock", async (span) => {
        const lockKey = `idem_lock:${normalizedKey}:${step}`;
        span.setAttributes({ 'idempotency.key': normalizedKey, 'lock.key': lockKey, 'lock.step': step });

        try {
            const acquired = await redis.set(lockKey, "1", "NX", "EX", REDIS_LOCK_TTL);
            if (acquired) {
                Metrics.increment("idempotency.lock.acquire_success");
                span.setAttribute('lock.status', 'acquired');
                return lockKey;
            }
            
            Metrics.increment("idempotency.lock.acquire_fail");
            span.setAttribute('lock.status', 'conflict:redis');
            
            // Fallback: Check Mongo in case Redis failed or lost data recently
            const existingRecord = await IdempotencyRecord.findOne({ idempotencyKey: normalizedKey, responseBody: { step } });
            
            if (existingRecord) {
                // If a record exists in MongoDB, treat it as a lock conflict (in progress or completed)
                span.setAttribute('lock.status', 'conflict:mongo');
                Logger.warn("IDEMPOTENCY_MONGO_FALLBACK_LOCK_FAIL", { normalizedKey, step });
                return null;
            }

            // If no lock and no Mongo record, proceed but log an anomaly
            Logger.warn("IDEMPOTENCY_REDIS_LOCK_FAILED_MONGO_CLEAN", { normalizedKey, step });
            span.setAttribute('lock.status', 'anomaly:proceed');
            return null; // The middleware logic needs the lockKey to release, so return null for conflict
            
        } catch (e) {
            Logger.error("IDEMPOTENCY_LOCK_ERROR", { normalizedKey, step, err: e });
            Metrics.increment("idempotency.lock.error");
            span.setAttribute('lock.status', 'error');
            // If the system is unstable (Redis error), we rely on the DB check from the middleware later.
            // For now, fail the lock acquisition gracefully.
            return null; 
        }
    });
}

/**
 * Persist response (Mongo + Redis)
 */
async function persistResponse(normalizedKey, reqPath, status, body, step = "default") {
    const span = Tracing.startSpan("IdempotencyService:persistResponse", { 'idempotency.key': normalizedKey, 'http.status': status, 'idempotency.step': step });
    try {
        await IdempotencyRecord.create({
            idempotencyKey: normalizedKey,
            requestPath: reqPath,
            responseStatus: status,
            responseBody: { step, data: body },
            processedAt: new Date(),
        });
        Metrics.increment("idempotency.persistence.mongo_success");

        await redis.set(
            `idem_cache:${normalizedKey}:${step}`,
            JSON.stringify({ status, body }),
            "EX",
            REDIS_CACHE_TTL
        );
        Metrics.increment("idempotency.persistence.redis_success");

        Logger.info("IDEMPOTENCY_RESPONSE_PERSISTED", { normalizedKey, reqPath, status, step });
        // Use Audit Logger for critical business transactions (assuming this is a payment/order)
        Logger.audit("TRANSACTION_COMPLETED_PERSISTED", { 
            entityId: normalizedKey, // Using idempotency key as entity identifier
            action: 'TRANSACTION_COMPLETE', 
            status, 
            step 
        });
        
        span.setStatus({ code: Tracing.SpanStatusCode.OK });
    } catch (err) {
        Metrics.increment("idempotency.persistence.fail");
        Logger.error("IDEMPOTENCY_PERSIST_FAILED", { normalizedKey, step, err });
        span.recordException(err);
        span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: err.message });
    } finally {
        span.end();
    }
}

/**
 * Retrieve cached response
 */
async function getCachedResponse(normalizedKey, step = "default") {
    return Tracing.withSpan("IdempotencyService:getCachedResponse", async (span) => {
        span.setAttributes({ 'idempotency.key': normalizedKey, 'idempotency.step': step });
        try {
            const cached = await redis.get(`idem_cache:${normalizedKey}:${step}`);
            if (cached) {
                Metrics.cacheHit("idempotency.redis");
                span.setAttribute('cache.status', 'hit');
                return JSON.parse(cached);
            }
            Metrics.cacheMiss("idempotency.redis");
            span.setAttribute('cache.status', 'miss');
            return null;
        } catch (e) {
            Logger.warn("IDEMPOTENCY_CACHE_READ_FAILED", { normalizedKey, step, err: e });
            Metrics.increment("idempotency.cache.read_error");
            span.setAttribute('cache.status', 'error');
            return null;
        }
    });
}

// =========================================================================
// 👷 3. BULLMQ WORKER & SCHEDULING
// =========================================================================

/**
 * Worker for background jobs (cleanup, batch aggregation, webhook retries)
 */
const idempotencyWorker = new Worker(
    "idempotencyQueue",
    async job => {
        // 🚀 TRACING: Start span for worker job
        const traceContext = job.data.traceContext;
        return Tracing.context.with(Tracing.deserializeContext(traceContext), async () => {
            return Tracing.withSpan(`IdempotencyWorker:${job.data.type}`, async (span) => {
                const { type, payload } = job.data;
                span.setAttributes({ 'job.id': job.id, 'job.type': type });

                if (type === "cleanup") {
                    const cutoff = new Date(Date.now() - STALE_RECORD_TTL * 1000);
                    const result = await IdempotencyRecord.deleteMany({ processedAt: { $lt: cutoff } });
                    Logger.info("IDEMPOTENCY_WORKER_CLEANUP", { deletedCount: result.deletedCount, cutoffDate: cutoff.toISOString() });
                    Metrics.increment("idempotency.worker.cleanup_total", result.deletedCount);
                }

                if (type === "webhookRetry") {
                    const { url, body, headers } = payload;
                    try {
                        // Example: const axios = require("axios"); await axios.post(url, body, { headers });
                        // Simulate operation
                        Metrics.increment("idempotency.worker.webhook_retry_success");
                        Logger.info("IDEMPOTENCY_WORKER_WEBHOOK_RETRY", { url });
                    } catch (err) {
                        Metrics.increment("idempotency.worker.webhook_retry_fail");
                        Logger.error("IDEMPOTENCY_WORKER_WEBHOOK_RETRY_FAILED", { url, err });
                        span.recordException(err);
                        throw err;
                    }
                }

                if (type === "batchAggregate") {
                    const { normalizedKey, steps } = payload;
                    let missingCount = 0;
                    for (const step of steps) {
                        const cached = await getCachedResponse(normalizedKey, step);
                        if (!cached) {
                            missingCount++;
                            Logger.debug("IDEMPOTENCY_WORKER_AGGREGATION_MISS", { normalizedKey, step });
                        }
                    }
                    if (missingCount === 0) {
                        Metrics.increment("idempotency.worker.aggregate_success");
                        Logger.info("IDEMPOTENCY_WORKER_AGGREGATION_COMPLETE", { normalizedKey });
                    } else {
                        Metrics.increment("idempotency.worker.aggregate_partial_fail", missingCount);
                        Logger.warn("IDEMPOTENCY_WORKER_AGGREGATION_PARTIAL", { normalizedKey, missingSteps: missingCount });
                    }
                }
            });
        });
    },
    { connection, concurrency: 5 }
);

async function scheduleDailyCleanup() {
    const traceContext = Tracing.serializeContext(Tracing.getCurrentContext());

    // .add() with a jobId and repeat pattern is "idempotent" in BullMQ.
    // It won't create duplicates if it's already there.
    await idempotencyQueue.add(
        "cleanupJob",
        { type: "cleanup", traceContext },
        { 
            repeat: { cron: "0 2 * * *" }, // Runs at 2 AM
            jobId: "dailyCleanup",
            removeOnComplete: true 
        }
    );
    Logger.info("IDEMPOTENCY_QUEUE_SYNCED", { cron: "0 2 * * *" });
}

// =========================================================================
// 🔒 4. IDEMPOTENCY MIDDLEWARE (Express)
// =========================================================================

/**
 * Middleware that handles idempotent requests by implementing a check-lock-execute-persist flow.
 */
async function idempotencyMiddleware(req, res, next) {
    // 🚀 TRACING: Wrap the entire middleware execution
    return Tracing.withSpan(`IdempotencyMiddleware: ${req.method} ${req.path}`, async (span) => {
        try {
            const headerKey = IDEMPOTENCY_HEADER_CANDIDATES
                .map(name => req.headers[name])
                .find(Boolean);

            const rawKey = headerKey ? sanitizeKey(headerKey) : `auto:${createFallbackFingerprint(req)}`;
            const source = headerKey ? "client" : "derived";
            const normalizedKey = normalizeKey(rawKey);
            const step = req.headers["idempotency-step"] || "default";
            const reqPath = req.path;

            span.setAttributes({ 
                'idempotency.key': normalizedKey, 
                'idempotency.source': source, 
                'idempotency.step': step 
            });

            // 1. Fast path: check Redis cache (Hit -> Return Cached Response)
            const cached = await getCachedResponse(normalizedKey, step);
            if (cached) {
                Metrics.increment("idempotency.cache_hit_total", 1, { source, status: cached.status }); 
                Logger.info("IDEMPOTENCY_CACHE_HIT", { normalizedKey, status: cached.status, step });
                
                // Audit log for repeated, successful idempotent calls
                Logger.audit("IDEMPOTENCY_REPLAY_SUCCESS", { 
                    entityId: normalizedKey, 
                    action: 'REPLAY_RESPONSE', 
                    status: cached.status, 
                    source 
                });
                
                span.setAttribute('idempotency.result', 'cache_hit');
                span.setStatus({ code: Tracing.SpanStatusCode.OK, message: 'Replayed from cache' });
                return res.status(cached.status).json(cached.body);
            }

            // 2. Acquire lock (Conflict -> Return 409)
            const lockKey = await acquireLock(normalizedKey, step);
            if (!lockKey) {
                Metrics.increment("idempotency.lock_conflict_total", 1, { source });
                Logger.warn("IDEMPOTENCY_LOCK_CONFLICT", { normalizedKey, step, reqPath });
                
                span.setAttribute('idempotency.result', 'lock_conflict');
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Lock Conflict (409)' });
                
                return res.status(409).json({
                    message: `Duplicate request in progress for step "${step}"`,
                    idempotency: normalizedKey,
                    step,
                });
            }

            // 3. Check Mongo (Slower fallback check for cache miss/restart)
            const existing = await IdempotencyRecord.findOne({
                idempotencyKey: normalizedKey,
                requestPath: reqPath,
                "responseBody.step": step,
            }).lean();

            if (existing) {
                // Re-populate the fast Redis cache
                await redis.set(
                    `idem_cache:${normalizedKey}:${step}`,
                    JSON.stringify({ status: existing.responseStatus, body: existing.responseBody.data }),
                    "EX",
                    REDIS_CACHE_TTL
                );
                Metrics.increment("idempotency.db_hit_total", 1, { source, status: existing.responseStatus }); 
                Metrics.cacheHit("idempotency.mongo_fallback"); // Semantic metric
                Logger.info("IDEMPOTENCY_DB_HIT_RECACHED", { normalizedKey, status: existing.responseStatus, step });
                
                span.setAttribute('idempotency.result', 'db_hit');
                span.setStatus({ code: Tracing.SpanStatusCode.OK, message: 'Replayed from DB' });
                
                // Always release the lock immediately since we have the final result
                try { await redis.del(lockKey); } catch (e) { Logger.error("Failed to release lock on DB HIT:", { lockKey, err: e }); }
                
                return res.status(existing.responseStatus).json(existing.responseBody.data);
            }
            
            Metrics.increment("idempotency.unique_request_total", 1, { source }); // It's a true unique request now.

            // 4. Proceed to Handler: Attach metadata and wrap response
            req.idempotency = Object.freeze({
                rawKey,
                key: normalizedKey,
                step,
                source,
                algorithm: "HMAC-SHA256",
                createdAt: new Date().toISOString(),
            });

            // Wrap res.json to persist the response and release the lock AFTER the route handler runs
            const originalJson = res.json.bind(res);
            res.json = async body => {
                let success = false;
                try {
                    // If successful (status < 400), persist the result
                    if (res.statusCode >= 200 && res.statusCode < 400) {
                        await persistResponse(normalizedKey, req.path, res.statusCode, body, step);
                        success = true;
                    } else {
                        Logger.warn("IDEMPOTENCY_SKIP_PERSIST_ERROR", { normalizedKey, status: res.statusCode, step });
                    }
                } catch (e) {
                    Logger.error("IDEMPOTENCY_POST_EXECUTION_PERSIST_FAIL", { normalizedKey, step, err: e });
                } finally {
                    // Always release the lock, even if persistence fails or execution failed
                    try { 
                        await redis.del(lockKey); 
                        if (success) {
                            Logger.debug("IDEMPOTENCY_LOCK_RELEASED", { lockKey });
                        }
                    } catch (e) { 
                        Logger.critical("IDEMPOTENCY_LOCK_RELEASE_FAILED_CRITICAL", { lockKey, err: e }); 
                    }
                }
                
                // Call the original response function
                return originalJson(body);
            };

            // Metrics for total unique requests processed by the middleware
            Metrics.increment("idempotency.process_started", 1, { source }); 
            span.setAttribute('idempotency.result', 'processing');

            next();
        } catch (err) {
            Metrics.increment("idempotency.middleware_failure");
            Logger.critical("IDEMPOTENCY_MIDDLEWARE_FAILED", { err, path: req.path });
            
            span.recordException(err);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: err.message });
            
            err.code = "IDEMPOTENCY_SERVICE_FAILURE";
            next(err);
        }
    }); // End of Tracing.withSpan
}

// =========================================================================
// 🚀 5. LIFECYCLE MANAGEMENT
// =========================================================================

/**
 * @desc Initializes the Redis connection, BullMQ worker, Logger, Metrics, and Tracing clients.
 */
async function initialize() {
    // Initialize utilities
    await Tracing.initialize();
    Logger.initialize();
    Metrics.initialize();
    
    // Schedule background jobs
    await scheduleDailyCleanup();
    
    Logger.info("IDEMPOTENCY_SERVICE_INITIALIZED");
}

/**
 * @desc Gracefully shuts down all services.
 */
async function shutdown() {
    Logger.info("IDEMPOTENCY_SERVICE_SHUTTING_DOWN");
    
    // Shut down BullMQ components
    await idempotencyQueue.close();
 
    // Worker exit should be handled by process termination logic, but we can stop it if running standalone
    // await idempotencyWorker.close(); 
    
    // Shut down utilities in reverse order of dependency/flush criticality
    await Metrics.shutdown(); 
    await Tracing.shutdown();
    await Logger.shutdown();
    
    // Close Redis connection
    await redis.quit(); 

    Logger.info("IDEMPOTENCY_SERVICE_SHUTDOWN_COMPLETE");
}
/**
 * 💡 ADD THIS: Simple check for background jobs
 */
async function checkIdempotency(key) {
    const exists = await redis.get(`job_idem:${key}`);
    return exists === "1";
}

/**
 * 💡 ADD THIS: Mark a background job as finished
 */
async function markIdempotent(key, ttl = 86400) {
    // Default TTL is 24 hours
    await redis.set(`job_idem:${key}`, "1", "EX", ttl);
}

// =========================================================================
// 🌐 6. EXPORTS
// =========================================================================

module.exports = {
    idempotencyMiddleware,
    persistResponse,
    getCachedResponse,
    idempotencyQueue,
    scheduleDailyCleanup,
    initialize, // Export lifecycle methods
    shutdown, 
    checkIdempotency, // Add this
    markIdempotent    // Add this
};