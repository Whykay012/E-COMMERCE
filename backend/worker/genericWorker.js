// workers/jobRouterWorker.js
// OMEGA WORKER ARCHITECTURE - Centralized Job Router (Compliance, Payments, & Security)
require("dotenv").config();

const { Worker, QueueScheduler } = require("bullmq");
const logger = require("../config/logger");
const { queueJob, GENERAL_QUEUE_NAME } = require("../queues/jobQueue"); 
const AuditLogger = require("../services/auditLogger"); 
const zod = require('zod'); 
const { v4: uuidv4 } = require('uuid'); 

// --- Config, Redis, and DB Clients (REQUIRED for worker functions) ---
const config = require("../config"); 
const connectDB = require("../config/connect"); 
const mongoose = require('mongoose'); 

const { 
  connectRedis, 
  disconnectRedis, 
  initializeRedlock, 
  startDeadLetterWorker 
} = require("../utils/redisClient"); 
const { getRedisConnectionDetails } = require("../config/redisConnection"); 

// --- Configuration & Env validation ---
const REDIS_CONFIG = {
  ...getRedisConnectionDetails(),
  maxRetriesPerRequest: null, 
  enableReadyCheck: false,
};

// --- Model/Util Imports ---
const Payment = require("../model/payment");
const Order = require("../model/order");
const Notification = require("../model/notification");
const UserModel = require("../model/userModel");
const ComplianceOutbox = require('../services/complianceOutbox'); 
const Outbox = require('../model/outboxModel'); // Added for Security Outbox

// Note: Ensure these utility paths are correct:
const preventReplay = require("../utils/webhookReplayProtector");
const { hardDeleteOldSoftDeleted, destroyCloudinaryMedia } = require("../controller/productController");
const { markOrderAsProcessing } = require("../service/orderAutomationService");

// --- NEW CRITICAL IMPORTS ---
const { executeAtomicOrderUpdate } = require('../services/paymentService'); 
const { checkTokenExpiry } = require('../services/paymentMethodService'); 
const identityService = require('../services/identityService'); // Added for session revocation
const { NotFoundError, ConflictError, DomainError } = require("../errors/customErrors"); 
// ----------------------------

// =================================================================================
// 🛡️ COMPLIANCE INTEGRATION: PII Data Map and Erasure Logic
// =================================================================================

// 💡 PII DATA MAP: Defines schemas and fields for transactional erasure.
const PII_DATA_MAP = {
    User: {
        model: 'User', 
        queryField: '_id', 
        fieldsToErase: {
            email: (userId) => `erased-${userId}@erased.com`,
            firstName: 'ERASED',
            lastName: 'ERASED',
            phone: null, 
            address: 'ERASED',
            state: 'ERASED',
            country: 'ERASED',
            lastIp: null,
            lastUserAgent: null,
        },
    },
    Profile: {
        model: 'Profile',
        queryField: 'userId', 
        fieldsToErase: {
            bio: 'ERASED',
            phoneNumber: null, 
        }
    },
    Address: {
        model: 'Address', 
        queryField: 'userId', 
        fieldsToErase: {
            streetAddress: 'ERASED',
            city: 'ERASED',
            postalCode: 'ERASED',
            recipientName: 'ERASED',
        },
    },
    Notification: {
        model: 'Notification', 
        queryField: 'recipientId', 
        fieldsToErase: {
            messageContent: 'PII_ERASED', 
            senderEmail: null, 
            isArchived: true, 
        },
    }
};

/**
 * @desc Executes the Right to Erasure within a MongoDB Multi-Document Transaction.
 * (Logic moved directly from complianceWorker)
 * @param {string} userId - The MongoDB _id of the user document.
 */
const executeErasure = async (userId) => {
    const subjectObjectId = new mongoose.Types.ObjectId(userId); 

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        logger.info('ERASURE_TRANSACTION_START', { userId });

        for (const [collectionName, config] of Object.entries(PII_DATA_MAP)) {
            const Model = mongoose.model(config.model);
            if (!Model) {
                logger.warn('ERASURE_MODEL_NOT_FOUND', { collectionName });
                continue;
            }

            const updateSet = {};
            for (const [field, valueFnOrVal] of Object.entries(config.fieldsToErase)) {
                const pseudonym = (typeof valueFnOrVal === 'function') ? valueFnOrVal(userId) : valueFnOrVal;
                updateSet[field] = pseudonym;
            }
            
            updateSet['isDeleted'] = true;

            const query = { [config.queryField]: config.queryField === '_id' ? subjectObjectId : userId };

            const result = await Model.updateOne(
                query, 
                { $set: updateSet },
                { session: session }
            );

            logger.info('ERASURE_COLLECTION_UPDATED', { collection: collectionName, matched: result.matchedCount, modified: result.modifiedCount });
        }

        await session.commitTransaction();
        logger.info('ERASURE_SOFT_DELETE_COMPLETE', { userId });
        return { success: true, message: 'Data pseudonymized across all collections successfully.' };

    } catch (error) {
        await session.abortTransaction();
        logger.error('ERASURE_TRANSACTION_ABORTED', { userId, error: error.message });
        throw new Error(`Transactional erasure failed: ${error.message}`);
    } finally {
        session.endSession();
    }
};

