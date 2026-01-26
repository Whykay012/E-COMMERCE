// queue/finalPayoutWorker.js (Refactored Module - FULL CODE)
/**
 * * BullMQ Worker responsible for executing the final delayed payout (Stage 2).
 * * This file is a PURE module, managed by a runner process.
 */
require("dotenv").config(); 
const { Worker, Connection } = require('bullmq');
const logger = require("../config/logger"); // Assuming logger is available

// --- Service Imports (Assumed) ---
const { 
    processReferralPayout, 
    eventEmitter, 
    REFERRAL_EVENTS 
} = require('../services/referralService');
// --- End Service Imports ---

// Configure Redis Connection Details (Same connection)
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const redisConnection = new Connection({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
});

// Name of the Stage 2 queue
const PAYOUT_QUEUE_NAME = 'FinalPayoutQueue'; 

/**
 * Initializes and starts the BullMQ Worker for processing final payout jobs.
 * This is a PURE module function now.
 */
function startFinalPayoutWorker() {
    logger.info(`Initializing BullMQ Worker for queue: ${PAYOUT_QUEUE_NAME}`);

    const worker = new Worker(
        PAYOUT_QUEUE_NAME,
        async (job) => {
            const { name, data, id, attemptsMade } = job;
            logger.info(`[PAYOUT JOB ${id} - ${name}] Starting final payout job (Attempt ${attemptsMade + 1}) for data: ${JSON.stringify(data)}`);
            
            if (name === 'processPayout') {
                try {
                    // 🔑 CORE LOGIC: Execute the external payout service call
                    const result = await processReferralPayout(data);

                    logger.info(`[PAYOUT JOB ${id}] Final payout successful. Result: ${result.message}`);
                    
                    eventEmitter.emit(REFERRAL_EVENTS.PAYOUT_COMPLETED, {
                        ...data,
                        status: 'paid',
                        result: result.data
                    });

                    return result;

                } catch (error) {
                    logger.error(`[PAYOUT JOB ${id}] Failed after ${attemptsMade} attempts: ${error.message}`);
                    throw error; // Re-throw to trigger BullMQ retries
                }
            } else {
                logger.warn(`[PAYOUT JOB ${id}] Unknown job type: ${name}. Skipping.`);
                throw new Error(`Unrecognized job type: ${name}`);
            }
        },
        { 
            connection: redisConnection,
            concurrency: 3, 
        }
    );
    
    // NOTE: Listeners (on('error'), on('failed')) are intentionally omitted here 
    // as they are handled centrally in the financial_worker_runner.js file.

    return worker;
}

module.exports = { startFinalPayoutWorker, PAYOUT_QUEUE_NAME };