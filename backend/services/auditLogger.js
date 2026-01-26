// services/auditLogger.js (APOLLO ASCENDANT: Facade, Telemetry-Driven, Read/Write Resilient)

// --- External Dependencies ---
const queueClient = require('./logQueueClient'); 
const localPersistence = require('./logPersistenceClient'); // For the DLQ/Internal Queue
const logQueryClient = require('./logQueryClient'); 
const Metrics = require('../utils/metricsClient'); // 💡 UPGRADE: Telemetry
const Tracing = require('../utils/tracingClient'); // 🚀 CRITICAL: Import Tracing for context propagation
const Logger = require('../utils/logger'); // 🚀 CRITICAL: Import the ULTIMATE PINO LOGGER for reporting
const { InternalServerError } = require('../errors/custom-errors'); // Assuming custom errors are available
const { v4: uuidv4 } = require('uuid'); 
const { context, trace } = require('@opentelemetry/api'); // 💡 Explicitly import OTel context for propagation

// --- Configuration & Filtering ---
const SERVICE_NAME = process.env.SERVICE_NAME || 'UNKNOWN_SERVICE'; 
const LOG_TOPIC = process.env.AUDIT_LOG_TOPIC || 'AUDIT_LOGS_STREAM'; 
const DLQ_TOPIC = process.env.DLQ_LOG_TOPIC || 'DLQ_LOGS_INTERNAL'; 
const AUDIT_FACADE_VERSION = '1.3.0'; 
const MIN_LOG_LEVEL = process.env.MIN_AUDIT_LOG_LEVEL || 'INFO';

const LOG_LEVEL_MAP = {
    'DEBUG': 1,
    'INFO': 2,
    'WARN': 3,
    'ERROR': 4,
    'FATAL': 5
};
const SENSITIVE_KEYS = ['password', 'secret', 'token', 'auth', 'creditcard', 'cvv', 'pii', 'ssn']; // Added for context

// =================================================================================
// 🛡️ SECURITY & DATA INTEGRITY UTILITIES
// =================================================================================

const sanitizeDetails = (data) => {
    // ... (logic remains the same: deep clean sensitive keys) ...
    if (typeof data !== 'object' || data === null) {
        return data;
    }

    if (Array.isArray(data)) {
        return data.map(sanitizeDetails);
    }

    const sanitized = {};
    for (const key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;

        const lowerKey = key.toLowerCase();
        if (SENSITIVE_KEYS.some(sensitiveKey => lowerKey.includes(sensitiveKey))) {
            sanitized[key] = '[MASKED_SENSITIVE_DATA]';
        } else if (typeof data[key] === 'object' && data[key] !== null) {
            sanitized[key] = sanitizeDetails(data[key]);
        } else {
            sanitized[key] = data[key];
        }
    }
    return sanitized;
};

const validatePayload = (payload) => {
    // ... (logic remains the same) ...
    if (!payload || typeof payload !== 'object' || !payload.level || !payload.event) {
        Logger.error('AUDIT_PAYLOAD_CONTRACT_FAIL', { receivedType: typeof payload, requiredFields: ['level', 'event'] });
        throw new Error(`Audit log payload must be an object and contain level and event fields.`);
    }
    
    const validLevels = Object.keys(LOG_LEVEL_MAP);
    if (!validLevels.includes(payload.level)) {
        Logger.warn('AUDIT_PAYLOAD_UNRECOGNIZED_LEVEL', { receivedLevel: payload.level, action: 'Defaulting to WARN' });
        payload.level = 'WARN';
    }

    // Use MIN_LOG_LEVEL constant
    if (LOG_LEVEL_MAP[payload.level] < LOG_LEVEL_MAP[MIN_LOG_LEVEL]) {
        Metrics.increment(`audit.log.filtered_out.${payload.level}`);
        return false; 
    }
    
    if (typeof payload.event !== 'string' || !/^[A-Z0-9_]+$/.test(payload.event)) {
        Logger.error('AUDIT_EVENT_NAME_FORMAT_FAIL', { eventName: payload.event, requiredFormat: 'UPPERCASE_SNAKE_CASE' });
        throw new Error(`Event name '${payload.event}' must be a string in uppercase snake_case.`);
    }

    return true;
};

// =================================================================================
// 🚀 DISPATCHER CORE (WRITE) - Optimized for Efficiency and Telemetry
// =================================================================================

