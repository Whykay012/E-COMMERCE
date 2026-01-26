// utils/logger.js (ULTIMATE PINO LOGGER: Asynchronous Batching Transport & Contract Enforcement)

// --- Core Dependencies ---
const Pino = require('pino');
const Tracing = require('./tracingClient'); // Assuming this is implemented
const { Worker, isMainThread } = require('worker_threads');
const path = require('path');
const EventEmitter = require('events');

// --- Configuration ---
const config = {
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    SERVICE_NAME: process.env.SERVICE_NAME || 'recommendation-gateway',
    LOG_SAMPLING_RATE: parseFloat(process.env.LOG_SAMPLING_RATE || '1.0'),
    SHUTDOWN_GRACE_PERIOD_MS: 5000, // Increased grace period
    LOG_WORKER_PATH: path.join(__dirname, 'loggerWorker.js'),
};

// --- Worker/Transport Setup ---
let logWorker = null;
const transportEmitter = new EventEmitter();

// Tracks logs for observability (optional, can be integrated with a metrics client like Prometheus)
const logStats = {
    processed: 0,
    dropped: 0
};

// =================================================================================
// 👑 MAIN THREAD LOGGING INTERFACE (Pino Configuration)
// =================================================================================

// 💡 Custom stream that pipes Pino output (serialized JSON) to the worker thread
const workerStream = {
    write: (logLine) => {
        if (logWorker) {
            logWorker.postMessage(logLine);
            logStats.processed++;
        } else {
            // Fallback to synchronous console logging
            console.warn(`[WORKER_FAIL] Log processed synchronously (Worker offline): ${logLine.trim()}`);
            logStats.dropped++; // Count as dropped from async pipeline, but written synchronously
        }
    }
};

/**
* Advanced Error Serializer (for better structured logging)
* @param {Error|Object} err - The error object to serialize.
* @returns {Object} Structured error details.
*/
const errorSerializer = (err) => {
    if (err instanceof Error) {
        return {
            name: err.name,
            message: err.message,
            stack: err.stack,
            code: err.code,
            data: err.data || err.context || undefined // Use undefined if no extra data
        };
    }
    // Return original if not a standard Error object
    return err;
};

// --- Logger Instance ---
const baseLogger = Pino({
    level: config.LOG_LEVEL,
    base: {
        service: config.SERVICE_NAME,
        environment: process.env.NODE_ENV,
        // 👇 MODIFICATION: Activate these keys in the base structure
        traceId: undefined, 
        spanId: undefined 
        // Note: The actual values will be populated *per log* in enrichContext, 
        // but adding them here ensures the fields exist in all logs.
    },
    serializers: {
        err: errorSerializer,
        error: errorSerializer
    },
    timestamp: Pino.stdTimeFunctions.isoTime,
    formatters: {
        // Use standard "level" key but map to cloud-standard "severity" value
        level: (label) => ({ severity: label.toUpperCase() }),
    },
    messageKey: 'message',
    // Advanced: Use a dedicated 'traceId' key in case 'context' keys are reserved
    // base: { traceId: undefined, spanId: undefined, ... } // The line is now activated above
}, workerStream);

// --- Core Logging Logic ---

const enrichContext = (data) => {
    // Note: If Pino is configured to re-read the 'base' fields via a custom function, 
    // we would put Tracing.getCurrentContext() here. Since we are using Pino's base 
    // *template*, we keep the logic here in the `enrichContext` function, which is 
    // called for *every* log, ensuring the current trace context is captured.
    const tracingContext = Tracing.getCurrentContext();
    return {
        ...data,
        // 🔑 Integrate distributed tracing context (Crucial for microservices)
        traceId: tracingContext.traceId,
        spanId: tracingContext.spanId,
        serviceVersion: process.env.GIT_COMMIT_SHA || 'N/A'
    };
};

const shouldLog = (level) => {
    // High-severity, security, and audit events bypass sampling
    if (baseLogger.levels.values[level] >= baseLogger.levels.values.warn) return true;
    if (config.LOG_SAMPLING_RATE >= 1.0) return true;
    
    // Apply sampling for info/debug
    return Math.random() < config.LOG_SAMPLING_RATE;
};

/**
* Primary logging function with context enrichment and sampling.
* @param {('info'|'warn'|'error'|'fatal')} level - The log level.
* @param {string} message - The main log message.
* @param {Object} [data={}] - Additional structured data.
*/
const log = (level, message, data = {}) => {
    // Fast path: Pino's internal level check
    if (!baseLogger.isLevelEnabled(level) || !shouldLog(level)) {
        logStats.dropped++;
        return;
    }
    
    const finalData = enrichContext(data);
    
    // Check for explicit error object in data
    if (data.err && data.err instanceof Error) {
        // The serializer will pick this up on Pino's internal call
        finalData.err = data.err;
    }

    baseLogger[level](finalData, message);
};

