// workers/scheduler.js
/**
 * * Dedicated module for initializing and configuring the BullMQ QueueScheduler and repeatable jobs.
 * This process MUST be run as a single instance globally by the Financial Worker Runner.
 * * DESIGN PRINCIPLE: Strict separation of concerns, high resiliency during setup, and clear job contracts.
 */
const { QueueScheduler, Job, Connection } = require("bullmq"); 
const pLimit = require('p-limit'); 
const logger = require("../config/logger"); 

// 1. CRITICAL IMPORTS: Assuming these utility/queue files export the necessary instances.
const { 
    bullMqConnection, 
    payoutQueue,      
    analyticsQueue,   
    notificationQueue, 
    webhookQueue,     
} = require("../utils/queue"); 

// --- CONFIGURATION & CONSTANTS ---
const SCHEDULER_NAME = 'FinancialSystemScheduler';
const SCHEDULER_CONCURRENCY_LIMIT = 5; 
const STALLED_CHECK_INTERVAL = 15000; 
const GRACEFUL_CLOSE_TIMEOUT = 10000; 
const DEFAULT_TIMEZONE = 'Etc/UTC'; // Enforce the standard time zone for all cron jobs

// Collect all relevant queue instances for dynamic access
const allQueues = [payoutQueue, analyticsQueue, notificationQueue, webhookQueue];


// 💡 ENTERPRISE UPGRADE: Define a standardized contract for all repeatable jobs
const REPEATABLE_JOB_CONFIGS = [
    // 1. Daily Financial Reconciliation (CRITICAL)
    {
        queue: payoutQueue,
        jobName: 'runDailyReconciliation',
        jobId: 'dailyFinancialReconciliation',
        data: { type: 'full_ledger_check', tags: ['critical', 'finance'] },
        options: {
            repeat: { cron: '0 1 * * *', tz: DEFAULT_TIMEZONE },
            attempts: 5, 
            backoff: { type: 'exponential', delay: 30000 },
            removeOnComplete: Job.KeepActive,
            opts: { lockKey: 'schedule:dailyFinancialReconciliation' },
            priority: 1, // Highest priority
        }
    },
    // 2. Daily Analytics Report
    {
        queue: analyticsQueue,
        jobName: 'generateDailyReport',
        jobId: 'dailyAnalyticsReport',
        data: { type: 'referral_performance', period: 'daily' },
        options: {
            repeat: { cron: '0 0 * * *', tz: DEFAULT_TIMEZONE },
            attempts: 2,
            removeOnComplete: true,
            priority: 5,
        }
    },
    // 3. Weekly Notification Cleanup
    {
        queue: notificationQueue,
        jobName: 'cleanOldNotifications',
        jobId: 'weeklyNotificationCleanup',
        data: { maxDays: 30, tags: ['maintenance'] },
        options: {
            repeat: { cron: '0 3 * * 0', tz: DEFAULT_TIMEZONE }, 
            attempts: 3,
            removeOnComplete: true,
            priority: 10,
        }
    },
    // 4. Daily Product Cleanup (INTEGRATED & RESILIENT)
    {
        queue: analyticsQueue,
        jobName: 'product.cleanup',
        jobId: 'cleanup-old-products',
        data: { 
            thresholdDays: 30, 
            tags: ['cleanup', 'inventory', 'scheduled', 'rate_limit_low'],
            metadata: { 
                sourceService: SCHEDULER_NAME,
                environment: process.env.NODE_ENV || 'production',
                complianceType: 'DataRetention',
            }
        },
        options: {
            repeat: { cron: '0 2 * * *', tz: DEFAULT_TIMEZONE, immediate: false },
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
            priority: 10,
            opts: { lockKey: 'schedule:cleanup-old-products', lockDuration: 3600000 },
            removeOnComplete: { age: 3600, count: 10 }, 
            removeOnFail: { age: 86400 * 7, count: 50 }, 
        }
    }
];


/**
 * 🛠️ PRODUCTION READY: Deletes all existing repeatable jobs before setting up the new ones.
 * @returns {Promise<void>}
 */
