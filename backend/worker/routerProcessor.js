/*
 * workers/routerProcessor.js
 * ------------------------------------------------------------------
 * Logic Routing & Failure Policy Engine (Titan Nexus Edition)
 * ------------------------------------------------------------------
 * Features: Atomic Outbox Transactions, SCAN-based Cache Purging
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const logger = require("../config/logger");
const Metrics = require("../utils/metricsClient");
const AuditLogger = require("../services/auditLogger");
const schemaValidator = require("../utils/schemaValidator");
const cache = require("../services/redisCacheUtil");

// --- Service Layer Mapping ---
const complianceKernel = require("../services/complianceKernel");
const identityService = require("../services/identityService");
const { executeAtomicOrderUpdate } = require('../services/paymentService');
const { checkTokenExpiry } = require('../services/paymentMethodService');
const updateGeoDb = require('../scripts/updateGeoDb'); // The script we wrote earlier
const { markOrderAsProcessing } = require("../services/orderAutomationService");
const { hardDeleteOldSoftDeleted, destroyCloudinaryMedia } = require("../controller/productController");
const mfaService = require('../services/adaptiveMfaEngine');
const notificationService = require('../services/notificationService');
const { sendCriticalAlert } = require('../services/slackAlertService');
const Outbox = require('../models/Outbox');
const sendEmail = require('../utils/sendEmail'); 

// --- Models ---
const Order = require("../model/order");
const UserModel = require("../model/userModel"); 
const Notification = require("../model/notificationModel"); 
const queueClient = require('../services/queueClient');

/**
 * @desc Ensures Exactly-Once processing by checking and updating status atomically.
 * Prevents race conditions where multiple workers pick up the same Outbox event.
 */
async function processOutboxWithLock(eventId, processFn) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // 1. Lock the document for editing within this session
        const event = await Outbox.findById(eventId).session(session);

        // 2. If not PENDING, it was already handled or is being handled elsewhere
        if (!event || event.status !== 'PENDING') {
            await session.abortTransaction();
            return { status: "ignored" };
        }

        // 3. Execute the "Effect" (External API calls like Email/MFA)
        // If this throws, we catch it and abort the transaction
        await processFn(event);

        // 4. Atomic update of state
        event.status = 'COMPLETED';
        event.processedAt = new Date();
        await event.save({ session });

        await session.commitTransaction();
        return { status: "success" };
    } catch (error) {
        // Rollback ensures status stays 'PENDING' for a retry
        await session.abortTransaction();
        throw error; 
    } finally {
        session.endSession();
    }
}

/**
 * Determines if a failure should trigger a retry.
 */
function getRetryableStatus(error) {
    if (error.message.startsWith('InvalidJobData:')) return false;
    const permanentErrors = ["NotFoundError", "ConflictError", "ValidationError"];
    if (permanentErrors.includes(error.name)) return false;
    if (error.code >= 400 && error.code < 500) return false;
    return true;
}

/**
 * Main Routing Logic
 */