// =================================================================================
// 💡 MODULE EXPORTS: Custom, Semantic Loggers & Lifecycle
// =================================================================================

module.exports = {
    // Semantic logging wrappers (enforces level contract)
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
    critical: (message, data) => log('fatal', message, data),
    
    /**
  * @desc Contract-enforced log for Security Events. Requires userId and eventCode.
  * @param {string} message - Description of the security event.
  * @param {{userId: (string|number), eventCode: string, [key: string]: any}} data - Required context.
  */
    security: (message, data) => {
        if (!data || !data.userId || !data.eventCode) {
             // 🚨 Contract Violation: Log immediate fatal error synchronously
             baseLogger.fatal({ ...data, message: 'SECURITY_CONTRACT_FAILED' }, `Security log missing required fields: ${message}`);
             return;
        }
        // Log at 'warn' level to ensure high visibility and bypass sampling
        log('warn', `SECURITY_EVENT: ${message}`, data);
    },
    
    /**
  * @desc Contract-enforced log for Audit Trails. Requires entityId and action.
  * @param {string} message - Description of the audit event.
  * @param {{entityId: (string|number), action: string, [key: string]: any}} data - Required context.
  */
    audit: (message, data) => {
        if (!data || !data.entityId || !data.action) {
             baseLogger.fatal({ ...data, message: 'AUDIT_CONTRACT_FAILED' }, `Audit log missing required fields: ${message}`);
             return;
        }
        // Log at 'info' level, but could be 'warn' depending on security requirements
        log('info', `AUDIT_LOG: ${message}`, data);
    },
    
    /**
  * @desc Initializes the worker thread for decoupled log transport.
  */
    initialize: () => {
        if (isMainThread) {
            logWorker = new Worker(config.LOG_WORKER_PATH, {
                 workerData: { logLevel: config.LOG_LEVEL, serviceName: config.SERVICE_NAME }
            });
            
            // Worker-to-Main Thread Communication
            logWorker.on('message', (msg) => {
                if (msg.type === 'flushed') {
                    transportEmitter.emit('flushed', msg.count);
                } else if (msg.type === 'error') {
                    // Receive error reports from the worker (e.g., failed transport attempt)
                    console.error(`[WORKER_REPORT] Transport Error: ${msg.message}`, msg.details);
                }
            });
            
            logWorker.on('error', (err) => {
                console.error(`[WORKER_CRASH] Logger worker thread failed: ${err.message}. Logging is now synchronous.`);
                logWorker = null; // Disable the worker
            });
            logWorker.on('exit', (code) => {
                 if (code !== 0) {
                     console.error(`[WORKER_EXIT] Logger worker exited with code ${code}.`);
                 }
                 logWorker = null;
            });
        }
        module.exports.info('LOGGER_INITIALIZED_WORKER', { level: config.LOG_LEVEL, samplingRate: config.LOG_SAMPLING_RATE, transport: 'WorkerThread' });
    },
    
    /**
  * @desc Gracefully shuts down the logger, ensuring all buffered logs are flushed.
  * @returns {Promise<void>} Resolves when shutdown is complete or timeout is reached.
  */
    shutdown: async () => {
        if (!logWorker) {
            module.exports.info('LOGGER_SHUTDOWN_SYNC');
            return;
        }

        // 1. Send the flush signal to the worker
        logWorker.postMessage('FLUSH_REQUEST');
        
        // 2. Wait for the 'flushed' confirmation or timeout
        const flushPromise = new Promise(resolve => {
            const timeoutId = setTimeout(() => {
                console.warn(`[LOGGER_SHUTDOWN] Flush timeout of ${config.SHUTDOWN_GRACE_PERIOD_MS}ms reached. Forcing termination.`);
                resolve();
            }, config.SHUTDOWN_GRACE_PERIOD_MS);

            transportEmitter.once('flushed', (count) => {
                clearTimeout(timeoutId);
                console.info(`[LOGGER_SHUTDOWN] Worker flushed ${count} logs.`);
                resolve();
            });
            timeoutId.unref(); // Allow the event loop to exit if only timeout is pending
        });
        
        await flushPromise;
        
        // 3. Terminate the worker thread
        await logWorker.terminate();
        module.exports.info('LOGGER_SHUTDOWN_COMPLETE_ASYNC', { processed: logStats.processed, dropped: logStats.dropped });
    }
};