/**
 * utils/queue.js
 * Centralized BullMQ setup for defining application queues.
 * * * Changes Implemented:
 * 1. Uses dedicated 'bullMqConnection' for BullMQ operations (imported from lib/redisBullMQClient).
 * 2. Exports dedicated 'cacheConnection' for general application caching (imported from lib/redisCacheClient).
 * 3. Removed 'QueueScheduler' initialization; it is now initialized in a standalone service (workers/scheduler.js).
 */
const { Queue } = require("bullmq");
// Import dedicated connection instances
const { bullMqConnection } = require("../lib/redisBullMQClient");
const { cacheConnection } = require("../lib/redisCacheClient");

// --- Default Job Configuration ---
const defaultJobOptions = {
    // Keeps jobs for auditing purposes.
    removeOnComplete: {
        age: 7 * 24 * 3600, // keep successful jobs for 7 days
    },
    removeOnFail: {
        age: 30 * 24 * 3600, // keep failed jobs for 30 days
        count: 5000, // max 5000 failed jobs
    },
    // Set a default global timeout to prevent runaway jobs
    timeout: 30000, 
    // Set default retry attempts
    attempts: 3, 
};

/**
 * Creates a BullMQ Queue instance with necessary production settings.
 * Note: The QueueScheduler is intentionally omitted here for separation of concerns.
 * @param {string} name - The name of the queue.
 * @returns {Queue} The BullMQ Queue instance.
 */
function createQueue(name) {
    return new Queue(name, { 
        connection: bullMqConnection, // Use the dedicated BullMQ connection
        defaultJobOptions,
    });
}

// --- 3. Queues used by referral system ---
const payoutQueue = createQueue("referral:payout");       // High-priority financial transactions
const analyticsQueue = createQueue("referral:analytics"); // Low-priority batch processing
const notificationQueue = createQueue("referral:notification"); // Medium-priority user communication
const webhookQueue = createQueue("referral:webhook");     // Medium-priority external communication

module.exports = {
    bullMqConnection, // Export the dedicated BullMQ connection (used by Workers and Scheduler)
    cacheConnection,  // Export the dedicated Cache connection (used by application logic)
    payoutQueue,
    analyticsQueue,
    notificationQueue,
    webhookQueue,
    defaultJobOptions,
};