module.exports = async function routerProcessor(jobName, data, rawJob) {
    logger.info(`[ROUTER] Processing: ${jobName}`, { jobId: rawJob.id });

    try {
        // 1. Schema Validation
        const validatedData = schemaValidator.validate(jobName, data);

        // 2. Execution Switch
        switch (jobName) {
            
            // 🚨 AUTH EMAIL RELAY (Atomic Reset & Verification)
            case "auth.email_relay": {
                return await processOutboxWithLock(validatedData.eventId, async (event) => {
                    let templatePath;
                    let subject;
                    let priority = "normal"; 
                    
                    let placeholders = {
                        COMPANY: process.env.COMPANY_NAME || 'Zenith',
                        EMAIL: event.payload.email,
                        YEAR: new Date().getFullYear()
                    };

                    switch (event.eventType) {
                        case 'PASSWORD_RESET_REQUESTED':
                            templatePath = 'emails/reset-password.html';
                            subject = `Reset Your Password - ${placeholders.COMPANY}`;
                            placeholders.RESET_LINK = event.payload.link;
                            placeholders.TOKEN = event.payload.token;
                            priority = "high"; 
                            break;
                        case 'USER_VERIFICATION_REQUESTED':
                            templatePath = 'emails/verify-account.html';
                            subject = `Verify Your Account - ${placeholders.COMPANY}`;
                            placeholders.OTP = event.payload.code || event.payload.otp; 
                            priority = "high";
                            break;
                        case 'MFA_CHALLENGE_DISPATCH':
                        case 'OTP_RESEND_REQUESTED':
                            templatePath = 'emails/resend-otp.html';
                            subject = `Your New OTP Code - ${placeholders.COMPANY}`;
                            placeholders.OTP = event.payload.code || event.payload.otp;
                            priority = "high";
                            break;
                        case 'PASSWORD_CHANGED_SECURE':
                            templatePath = 'emails/password-confirm.html';
                            subject = 'Security Alert: Password Changed';
                            break;
                        default:
                            throw new Error(`InvalidOutboxEvent: ${event.eventType}`);
                    }

                    await sendEmail({
                        to: event.payload.email,
                        subject,
                        htmlTemplatePath: templatePath,
                        placeholders,
                        priority 
                    });
                });
            }

            case "infra.update_geoip_db": {
        logger.info("🌍 CLUSTER_MAINTENANCE: Starting MaxMind Database Update...");
        const start = Date.now();
        
        await updateGeoDb();
        
        Metrics.timing('infra.geoip_update.latency', Date.now() - start);
        return { status: "success" };
    }

            case "cache.invalidate_user": {
                const start = Date.now();
                const userPrefix = `notifs:u:${validatedData.userId}:*`;
                const count = await cache.purgePattern(userPrefix);
                Metrics.timing('worker.cache_purge.latency', Date.now() - start);
                return { status: "success", count };
            }

            case "auth.mfa_relay": {
                return await processOutboxWithLock(validatedData.eventId, async (event) => {
                    await notificationService.sendMfaCode({
                        userId: event.aggregateId,
                        code: event.payload.code,
                        mode: event.payload.mode,
                        target: event.payload.target
                    });
                });
            }

            case "auth.mfa_cleanup": {
                return await processOutboxWithLock(validatedData.eventId, async (event) => {
                    await mfaService.cleanupSession(event.payload.nonce);
                    if (event.payload.isSuspicious) {
                        await notificationService.sendSecurityAlert(event.aggregateId, {
                            type: 'SUSPICIOUS_LOGIN_SUCCESS',
                            ip: event.payload.ip
                        });
                    }
                });
            }

            case "auth.security_logout_relay": {
                const start = Date.now();
                const { userId, sessionId, tracingContext, reason } = validatedData;

                if (sessionId) {
                    await cache.client.del(`sess:active:${userId}:${sessionId}`);
                } else {
                    await cache.purgePattern(`sess:active:${userId}:*`);
                }

                await AuditLogger.log({
                    level: 'INFO',
                    event: 'USER_LOGOUT_FINALIZED',
                    userId,
                    details: { sessionId, reason, global: !sessionId, traceId: tracingContext?.['x-trace-id'] }
                });

                await cache.purgePattern(`mfa:state:*:u:${userId}`);
                Metrics.timing('worker.auth.logout_latency', Date.now() - start);
                return { status: "success" };
            }

            case "compliance.erasure_request":
                return await complianceKernel.executeErasure(validatedData.subjectId, validatedData.complianceOutboxId, rawJob);

            case "auth.password_rotation_relay":
                return await identityService.handlePasswordRotation(validatedData, rawJob);

            case "payment.atomic_order_update":
                const context = { jobId: rawJob.id, traceId: validatedData.requestTraceId || uuidv4(), ...validatedData };
                return await executeAtomicOrderUpdate(validatedData, context);

            case "order.process":
                await markOrderAsProcessing(validatedData.orderId, null, null);
                const orderDoc = await Order.findById(validatedData.orderId).select("user items").lean();
                if (orderDoc) {
                    await queueClient.send('jobs', { name: "notify.send_confirmation", data: { orderId: validatedData.orderId, userId: orderDoc.user.toString() } });
                    await queueClient.send('jobs', { name: "inventory.erp_sync", data: { orderId: validatedData.orderId, items: orderDoc.items } });
                }
                return { status: "success" };

            case "notify.low_stock":
                const admins = await UserModel.find({ role: "admin" }).select("_id").lean();
                const notifs = admins.map((a) => ({
                    user: a._id,
                    title: `Low Stock Alert`,
                    body: `Product ${validatedData.productId} stock: ${validatedData.stock}`,
                    read: false,
                }));
                if (notifs.length) await Notification.insertMany(notifs);
                return { status: "success" };

            case "product.cleanup":
                return await hardDeleteOldSoftDeleted(validatedData.thresholdDays);

            case "product.media.delete":
                return await destroyCloudinaryMedia(validatedData.images, validatedData.video);
            
            case "checkExpiryJob":
            case "payment.checkExpiry":
                return await checkTokenExpiry(validatedData.daysAhead, rawJob);

            default:
                logger.warn(`⚠️ Unhandled job type: ${jobName}`, { jobId: rawJob.id });
                return { status: "ignored" };
        }
    } catch (error) {
        const isRetryable = getRetryableStatus(error);
        
        if (!isRetryable) {
            await sendCriticalAlert(jobName, {
                userId: data.userId || data.subjectId,
                error: error.message,
                event: 'PERMANENT_JOB_FAILURE',
                jobId: rawJob.id
            });
        }

        AuditLogger.log({ 
            level: isRetryable ? 'ERROR' : 'CRITICAL', 
            event: 'JOB_EXECUTION_FAILED', 
            details: { jobName, error: error.message, isRetryable, jobId: rawJob.id } 
        });

        if (isRetryable) throw error; 
        return { status: "failed_permanent", error: error.message };
    }
};