// =================================================================================
// 📐 SCHEMAS (Expanded)
// =================================================================================

// NEW SECURITY SCHEMA
const PasswordRotationSchema = zod.object({
    outboxId: zod.string().nonempty(),
    userId: zod.string().nonempty(),
    traceId: zod.string().uuid(),
    payload: zod.object({
        revokeSessions: zod.boolean().optional().default(true),
    }).passthrough()
}).passthrough();

const ComplianceErasureSchema = zod.object({
    subjectId: zod.string().nonempty(),
    complianceOutboxId: zod.string().nonempty(), // Reference to the original DB record
}).passthrough(); 

const PaymentAtomicUpdateSchema = zod.object({
 orderId: zod.string().nonempty(),
 reference: zod.string().nonempty(),
 provider: zod.string().nonempty(),
 amount: zod.number().positive(),
 webhookLogId: zod.string().nonempty(),
 requestTraceId: zod.string().uuid().optional(), 
}).passthrough(); 

const OrderProcessSchema = zod.object({
 orderId: zod.string().nonempty(),
}).passthrough();

const LowStockSchema = zod.object({
 productId: zod.string().nonempty(),
 stock: zod.number().int().min(0),
}).passthrough();

const ProductCleanupSchema = zod.object({
 thresholdDays: zod.number().int().positive().optional().default(30),
}).passthrough();

const PaymentExpiryCheckSchema = zod.object({
 type: zod.literal("checkExpiry"),
 daysAhead: zod.number().int().positive().optional().default(30),
}).passthrough();


/**
* Helper to validate job data against a Zod schema.
*/
function validateJobData(schema, data, jobName) {
 try {
  return schema.parse(data);
 } catch (error) {
  if (error instanceof zod.ZodError) {
   const validationErrors = error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(', ');
   const errorMessage = `Job data validation failed for ${jobName}. Errors: ${validationErrors}`;
   AuditLogger.log({ level: 'CRITICAL', event: 'JOB_DATA_INVALID', details: { jobName, error: errorMessage, data } });
   throw new Error(`InvalidJobData: ${errorMessage}`);
  }
  throw error;
 }
}

// =================================================================================
// 🔑 HELPER: GRANULAR FAILURE POLICY
// =================================================================================
function handleTransactionalError(error, context) {
 const errorMessage = error.message;
 let finalStatus = "processed_failed_retry";
 let isRetryable = true;

 if (error.message.startsWith('InvalidJobData:')) {
  finalStatus = "processed_failed_invalid_data";
  isRetryable = false;
 } else if (error instanceof NotFoundError) {
  finalStatus = "processed_failed_permanent_data";
  isRetryable = false;
 } else if (error instanceof ConflictError) {
  finalStatus = "processed_failed_conflict";
  isRetryable = false; 
 } else if (error instanceof DomainError && error.code >= 400 && error.code < 500) {
  finalStatus = "processed_failed_domain_logic";
  isRetryable = false;
 } else {
  finalStatus = "processed_failed_retry";
  isRetryable = true;
 }

 AuditLogger.log({ 
  level: isRetryable ? 'ERROR' : 'CRITICAL', 
  event: `TRANSACTION_FAIL_${finalStatus.toUpperCase()}`, 
  details: { ...context, error: errorMessage } 
 });

 return isRetryable;
}

