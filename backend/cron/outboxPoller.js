/**
 * cron/maintenanceWorker.js
 * ------------------------------------------------------------------
 * ZENITH SELF-HEALING & COMPLIANCE AUDIT ENGINE
 * ------------------------------------------------------------------
 * Responsibilities:
 * 1. Outbox Poller: Re-dispatches stale PENDING events (MFA, Resets, Compliance).
 * 2. Compliance Auditor: Reports failed erasures to Slack daily.
 * 3. Idempotency Setup: Ensures the BullMQ cleanup job is registered.
 * ------------------------------------------------------------------
 */

const cron = require('node-cron');
const Outbox = require('../models/Outbox');
const queueClient = require('../services/queueClient');
const logger = require('../config/logger');
const { getErasureHealthReport } = require('../services/complianceStats');
const { sendCriticalAlert } = require('../services/slackAlertService');
const { scheduleDailyCleanup } = require("../services/idempotencyService");

/* ===========================================================
 * 1. OUTBOX POLLER (High Frequency: Every 1 Minute)
 * ===========================================================
 * This ensures 100% reliability. If the initial dispatch hint 
 * fails due to Redis/Network issues, this poller recovers it.
 * =========================================================== */
cron.schedule('* * * * *', async () => {
    try {
        // Find records that are PENDING and older than 2 minutes
        // We give the 'Instant Hint' 2 minutes to succeed before taking over.
        const staleDate = new Date(Date.now() - 2 * 60 * 1000);
        
        const staleEvents = await Outbox.find({
            status: 'PENDING',
            createdAt: { $lt: staleDate }
        }).limit(50); 

        if (staleEvents.length === 0) return;

        logger.info(`[POLLER] Found ${staleEvents.length} stale events. Re-dispatching to Reliability Queue...`);

        for (const event of staleEvents) {
            let jobName;
            
            // Map Outbox Event Types to specific BullMQ Workers
            switch (event.eventType) {
                case 'PASSWORD_RESET_REQUESTED': 
                case 'PASSWORD_CHANGED_SECURE': 
                    jobName = 'auth.email_relay'; 
                    break;

                case 'MFA_CHALLENGE_DISPATCH': 
                    jobName = 'auth.mfa_relay'; 
                    break;

                case 'MFA_AUTHENTICATION_FINALIZED': 
                    jobName = 'auth.mfa_cleanup'; 
                    break;

                case 'COMPLIANCE_ERASURE': 
                    jobName = 'compliance.erasure_request'; 
                    break;

                case 'SECURITY_LOGOUT_AUDIT': 
                    jobName = 'auth.security_logout_relay'; 
                    break;

                default: 
                    logger.warn(`[POLLER] Unrecognized event type: ${event.eventType}`, { eventId: event._id });
                    jobName = null;
            }

            if (jobName) {
                // Re-inject into the queue with full metadata for idempotency
                await queueClient.send('jobs', { 
                    name: jobName, 
                    data: { 
                        eventId: event._id,
                        type: event.eventType,
                        traceId: event.traceId // Maintain the observability chain
                    } 
                });
                
                logger.debug(`[POLLER] Self-healed & Re-queued job: ${jobName}`, { eventId: event._id });
            }
        }

    } catch (err) {
        logger.error('[POLLER] Critical Error during Outbox cleanup:', err);
    }
});

/* ===========================================================
 * 2. COMPLIANCE AUDITOR (Daily at 8:00 AM)
 * ===========================================================
 * Scans for PII erasure requests that failed to process.
 * Crucial for GDPR/CCPA legal compliance.
 * =========================================================== */
cron.schedule('0 8 * * *', async () => {
    logger.info('[AUDITOR] Starting daily compliance health check...');
    
    try {
        const report = await getErasureHealthReport();
        const failedCount = report.summary.find(s => s._id === 'FAILED')?.count || 0;

        if (failedCount > 0) {
            await sendCriticalAlert("DAILY_COMPLIANCE_REPORT", {
                error: `System detected ${failedCount} failed erasure requests. Manual intervention is required for GDPR/CCPA compliance.`,
                event: "HEALTH_CHECK_FAILURE",
                details: {
                    summary: report.summary,
                    latency: report.health
                }
            });
            logger.warn(`[AUDITOR] Compliance alert sent: ${failedCount} failures.`);
        } else {
            logger.info('[AUDITOR] Compliance check passed. All erasures processed.');
        }

    } catch (err) {
        logger.error('[AUDITOR] Failed to generate compliance report:', err);
    }
});

/* ===========================================================
 * 3. IDEMPOTENCY CLEANUP REGISTRATION (Boot-time)
 * =========================================================== */
(async () => {
    try {
        // This registers the BullMQ repeatable job in Redis to clear
        // processed event keys to keep Redis memory usage low.
        await scheduleDailyCleanup();
        logger.info('🚀 Idempotency Queue Job Registered (Runs daily at 2:00 AM)');
    } catch (err) {
        logger.error('Failed to register idempotency cleanup job:', err);
    }
})();

logger.info('🚀 Zenith Maintenance CRONs initialized and monitoring Outbox');