async function cleanAndSetupRepeatableJobs() {
    logger.info(`[${SCHEDULER_NAME}] Performing clean-up of old repeatable jobs...`);
    
    const limit = pLimit(SCHEDULER_CONCURRENCY_LIMIT);
    let totalRemovedJobs = 0;

    const cleanupPromises = allQueues.map(queue => limit(async () => {
        try {
            const jobs = await queue.getRepeatableJobs();
            await Promise.all(jobs.map(job => queue.removeRepeatableByKey(job.key)));
            logger.info(`[${SCHEDULER_NAME}] Cleaned up ${jobs.length} repeatable jobs from queue: ${queue.name}`);
            totalRemovedJobs += jobs.length;
            return { status: 'fulfilled', queue: queue.name };
        } catch (error) {
            // 💡 ENTERPRISE UPGRADE: Explicitly return 'rejected' status
            logger.error(`[${SCHEDULER_NAME}] CRITICAL: Failed to clean queue ${queue.name}. Ignoring failure to continue:`, error.message);
            return { status: 'rejected', queue: queue.name, reason: error.message };
        }
    }));
    
    // 💡 ENTERPRISE UPGRADE: Use Promise.allSettled for maximum resilience
    const cleanupResults = await Promise.allSettled(cleanupPromises);
    
    const failedCleanupQueues = cleanupResults
        .filter(r => r.status === 'rejected' || r.value.status === 'rejected')
        .map(r => r.reason || r.value.queue);
    
    if (failedCleanupQueues.length > 0) {
        logger.warn(`[${SCHEDULER_NAME}] WARN: Failed to clean up jobs on the following queues: ${failedCleanupQueues.join(', ')}. Proceeding with job setup.`);
    }

    logger.info(`[${SCHEDULER_NAME}] Old repeatable job cleanup complete. Total removed: ${totalRemovedJobs}. Setting up new schedules.`);

    // --- REPEATABLE JOB SETUP (Idempotent Scheduling) ---
    const jobPromises = REPEATABLE_JOB_CONFIGS.map(config => limit(async () => {
        try {
            await config.queue.add(
                config.jobName, 
                config.data, 
                { ...config.options, jobId: config.jobId } // Merge options and jobId
            );
            logger.info(`[${SCHEDULER_NAME}] Successfully scheduled repeatable job: ${config.jobId} on queue ${config.queue.name}.`);
        } catch (error) {
            logger.error(`[${SCHEDULER_NAME}] FATAL: Failed to schedule job ${config.jobId}:`, error.message);
            // Re-throw to be caught by the outer catch block in startPayoutScheduler
            throw new Error(`Failed to schedule ${config.jobId}: ${error.message}`);
        }
    }));
    
    await Promise.all(jobPromises);
    logger.info(`[${SCHEDULER_NAME}] All repeatable jobs (${REPEATABLE_JOB_CONFIGS.length} total) successfully scheduled.`);
}


/**
 * 🔑 CORE FUNCTION: Initializes the QueueScheduler and sets up repeatable jobs.
 * @returns {QueueScheduler} The running BullMQ QueueScheduler instance.
 */
function startPayoutScheduler() {
    logger.info(`[${SCHEDULER_NAME}] Initializing scheduler service...`);
    
    const schedulerInstance = new QueueScheduler(
        payoutQueue.name, 
        { 
            connection: bullMqConnection,
            autorun: true,
            maxStalledCheck: STALLED_CHECK_INTERVAL, 
            lockDuration: 600000, 
            prefix: 'bull-prod' 
        }
    );

    // --- CENTRALIZED EVENT MONITORING ---
    schedulerInstance.on('error', (err) => {
        logger.error(`[${SCHEDULER_NAME}] Scheduler connection error. Reconnecting is automatic.`, { error: err.message, stack: err.stack });
    });
    schedulerInstance.on('stalled', (jobId) => {
        logger.warn(`[${SCHEDULER_NAME}] Found stalled job. Re-adding: ${jobId}`);
    });


    // Execute the setup function after the scheduler starts
    cleanAndSetupRepeatableJobs().catch(error => {
        // This FATAL exit is now much safer as the setup function handles partial failures internally
        logger.error(`[${SCHEDULER_NAME}] FATAL: Unrecoverable error during job setup. Throwing up to runner.`, error);
        throw error; 
    });

    return schedulerInstance;
}


/**
 * 🔑 FINAL EXPORT: Provides the function required by the runner.
 */
module.exports = { startPayoutScheduler, allQueues, GRACEFUL_CLOSE_TIMEOUT };