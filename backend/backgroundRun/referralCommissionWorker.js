// queue/referralCommissionWorker.js (Refactored Module - FULL CODE)
/**
 * * BullMQ Worker responsible for executing the atomic commission credit transaction (Stage 1).
 * * This file is a PURE module, managed by a runner process.
 */
require('dotenv').config(); 
const { Worker, Connection } = require('bullmq');
const logger = require("../config/logger"); // Assuming logger is available

// --- Service Imports (Assumed) ---
const { 
    executeCommissionCreditTransaction, 
    eventEmitter, 
    REFERRAL_EVENTS 
} = require('../services/referralService');
// --- End Service Imports ---

// Configure Redis Connection Details
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const redisConnection = new Connection({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
});

// Name of the queue defined in referralService.js
const COMMISSION_QUEUE_NAME = 'ReferralPayoutQueue'; 

/**
 * Initializes and starts the BullMQ Worker for processing commission jobs.
 * This is a PURE module function now.
 */
function startReferralCommissionWorker() {
    logger.info(`Initializing BullMQ Worker for queue: ${COMMISSION_QUEUE_NAME}`);

    const worker = new Worker(
        COMMISSION_QUEUE_NAME,
        async (job) => {
            const { name, data, id, attemptsMade } = job;
            logger.info(`[JOB ${id} - ${name}] Starting job (Attempt ${attemptsMade + 1}) for data: ${JSON.stringify(data)}`);
            
            if (name === 'executeCommissionCredit') {
                try {
                    // 🔑 CORE LOGIC: Execute the atomic transactional logic
                    const result = await executeCommissionCreditTransaction(data);

                    logger.info(`[JOB ${id}] Commission credit successful for Order ${data.orderRef}. Result: ${result.message}`);
                    
                    eventEmitter.emit(REFERRAL_EVENTS.COMMISSION_CREDITED, {
                        ...data,
                        status: 'processed',
                        result: result.data
                    });

                    return result;

                } catch (error) {
                    logger.error(`[JOB ${id}] Failed after ${attemptsMade} attempts: ${error.message}`);
                    throw error; // Re-throw to trigger BullMQ retries
                }
            } else {
                logger.warn(`[JOB ${id}] Unknown job type: ${name}. Skipping.`);
                throw new Error(`Unrecognized job type: ${name}`);
            }
        },
        { 
            connection: redisConnection,
            concurrency: 5, 
            settings: {
                lockDuration: 300000, // 5 minutes lock duration
            }
        }
    );

    // NOTE: Listeners (on('error'), on('failed')) are intentionally omitted here 
    // as they are handled centrally in the financial_worker_runner.js file.

    return worker;
}

module.exports = { startReferralCommissionWorker, COMMISSION_QUEUE_NAME };