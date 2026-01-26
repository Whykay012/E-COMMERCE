const Redis = require('ioredis');

/**
 * lib/redisCacheClient.js
 * Configures and exports a dedicated ioredis client instance 
 * for application-wide data caching, utilizing Redis Sentinel for High Availability.
 */

// --- 1. Base Configuration (Secure Environment Variables) ---
const redisCacheConfig = {
    // This host/port is ignored in Sentinel mode but kept for standard config properties
    host: process.env.REDIS_CACHE_HOST || 'localhost', 
    port: parseInt(process.env.REDIS_CACHE_PORT, 10) || 6379,
    password: process.env.REDIS_CACHE_PASSWORD,
    
    // Recommended for complex infrastructures (Clusters/Sentinels)
    maxRetriesPerRequest: 20,
    enableReadyCheck: true,

    // REQUIRED: Isolates keys from other services using the same Redis instance.
    keyPrefix: process.env.REDIS_CACHE_PREFIX || 'ec:cache:', 

    // Connection Resilience Settings
    retryStrategy(times) {
        const delay = Math.min(times * 500, 2000); // Exponential backoff: 0.5s, 1s, 1.5s, 2s max
        console.warn(`[App Cache Redis] Connection lost. Retrying in ${delay}ms... (Attempt: ${times})`);
        return delay;
    },

    // Optional: Add TLS/SSL for secure connection (MANDATORY in most cloud setups)
    tls: process.env.NODE_ENV === 'production' && process.env.REDIS_CACHE_TLS === 'true'
        ? {
            // Set rejectUnauthorized to true if you use a signed certificate
            rejectUnauthorized: false,
        }
        : undefined,
};

// --- 2. High Availability (HA) Configuration: Sentinel ---

// Define the Sentinel endpoints
const sentinels = [
    { host: process.env.REDIS_SENTINEL_HOST_1 || 'sentinel-1', port: parseInt(process.env.REDIS_SENTINEL_PORT_1, 10) || 26379 },
    { host: process.env.REDIS_SENTINEL_HOST_2 || 'sentinel-2', port: parseInt(process.env.REDIS_SENTINEL_PORT_2, 10) || 26379 },
    // Add more sentinel nodes as necessary
];

// Define the name of the master service monitored by the sentinels
const masterName = process.env.REDIS_SENTINEL_MASTER_NAME || 'my-ecom-master';

const cacheConnection = new Redis({
    sentinels: sentinels,
    name: masterName, // The name of the master instance
    ...redisCacheConfig, // Spread the common config (password, prefix, retry strategy, etc.)
});


// --- 3. Event Handlers (Monitoring and Logging) ---

cacheConnection.on('error', (error) => {
    // IMPORTANT: Treat this as a high-priority warning for monitoring/alerting systems.
    console.error('[App Cache Redis] FATAL Connection/Command Error:', error.message);
});

cacheConnection.on('connect', () => {
    console.log(`[App Cache Redis] Connection established via Sentinel. Master: ${masterName}. Prefix: ${redisCacheConfig.keyPrefix}`);
});

cacheConnection.on('ready', () => {
    console.log('[App Cache Redis] Client is ready for use (authenticated and connected).');
});


module.exports = { 
    cacheConnection // Exported name matches what is used in utils/queue.js
};