// =================================================================================
// 🔑 MAIN JOB HANDLERS (The ROUTER MAP for 'jobs' queue)
// =================================================================================
const JOB_HANDLERS = {
    // --- 🔐 NEW SECURITY HANDLER: PASSWORD ROTATION RELAY ---
    "auth.password_rotation_relay": async (job) => {
        // 1. Validate incoming Job Data
        const validatedData = validateJobData(PasswordRotationSchema, job.data, job.name);
        const { outboxId, userId, traceId, payload } = validatedData;
        const context = { jobId: job.id, outboxId, userId, traceId };

        // 2. ATOMIC CLAIM (The Database Lock)
        const task = await Outbox.findOneAndUpdate(
            { _id: outboxId, status: 'PENDING' },
            { 
                $set: { 
                    status: 'PROCESSING', 
                    claimedBy: process.env.HOSTNAME || 'omega-worker-node' 
                } 
            },
            { new: true }
        );

        if (!task) {
            logger.info("OUTBOX_CLAIM_SKIPPED", { reason: "Already processed or claimed", ...context });
            return { status: "skipped" };
        }

        try {
            AuditLogger.log({ level: 'INFO', event: 'PASSWORD_ROTATION_RELAY_START', context });

            // 3. EXECUTE CRITICAL SIDE-EFFECTS
            if (payload.revokeSessions) {
                await identityService.revokeAllTokens(userId, { 
                    reason: 'CREDENTIAL_ROTATION', 
                    traceId 
                });
            }

            // 4. Update Outbox to COMPLETED
            task.status = 'COMPLETED';
            task.processedAt = new Date();
            await task.save();

            AuditLogger.log({ level: 'INFO', event: 'PASSWORD_ROTATION_RELAY_SUCCESS', context });
            return { status: "success" };

        } catch (error) {
            // 5. Granular Error Handling
            task.status = 'FAILED';
            task.errorLog.push({ 
                message: error.message, 
                attempt: job.attemptsMade + 1, 
                timestamp: new Date() 
            });
            await task.save();

            const isRetryable = handleTransactionalError(error, context);
            if (isRetryable) throw error; 
            return { status: "failed_permanent" };
        }
    },

    // --- NEW COMPLIANCE HANDLER ---
    "compliance.erasure_request": async (job) => {
        const validatedData = validateJobData(ComplianceErasureSchema, job.data, job.name);
        const { subjectId, complianceOutboxId } = validatedData;
        
        const context = { jobId: job.id, subjectId, complianceOutboxId };
        AuditLogger.log({ level: 'INFO', event: 'ERASURE_JOB_START', context });
        
        let result = {};
        try {
            // 1. Execute the multi-document, transaction-safe erasure
            result = await executeErasure(subjectId);
            
            // 2. Mark the Outbox record as COMPLETED
            await ComplianceOutbox.updateOne(
                { _id: complianceOutboxId }, 
                { $set: { status: 'COMPLETED' } }
            );

            // 3. Publish final audit event
            AuditLogger.publish({
                type: 'COMPLIANCE_ERASURE_COMPLETED',
                data: { subjectId, status: 'COMPLETED', result },
            });

            logger.info('COMPLIANCE_JOB_SUCCESS', context);
            return result;

        } catch (error) {
            await ComplianceOutbox.updateOne(
                { _id: complianceOutboxId },
                { $push: { processingLog: { message: error.message, attempt: job.attemptsMade + 1 } } }
            );
            throw error; 
        }
    },

    // --- EXISTING PAYMENT HANDLER ---
    "payment.atomic_order_update": async (job) => {
        const validatedData = validateJobData(PaymentAtomicUpdateSchema, job.data, job.name);
        
        const context = { jobId: job.id, traceId: validatedData.requestTraceId || uuidv4(), ...validatedData };
        AuditLogger.log({ level: 'INFO', event: 'JOB_START', jobName: job.name, context });

        try {
            const result = await executeAtomicOrderUpdate(validatedData, context);

            if (result.status === 'duplicate') {
                AuditLogger.log({ level: 'INFO', event: 'PAYMENT_SUCCESS_BLOCKED_DUPLICATE', context });
                return;
            }

            AuditLogger.log({ level: 'INFO', event: 'PAYMENT_SUCCESS_FINAL', context });
            return result;

        } catch (error) {
            const isRetryable = handleTransactionalError(error, context);
            if (isRetryable) throw error; 
            
            logger.warn(`[MAIN] Job ${job.name} failed permanently.`, { jobId: job.id, error: error.message });
            return { status: 'failed_permanent', message: error.message }; 
        }
    },
    
    "payment.process": async (job) => {
        const error = new Error("DEPRECATED JOB: Use 'payment.atomic_order_update'.");
        AuditLogger.log({ level: "CRITICAL", event: "JOB_RETIRED_USAGE", details: { jobId: job.id } });
        throw error; 
    },

    "order.process": async (job) => {
        const validatedData = validateJobData(OrderProcessSchema, job.data, job.name);
        const { orderId } = validatedData;
        await markOrderAsProcessing(orderId, null, null);

        const orderDoc = await Order.findById(orderId).select("user totalAmount items").lean();
        if (!orderDoc) {
            logger.error("Order document not found during order.process.", { orderId });
            return;
        }

        await queueJob(GENERAL_QUEUE_NAME, "notify.send_confirmation", { orderId, userId: orderDoc.user.toString() });
        await queueJob(GENERAL_QUEUE_NAME, "inventory.erp_sync", { orderId, items: orderDoc.items });
        await queueJob(GENERAL_QUEUE_NAME, "analytics.track_purchase", { orderId, totalAmount: orderDoc.totalAmount });
    },

    "notify.low_stock": async (job) => {
        const validatedData = validateJobData(LowStockSchema, job.data, job.name);
        const { productId, stock } = validatedData;
        
        const admins = await UserModel.find({ role: "admin" }).select("_id").lean();
        const notifs = admins.map((a) => ({
            user: a._id,
            title: `Low Stock Alert`,
            body: `Product ${productId} has only ${stock} units remaining.`,
            read: false,
        }));

        if (notifs.length) await Notification.insertMany(notifs);
        if (global?.io) global.io.emit("adminNotification", { productId, stock });
    },

    "product.cleanup": async (job) => {
        const validatedData = validateJobData(ProductCleanupSchema, job.data, job.name);
        return await hardDeleteOldSoftDeleted(validatedData.thresholdDays);
    },

    "product.media.delete": async (job) => {
        await destroyCloudinaryMedia(job.data.images, job.data.video);
    },

    "notify.send_confirmation": async (job) => { logger.info("Email confirmation logic here"); },
    "inventory.erp_sync": async (job) => { logger.info("ERP Sync logic here"); },
    "analytics.track_purchase": async (job) => { logger.info("Analytics logic here"); },
};