/**
 * @desc Dispatches a structured audit log event to the centralized logging sink (non-blocking).
 */
const dispatchLog = (payload) => {
    // 💡 TRACING: Get current context *before* moving to next tick (CRITICAL for async fire-and-forget)
    const activeContext = context.active();

    setImmediate(async () => {
        // 💡 TRACING: Restore context inside the async scope for propagation
        context.with(activeContext, async () => {
            
            // 🚀 UPGRADE: Wrap the entire dispatch logic in a span
            return Tracing.withSpan(`AuditLogger.dispatch:${payload.event || 'UNKNOWN'}`, async (span) => {
                let structuredLog;

                // 💡 ATTRIBUTE ENRICHMENT (early for visibility)
                span.setAttributes({
                    'audit.event': payload.event,
                    'audit.level': payload.level,
                    'user.id': payload.userId || payload.details?.userId,
                });
                
                try {
                    const startTime = process.hrtime.bigint();
                    
                    // 1. Validate payload and check log level filter
                    if (!validatePayload(payload)) {
                        span.end(); // End span if filtered
                        return; 
                    }
                    
                    // 2. 🛡️ SECURITY: Sanitize sensitive data
                    const sanitizedDetails = sanitizeDetails(payload.details);

                    // 3. Add system context and unique ID
                    const currentTracingContext = Tracing.getCurrentContext();
                    structuredLog = {
                        logId: uuidv4(), 
                        ...payload,
                        details: sanitizedDetails, 
                        timestamp: new Date().toISOString(),
                        service: SERVICE_NAME,
                        environment: process.env.NODE_ENV || 'development',
                        // 🚀 UPGRADE: Auto-enrich trace ID from the restored active span
                        traceId: currentTracingContext.traceId,
                        spanId: currentTracingContext.spanId, 
                        userId: payload.userId || payload.details?.userId || null, 
                    };

                    // 4. Attempt to send the log to the Primary Queue (Kafka)
                    await Tracing.withSpan('AuditLogger.sendToQueue', async () => {
                        await queueClient.send(LOG_TOPIC, structuredLog);
                    });
                    
                    // 5. 💡 UPGRADE: Metrics and Telemetry
                    const duration = Number(process.hrtime.bigint() - startTime) / 1000000;
                    Metrics.increment(`audit.log.dispatched.success.${structuredLog.level}`);
                    Metrics.timing('audit.log.dispatch_latency_ms', duration);
                    
                    if (LOG_LEVEL_MAP[structuredLog.level] >= LOG_LEVEL_MAP['DEBUG']) {
                        Logger.debug('AUDIT_DISPATCHED_CONFIRMED', { logId: structuredLog.logId, level: structuredLog.level, event: structuredLog.event });
                    }

                } catch (primaryError) {
                    Metrics.increment('audit.log.dispatched.fail_primary');
                    
                    // 5. DLQ/Persistence Fallback Logic 
                    const logToPersist = structuredLog || payload; 
                    const currentTracingContext = Tracing.getCurrentContext(); // Re-get context for DLQ log
                    const logFailureDetails = {
                        log: logToPersist, 
                        primary_error: {
                            message: primaryError.message,
                            stack: primaryError.stack,
                            name: primaryError.name,
                        },
                        attempt_time: new Date().toISOString(),
                        DLQ_context: { 
                            service: SERVICE_NAME, 
                            version: AUDIT_FACADE_VERSION, 
                            traceId: currentTracingContext.traceId 
                        }
                    };

                    try {
                        // Attempt to send the failed log to the Internal/DLQ persistence mechanism
                        await Tracing.withSpan('AuditLogger.sendToDLQ', async () => {
                            await localPersistence.send(DLQ_TOPIC, logFailureDetails); 
                        });
                        
                        Metrics.increment('audit.log.dispatched.dlq_recovery');
                        
                        // 🚀 UPGRADE: Use the structured Logger's `warn` for recovery confirmation
                        Logger.warn(
                            'AUDIT_FAILURE_RECOVERED', 
                            { 
                                event: logToPersist.event || 'UNKNOWN', 
                                dlqTopic: DLQ_TOPIC,
                                primaryError: primaryError.message.substring(0, 100), 
                                err: primaryError 
                            }
                        );

                    } catch (secondaryError) {
                        // 6. CRITICAL FAILURE: Both primary and DLQ failed. Log is lost.
                        Metrics.increment('audit.log.dispatched.fatal_loss');
                        
                        // 🛑 TRACING: Record the fatal error on the span
                        span.recordException(secondaryError);
                        span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Fatal double failure: Log Lost.' });

                        // 🚀 UPGRADE: Use the structured Logger's `critical` for fatal loss
                        Logger.critical(
                            'FATAL_AUDIT_ERROR_DOUBLE_FAILURE', 
                            { 
                                event: logToPersist.event || 'UNKNOWN', 
                                primaryError: primaryError.message, 
                                secondaryError: secondaryError.message,
                                err: secondaryError
                            }
                        );
                    }
                }
            }); // End Tracing.withSpan
        }); // End context.with
    }); // End setImmediate
};

