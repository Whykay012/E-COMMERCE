// services/logPersistenceClient.js (HYPER-SECURE NEXUS ZENITH - DEAD LETTER QUEUE)
// Implements durable, transactional local storage for audit logs that fail 
// to reach the primary queue, with an automatic reconciliation mechanism.

const mongoose = require('mongoose');
const AuditLogger = require('./auditLogger'); // Used internally for logging DLQ events
// 🚀 TELEMETRY UTILITIES INTEGRATION
const Tracing = require('../utils/tracingClient'); 
const Metrics = require('../utils/metricsClient'); 
const Logger = require('../utils/logger'); // Used for general info/error logging

// --- Configuration ---
const DLQ_COLLECTION_NAME = 'AuditDeadLetterQueue';
const RECONCILIATION_INTERVAL_MS = 60000; // Attempt to re-send DLQ items every 1 minute
const MAX_RETRIES = 5; // Maximum attempts before marking an item as permanently failed
const BATCH_SIZE = 100; // Number of items to attempt reconciliation per cycle

// --- Dependencies (Assumed to exist in the same services folder) ---
const queueClient = require('./logQueueClient'); // Needed to re-send to primary queue

// --- DLQ Schema (MongoDB) ---
const dlqSchema = new mongoose.Schema({
    log: { type: Object, required: true }, // The original failed structured log
    primary_error: { type: Object, required: true }, // Details of the failure
    attempt_time: { type: Date, required: true, default: Date.now },
    retryCount: { type: Number, default: 0 },
    lastRetryAt: { type: Date },
    status: { type: String, enum: ['PENDING', 'RETRYING', 'FAILED'], default: 'PENDING' },
}, { timestamps: true });

// Ensure fast lookup on status for reconciliation
dlqSchema.index({ status: 1, lastRetryAt: 1 });

const DLQModel = mongoose.models.DLQ || mongoose.model('DLQ', dlqSchema, DLQ_COLLECTION_NAME);

// --- Internal State ---
let reconciliationTimer = null;


// =================================================================================
// 🛡️ RECONCILIATION PROCESS (Self-Healing)
// =================================================================================

/**
 * @desc Attempts to re-send failed logs from the DLQ back to the primary queue.
 */
const runReconciliation = async () => {
    // Wrap the entire reconciliation cycle in a span
    return Tracing.withSpan("DLQ:runReconciliationCycle", async (span) => {
        let logsProcessed = 0;
        let logsSuccess = 0;
        let logsFailed = 0;

        try {
            // 1. Find PENDING logs eligible for retry (status=PENDING or RETRYING and not recently attempted)
            const logsToRetry = await DLQModel.find({
                status: { $in: ['PENDING', 'RETRYING'] },
                $or: [
                    { lastRetryAt: { $exists: false } },
                    { lastRetryAt: { $lt: new Date(Date.now() - RECONCILIATION_INTERVAL_MS) } }
                ],
                retryCount: { $lt: MAX_RETRIES }
            })
            .sort({ attempt_time: 1 }) // Prioritize older failures
            .limit(BATCH_SIZE)
            .lean();
            
            logsProcessed = logsToRetry.length;
            span.setAttribute('dlq.batch_size', logsProcessed);
            Metrics.gauge("dlq.reconciliation.pending_count", logsProcessed);

            if (logsProcessed === 0) {
                Logger.debug(`[DLQ RECONCILIATION] No items to retry.`);
                return;
            }

            Logger.info(`[DLQ RECONCILIATION] Starting cycle. Found ${logsProcessed} items to retry.`, { batchSize: logsProcessed });

            // 2. Process logs in parallel
            const reconciliationPromises = logsToRetry.map(async (dlqItem) => {
                // Create a sub-span for each item retry attempt
                return Tracing.withSpan("DLQ:retryLogItem", async (itemSpan) => {
                    const logId = dlqItem.log.logId || dlqItem._id.toString();
                    itemSpan.setAttribute('dlq.log_id', logId);

                    try {
                        // Re-send to the primary queue using the original log payload
                        await queueClient.send(process.env.AUDIT_LOG_TOPIC, dlqItem.log);
                        
                        // Success: Delete the item from the DLQ
                        await DLQModel.deleteOne({ _id: dlqItem._id });
                        
                        // Internal Audit
                        Logger.info(`[DLQ RECONCILED] Log ${logId} successfully re-sent and removed from DLQ.`, { dlqId: dlqItem._id });
                        Metrics.increment("dlq.reconciliation.success");
                        logsSuccess++;
                        
                    } catch (retryError) {
                        // Failure during retry: Update the item's status and retry count
                        const newRetryCount = dlqItem.retryCount + 1;
                        let newStatus = 'RETRYING';
                        
                        itemSpan.setAttribute('dlq.retry_count', newRetryCount);
                        itemSpan.recordException(retryError);
                        
                        if (newRetryCount >= MAX_RETRIES) {
                            newStatus = 'FAILED';
                            
                            // 💡 CRITICAL: Log a fatal event for manual intervention using the dedicated AuditLogger
                            AuditLogger.log({
                                level: 'FATAL',
                                event: 'DLQ_PERMANENT_FAILURE',
                                userId: dlqItem.log.userId || 'N/A',
                                details: { 
                                    dlqId: dlqItem._id.toString(),
                                    event: dlqItem.log.event,
                                    finalError: retryError.message,
                                    // Inject current trace context into the FATAL log
                                    trace: Tracing.getCurrentContext()
                                }
                            });
                            Metrics.increment("dlq.reconciliation.permanent_failure");

                            itemSpan.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Permanent Max Retry Failure' });
                            Logger.error(`[DLQ PERMANENT FAILURE] Log ${logId} reached max retries (${MAX_RETRIES}).`, { dlqId: dlqItem._id, error: retryError.message });
                        } else {
                            Metrics.increment("dlq.reconciliation.retry_failure");
                        }
                        
                        await DLQModel.updateOne(
                            { _id: dlqItem._id },
                            { 
                                $set: { 
                                    retryCount: newRetryCount, 
                                    lastRetryAt: new Date(),
                                    status: newStatus
                                } 
                            }
                        );
                        logsFailed++;
                    }
                });
            });
            
            await Promise.allSettled(reconciliationPromises);
            
            // Internal Audit
            Logger.debug(`[DLQ RECONCILIATION] Attempted batch of ${logsProcessed}. Successes: ${logsSuccess}, Failures: ${logsFailed}.`);
            Metrics.timing("dlq.reconciliation.batch_duration", span.duration); // Assuming span.duration is available from withSpan
            Metrics.increment("dlq.reconciliation.cycle_complete");

        } catch (globalError) {
            Logger.critical(`[DLQ CRITICAL ERROR] Failed to run reconciliation cycle: ${globalError.message}`, { error: globalError, stack: globalError.stack });
            Metrics.increment("dlq.reconciliation.cycle_error");
            span.recordException(globalError);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Reconciliation Cycle Failed' });
        }
    });
};


