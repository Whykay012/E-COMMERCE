/*
 * workers/routerProcessor.js
 * ------------------------------------------------------------------
 * Logic Routing & Failure Policy Engine (Optimized & Standardized)
 * ------------------------------------------------------------------
 * Features: Slack Alerting, Atomic Outbox Updates, Schema Validation
 * ------------------------------------------------------------------
 */

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
const { markOrderAsProcessing } = require("../service/orderAutomationService");
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
 * Helper to update Outbox records upon successful completion.
 */
async function finalizeOutbox(eventId, status = 'COMPLETED') {
    return await Outbox.findByIdAndUpdate(eventId, {
        $set: { status, processedAt: new Date() }
    }, { new: true });
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
            
            // 🚨 AUTH EMAIL RELAY (Password Resets & Security Alerts)
            case "auth.email_relay": {
                const event = await Outbox.findById(validatedData.eventId);
                if (!event || event.status !== 'PENDING') return { status: "ignored" };

                let templatePath;
                let subject;
                let priority = "normal"; // Default priority
                
                let placeholders = {
                    COMPANY: process.env.COMPANY_NAME || 'Zenith',
                    EMAIL: event.payload.email,
                    YEAR: new Date().getFullYear()
                };

                // --- Dynamic Routing based on Event Type ---
                switch (event.eventType) {
                    
                    // 1. Password Reset Template (High Priority)
                    case 'PASSWORD_RESET_REQUESTED':
                        templatePath = 'emails/reset-password.html';
                        subject = `Reset Your Password - ${placeholders.COMPANY}`;
                        placeholders.RESET_LINK = event.payload.link;
                        placeholders.TOKEN = event.payload.token;
                        priority = "high"; 
                        break;

                    // 2. New User Signup / Verification (High Priority)
                    case 'USER_VERIFICATION_REQUESTED':
                        templatePath = 'emails/verify-account.html';
                        subject = `Verify Your Account - ${placeholders.COMPANY}`;
                        placeholders.OTP = event.payload.code || event.payload.otp; 
                        priority = "high";
                        break;

                    // 3. Resend OTP / MFA Template (High Priority)
                    case 'MFA_CHALLENGE_DISPATCH':
                    case 'OTP_RESEND_REQUESTED':
                        templatePath = 'emails/resend-otp.html';
                        subject = `Your New OTP Code - ${placeholders.COMPANY}`;
                        placeholders.OTP = event.payload.code || event.payload.otp;
                        priority = "high";
                        break;

                    // 4. Security Confirmation (Normal Priority - Non-Critical)
                    case 'PASSWORD_CHANGED_SECURE':
                        templatePath = 'emails/password-confirm.html';
                        subject = 'Security Alert: Password Changed';
                        break;

                    default:
                        logger.warn(`[ROUTER] No template mapping for event: ${event.eventType}`);
                        return { status: "ignored" };
                }

                // Call the enhanced hybrid sendEmail utility
                await sendEmail({
                    to: event.payload.email,
                    subject: subject,
                    htmlTemplatePath: templatePath,
                    placeholders: placeholders,
                    priority: priority // This triggers the SDK Fast Track in sendEmail.js
                });

                await finalizeOutbox(event._id);
                return { status: "success" };
            }

            case "cache.invalidate_user": {
                const start = Date.now();
                const userPrefix = `notifs:u:${validatedData.userId}:*`;
                const keys = await cache.client.keys(userPrefix);
                if (keys.length > 0) await cache.client.del(...keys);
                Metrics.timing('worker.cache_purge.latency', Date.now() - start);
                return { status: "success", count: keys.length };
            }

            case "auth.mfa_relay": {
                const event = await Outbox.findById(validatedData.eventId);
                if (!event || event.status !== 'PENDING') return { status: "ignored" };

                await notificationService.sendMfaCode({
                    userId: event.aggregateId,
                    code: event.payload.code,
                    mode: event.payload.mode,
                    target: event.payload.target
                });

                await finalizeOutbox(event._id);
                return { status: "success" };
            }

            case "auth.mfa_cleanup": {
                const event = await Outbox.findById(validatedData.eventId);
                if (!event || event.status !== 'PENDING') return { status: "ignored" };

                await mfaService.cleanupSession(event.payload.nonce);
                
                if (event.payload.isSuspicious) {
                    await notificationService.sendSecurityAlert(event.aggregateId, {
                        type: 'SUSPICIOUS_LOGIN_SUCCESS',
                        ip: event.payload.ip
                    });
                }

                await finalizeOutbox(event._id);
                return { status: "success" };
            }

            case "auth.security_logout_relay": {
                const start = Date.now();
                const { userId, sessionId, tracingContext, reason } = validatedData;

                if (sessionId) {
                    await cache.client.del(`sess:active:${userId}:${sessionId}`);
                } else {
                    const allSessions = await cache.client.keys(`sess:active:${userId}:*`);
                    if (allSessions.length > 0) await cache.client.del(...allSessions);
                }

                await AuditLogger.log({
                    level: 'INFO',
                    event: 'USER_LOGOUT_FINALIZED',
                    userId,
                    details: { sessionId, reason, global: !sessionId, traceId: tracingContext?.['x-trace-id'] }
                });

                const mfaKeys = await cache.client.keys(`mfa:state:*:u:${userId}`);
                if (mfaKeys.length > 0) await cache.client.del(...mfaKeys);

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