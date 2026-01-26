// lib/redisBullMQClient.js
// Provides the dedicated connection instance that BullMQ will use for all its operations.
const IORedis = require("ioredis");

// --- IORedis Connection Setup ---
const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

/**
 * The connection used exclusively by BullMQ Queues, Workers, and Schedulers.
 * This separation prevents high-volume caching/app queries from blocking BullMQ's critical operations.
 */
const bullMqConnection = new IORedis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    // CRITICAL for BullMQ: Allows the queue library to handle its own retry logic
    maxRetriesPerRequest: null, 
    enableReadyCheck: false,
});

// Log connection status for diagnostics
bullMqConnection.on('connect', () => {
    console.log('BullMQ Connection: Dedicated client connected successfully.');
});

bullMqConnection.on('error', (err) => {
    console.error('BullMQ Connection: CRITICAL Redis connection error:', err.message);
});


module.exports = {
    bullMqConnection,
};