// =================================================================================
// 💾 CLIENT METHODS
// =================================================================================

/**
 * @desc Saves a failed log entry to the DLQ collection (Write operation).
 * @param {string} topic - The target topic (DLQ_TOPIC).
 * @param {object} logFailureDetails - The log and failure context.
 */
const send = async (topic, logFailureDetails) => {
    return Tracing.withSpan("DLQ:sendFailureLog", async (span) => {
        span.setAttribute('log.topic', topic);
        span.setAttribute('log.event', logFailureDetails.log.event);

        if (!mongoose.connection.readyState) {
            Metrics.increment("dlq.send.fail.db_connection_lost");
            // If MongoDB connection is lost, fail hard to trigger secondary audit logging
            const error = new Error("MongoDB connection lost. Cannot persist to DLQ.");
            span.recordException(error);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: error.message });
            throw error;
        }
        
        try {
            // Save the failed log to the DLQ
            const dlqEntry = new DLQModel(logFailureDetails);
            await dlqEntry.save();
            Metrics.increment("dlq.send.success");

            // 🔑 AUDIT LOG: Critical record of a failed audit log being persisted to the DLQ
            Logger.audit("DLQ_PERSIST_SUCCESS", {
                entityId: dlqEntry._id.toString(),
                action: 'PERSIST_FAILED_LOG',
                originalLogId: dlqEntry.log.logId,
                primaryError: dlqEntry.primary_error.message
            });

        } catch (error) {
            Metrics.increment("dlq.send.fail.db_write");
            Logger.error(`Failed to persist log to DLQ.`, { logEvent: logFailureDetails.log.event, error: error.message });
            span.recordException(error);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'DB Write Failure' });
            throw error; // Re-throw for upstream handling
        }
    });
};

/**
 * @desc Initializes the persistence layer (starts MongoDB connection and reconciliation).
 */
const initialize = async () => {
    if (mongoose.connection.readyState === 0) {
        Logger.warn("DLQ_INIT_WARNING", { reason: "MongoDB connection not active. DLQ cannot start." });
        return;
    }
    
    // Start the reconciliation timer only if it's not already running
    if (!reconciliationTimer) {
        reconciliationTimer = setInterval(runReconciliation, RECONCILIATION_INTERVAL_MS);
        reconciliationTimer.unref(); // Allows the process to exit if this is the only timer running
        
        Logger.info(`[DLQ CLIENT] Initialized and started reconciliation timer.`, { interval: RECONCILIATION_INTERVAL_MS });
        Metrics.increment("dlq.lifecycle.initialized");

        // Run once immediately on startup for any existing pending items
        await runReconciliation();
    }
};

/**
 * @desc Stops the reconciliation process gracefully.
 */
const shutdown = () => {
    if (reconciliationTimer) {
        clearInterval(reconciliationTimer);
        reconciliationTimer = null;
        Logger.info("[DLQ CLIENT] Reconciliation timer stopped gracefully.");
        Metrics.increment("dlq.lifecycle.shutdown");
    }
};


module.exports = {
    send,
    initialize,
    shutdown,
    // Expose the model for external administrative DLQ viewing/management
    DLQModel,
};