/**
 * queue/payoutQueue.js
 * Defines the dedicated BullMQ Queue instance and its resilient configuration.
 * This file is imported by both the Producer (Manager) and the Consumer (Worker).
 */
const { Queue } = require("bullmq");

// FIX: Must use 'require' to import the Redis client definition
const { bullMQRedisClient } = require("../lib/redisBullMQClient"); 

const PAYOUT_QUEUE_NAME = 'finance:payouts';

/**
 * @typedef {object} PayoutJobData
 * @property {string} transactionId - The unique, idempotent, business-level ID for the payout.
 * @property {string} providerAccountId - The payment gateway's customer/account ID.
 * @property {number} amount - The payout amount (in cents/smallest unit).
 * @property {string} currency - The currency code (e.g., 'USD').
 */

/**
 * Queue Setup: Defines the specific settings for the finance:payouts queue.
 * @type {Queue<PayoutJobData>}
 */
const payoutQueue = new Queue(PAYOUT_QUEUE_NAME, {
    // 1. Connection: Use the shared, dedicated Redis instance
    connection: bullMQRedisClient,

    // 2. Prefix: Isolate this queue's data from all other queues in Redis
    prefix: 'app:finance:payouts',

    // 3. Rate Limiting (CRITICAL FOR EXTERNAL APIs)
    limiter: {
        max: 10,       // Max number of jobs processed
        duration: 1000, // Per 1000 milliseconds (1 second)
    },

    // 4. Default Job Options (Resilience and Cleanup)
    defaultJobOptions: {
        timeout: 30000, 
        attempts: 3,
        backoff: {
            type: 'exponential', 
            delay: 5000, 
        },
        removeOnComplete: { count: 1000 }, 
        removeOnFail: { age: 604800 }, 
    },
});

/**
 * Error Handler: Essential for centralized logging and monitoring
 */
payoutQueue.on('error', (err) => {
    console.error(`[BullMQ] FATAL Queue Error on ${PAYOUT_QUEUE_NAME}: ${err.message}`, err);
});


// Using module.exports for consistency with CommonJS environment
module.exports = { 
    payoutQueue, // EXPORT the queue instance
    PAYOUT_QUEUE_NAME 
}