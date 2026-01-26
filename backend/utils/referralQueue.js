/**
 * utils/queue.js
 * * This file establishes the shared Redis connection and defines the BullMQ 
 * queue instance used across both the application (for enqueuing) and 
 * the worker (for processing).
 * * Best Practice: Centralize Redis connection settings for consistency.
 */
const { Queue, Redis } = require("bullmq");

// --- Configuration ---

// Use environment variables for connection security and flexibility
const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || null; // Null if no password needed

// Queue Name: The name must be consistent across the Queue and the Worker
const QUEUE_NAME = "referral:webhook";

// --- Redis Connection Shared Instance ---

/**
 * Shared Redis connection configuration object.
 * This object is passed to both the Queue and the Worker constructors.
 * @type {Redis.RedisOptions}
 */
const connection = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    // Max 10 connections in the pool (default is 10)
    maxRetriesPerRequest: null, // Essential for long-running workers
    enableOfflineQueue: false, // Prevents commands from piling up if connection drops
});

connection.on("connect", () => {
    console.log(`[Queue] Connected to Redis at ${REDIS_HOST}:${REDIS_PORT}`);
});

connection.on("error", (err) => {
    console.error(`[Queue] Redis connection error: ${err.message}`);
    // Handle serious connection errors (e.g., attempt to reconnect or exit process)
});


// --- Queue Definition ---

/**
 * The BullMQ Queue instance for managing referral webhooks.
 * This is used by the main application server to add new jobs.
 * @type {Queue}
 */
const webhookQueue = new Queue(
    QUEUE_NAME, 
    {
        connection,
        // Default options for new jobs added to this queue
        defaultJobOptions: {
            removeOnComplete: { count: 100 }, // Keep last 100 successful jobs for auditing
            removeOnFail: { count: 500 }, // Keep last 500 failed jobs
        }
    }
);

/**
 * Adds event listeners to the Queue instance for monitoring.
 * (Optional, but useful for understanding the application's flow).
 */
webhookQueue.on("error", (err) => {
    console.error(`[Queue] An error occurred on the webhookQueue instance: ${err.message}`);
});

// Use a self-invoking function to clean up old, potentially stuck jobs on startup
(async () => {
    try {
        const cleanupTypes = ['waiting', 'active', 'delayed', 'failed'];
        console.log(`[Queue] Cleaning up old jobs from previous runs...`);
        // Drain clears all jobs in the queue, use carefully in production
        // await webhookQueue.drain(true); 

        // Or, more selectively, clean stale jobs (safer option)
        for (const type of cleanupTypes) {
             const count = await webhookQueue.clean(0, 1000, type); // Clean jobs older than 0ms, limit 1000
             if (count > 0) {
                 console.log(`[Queue] Cleaned ${count} jobs of type: ${type}`);
             }
        }
    } catch (err) {
        console.error(`[Queue] Error during queue startup cleanup: ${err.message}`);
    }
})();

module.exports = {
    connection, // The shared Redis connection for Workers and Queues
    webhookQueue, // The Queue instance for adding jobs
    QUEUE_NAME,
};