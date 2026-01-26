// financial_worker_runner.js
/**
 * Dedicated Runner for CRITICAL Financial Workers and Schedulers.
 * All critical payout/commission workers are consolidated here for maximum stability.
 * This process is designed for dedicated, high-priority infrastructure.
 */

require('dotenv').config(); 
const connectDB = require("./config/connect");
const config = require("./config");
const { connectRedis } = require("./lib/redisClient");
const logger = require("./config/logger"); 

// --- Imports: Financial Components ---
// 1. Generic Worker (Handles payment.process on 'jobs' queue)
const genericWorker = require("./workers/genericWorker"); 
// 2. Commission Worker (Stage 1) - Refactored module
const { startReferralCommissionWorker } = require('./referralCommissionWorker'); 
// 3. Final Payout Worker (Stage 2) - Refactored module
const { startFinalPayoutWorker } = require('./finalPayoutWorker'); 
// 4. Payout Scheduler (for setting repeatable cron-like jobs)
const { startPayoutScheduler } = require('../worker/scheduler');

// --- Component Tracking ---
let commissionWorker;
let finalPayoutWorker; 
let payoutScheduler; 
let workerResources = []; // Array to hold all workers/schedulers for centralized shutdown

async function startFinancialWorkers() {
    try {
        // --- STEP 1: Connect Shared Dependencies ---
        await connectDB(config.MONGO_URI);
        await connectRedis(); 
        logger.info("✅ Financial Worker Dependencies (DB, Redis) connected.");

        // --- STEP 2: Start Custom Workers and Schedulers ---

        // A. Start Referral Commission Worker (Stage 1: Atomic Credit Transaction)
        commissionWorker = startReferralCommissionWorker(); 
        // Centralized error handling and monitoring
        commissionWorker.on('error', (err) => logger.error("CRITICAL Commission Worker Error:", err.message));
        commissionWorker.on('failed', (job, err) => logger.error(`Commission Job ${job.id} failed: ${err.message}`));
        logger.info("✅ Commission Worker (Stage 1) initialized.");
        
        // B. Start Final Payout Worker (Stage 2: Delayed Payout Execution)
        finalPayoutWorker = startFinalPayoutWorker();
        // Centralized error handling and monitoring
        finalPayoutWorker.on('error', (err) => logger.error("CRITICAL Final Payout Worker Error:", err.message));
        finalPayoutWorker.on('failed', (job, err) => logger.error(`Final Payout Job ${job.id} failed: ${err.message}`));
        logger.info("✅ Final Payout Worker (Stage 2) initialized.");
        
        // C. Start Payout Scheduler (For Cron-like repeatable tasks)
        payoutScheduler = startPayoutScheduler(); 
        logger.info("✅ Payout Scheduler initialized (Cron Jobs).");

        // D. Generic Worker instance (Handling payment.process webhooks on the 'jobs' queue)
        genericWorker.on('error', (err) => logger.error("CRITICAL Payment Handler Worker Error:", err.message));
        genericWorker.on('failed', (job, err) => logger.error(`Payment Job ${job.id} failed: ${err.message}`));
        logger.info("✅ Generic Worker (for Payment Webhooks) is active.");

        // NOTE: Capture all components for shutdown
        workerResources = [genericWorker, commissionWorker, finalPayoutWorker, payoutScheduler];
        
        // --- STEP 3: Confirmation ---
        logger.info(`\n======================================================`);
        logger.info(`| Financial Worker Process Started. PID: ${process.pid}`);
        logger.info(`| Active Workers: Payments, Commission (S1), Payout (S2)|`);
        logger.info(`======================================================\n`);
    } catch (err) {
        logger.error("❌ [FATAL] Financial Worker process failed to start.", { error: err.message });
        await shutdown(true);
        process.exit(1); 
    }
}

// --- Graceful Shutdown Logic ---
async function shutdown(isFailure = false) {
    if (!isFailure) logger.info("Shutting down Financial Worker process gracefully...");
    
    // Reverse the array to shut down workers before schedulers
    const resourcesToClose = [...workerResources].reverse(); 
    
    for (const resource of resourcesToClose) {
        if (resource && typeof resource.close === 'function') {
            try {
                await resource.close();
                logger.info(`Resource closed: ${resource.name || resource.constructor.name}`);
            } catch (err) {
                logger.error(`Error closing resource: ${resource.name || resource.constructor.name}`, { err: err.message });
            }
        }
    }
    logger.info("Financial Worker shutdown complete.");
    if (!isFailure) process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startFinancialWorkers();