// =================================================================================
// 🔎 QUERY INTERFACE (READ)
// =================================================================================

/**
 * @desc Queries the final persistent log store for events by user/event type.
 */
const getActivitiesByUser = async (userId, eventType, options = {}) => {
    
    // 🚀 UPGRADE: Wrap the entire read operation in a span.
    return Tracing.withSpan('AuditLogger.getActivitiesByUser', async (span) => {
        const { limit = 50, startDate, endDate, sort = 'timestamp_desc', actorId } = options;
        
        span.setAttributes({
             'audit.query.userId': userId,
             'audit.query.event': eventType,
             'audit.query.limit': limit,
             'audit.query.actorId': actorId || 'N/A'
        });

        if (!logQueryClient || !logQueryClient.query) {
            Logger.error("AUDIT_READ_INTERFACE_UNAVAILABLE");
            throw new InternalServerError("Audit log read interface is unavailable.");
        }

        try {
            Metrics.increment('audit.log.read_query_attempt');
            const queryStartTime = process.hrtime.bigint();

            const queryParams = {
                userId: userId,
                event: eventType,
                limit: limit,
                sort: sort,
                actorId: actorId,
                startDate: startDate ? startDate.toISOString() : undefined,
                endDate: endDate ? endDate.toISOString() : undefined,
                service: SERVICE_NAME,
            };
            
            const results = await Tracing.withSpan('AuditLogQueryClient.query', async () => {
                return logQueryClient.query(queryParams);
            });

            const duration = Number(process.hrtime.bigint() - queryStartTime) / 1000000;
            Metrics.timing('audit.log.read_query_latency_ms', duration);
            Metrics.increment('audit.log.read_query_success');
            
            span.setAttribute('audit.query.results_count', results.length);

            return results;

        } catch (error) {
            Metrics.increment('audit.log.read_query_fail');
            
            // 🛑 TRACING: Record the failure
            span.recordException(error);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Query Failed' });
            
            // 🚀 UPGRADE: Use the structured Logger's `error`
            Logger.error('AUDIT_LOG_READ_QUERY_FAIL', { userId, eventType, err: error });
            throw new InternalServerError(`Audit log read failed: ${error.message}`);
        }
    });
};


// =================================================================================
// 💡 FACADE EXPORTS (The single public contract)
// =================================================================================
const AuditLogger = {
    // Primary Write Interface
    dispatchLog,
    log: dispatchLog, 
    
    // Primary Read Interface
    getActivitiesByUser, 
    
    // Telemetry and Configuration Access
    getFacadeVersion: () => AUDIT_FACADE_VERSION,
    getLogLevels: () => LOG_LEVEL_MAP,
    
    // Initialization and Shutdown Handlers
    initialize: async () => {
        Logger.info('AUDIT_FACADE_INITIALIZING', { version: AUDIT_FACADE_VERSION });
        await queueClient.initialize();
        await localPersistence.initialize();
        if (logQueryClient?.initialize) await logQueryClient.initialize();
        Logger.info('AUDIT_FACADE_INITIALIZED');
    },
    shutdown: async () => {
        Logger.info('AUDIT_FACADE_SHUTTING_DOWN', { version: AUDIT_FACADE_VERSION });
        await queueClient.shutdown();
        await localPersistence.shutdown();
        if (logQueryClient?.shutdown) await logQueryClient.shutdown();
        Logger.info('AUDIT_FACADE_SHUTDOWN_COMPLETE');
    }
};

module.exports = AuditLogger;