// =================================================================================
// 🚀 STARTUP: DLQ Worker 
// =================================================================================

async function initializeDQLWorker() {
    try {
        console.log("--- Initializing DLQ Cache Recovery Worker ---");
        await connectDB(config.MONGO_URI);
        await connectRedis();
        initializeRedlock(); 
        startDeadLetterWorker(); 
        console.log("✅ Worker Infrastructure Ready.");
    } catch (err) {
        console.error("❌ Worker Initialization FAILED:", err.message);
        process.exit(1);
    }
}


// =================================================================================
// 🚀 WORKER 1: MAIN JOB WORKER
// =================================================================================
const MAIN_QUEUE_NAME = "jobs";
const MAINTENANCE_QUEUE_NAME = "paymentMaintenance"; 

const mainWorker = new Worker(
    MAIN_QUEUE_NAME,
    async (job) => {
        const handler = JOB_HANDLERS[job.name];
        if (!handler) {
            logger.warn(`No handler found for: ${job.name}`, { jobId: job.id });
            return;
        }

        try {
            logger.info(`[MAIN] Processing job ${job.name}.`, { jobId: job.id });
            await handler(job);
        } catch (error) {
            logger.error(`[MAIN] Job ${job.name} failed.`, { jobId: job.id, error: error.message });
            throw error; 
        }
    },
    {
        connection: REDIS_CONFIG,
        concurrency: Number(process.env.WORKER_CONCURRENCY || 20),
    }
);

// =================================================================================
// 💡 WORKER 2: MAINTENANCE WORKER
// =================================================================================

async function handlePaymentMaintenance(job) {
    if (job.name === "checkExpiryJob") {
        const { daysAhead } = validateJobData(PaymentExpiryCheckSchema, job.data, job.name);
        const count = await checkTokenExpiry(daysAhead); 
        return { processedCount: count };
    }
    throw new Error(`UnhandledMaintenanceJob: ${job.name}`); 
}

const maintenanceWorker = new Worker(
    MAINTENANCE_QUEUE_NAME,
    async (job) => {
        try {
            await handlePaymentMaintenance(job);
        } catch (error) {
            logger.error(`[MAINT] Job ${job.name} failed.`, { jobId: job.id, error: error.message });
            throw error; 
        }
    },
    {
        connection: REDIS_CONFIG,
        concurrency: Number(process.env.MAINTENANCE_WORKER_CONCURRENCY || 5), 
    }
);

// =================================================================================
// 👂 EVENT LISTENERS & SHUTDOWN
// =================================================================================
const mainQueueScheduler = new QueueScheduler(MAIN_QUEUE_NAME, { connection: REDIS_CONFIG });
const maintenanceQueueScheduler = new QueueScheduler(MAINTENANCE_QUEUE_NAME, { connection: REDIS_CONFIG });

mainWorker.on("completed", (job) => logger.info("Job completed", { jobId: job.id, name: job.name }));
mainWorker.on("failed", (job, err) => logger.error("Job failed", { jobId: job.id, error: err.message }));

async function shutdown() {
    logger.info("Graceful shutdown...");
    await mainWorker.close();
    await maintenanceWorker.close(); 
    await mainQueueScheduler.close();
    await maintenanceQueueScheduler.close(); 
    await disconnectRedis();
    await mongoose.disconnect();
    process.exit(0);
}

initializeDQLWorker(); 

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { mainWorker, maintenanceWorker };