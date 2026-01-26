// infrastructure/idempotencyCache.js

const { createClient } = require('redis');

// --- External Dependency Fix: Import the actual logger ---
// Assuming auditLogger is located at './services/auditLogger' based on previous context
const AuditLogger = require('../services/auditLogger'); // ⬅️ MODIFIED: Replaced stub with actual import

// --- Redis Configuration ---
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Global client instance
let client;

/**
 * Initializes and connects the Redis client. 
 */
async function initializeClient() {
    if (client && client.isOpen) {
        return;
    }

    try {
        client = createClient({ url: REDIS_URL });

        client.on('error', (err) => {
            console.error('Redis Client Error:', err);
            // Log critical infrastructure error to the audit system
            // 🎯 FIX: Use the exported dispatchLog function
            AuditLogger.dispatchLog({ 
                level: 'CRITICAL', 
                event: 'REDIS_CONNECTION_ERROR', 
                details: { error: err.message, url: REDIS_URL } 
            });
        });

        await client.connect();
        console.log('Redis connected successfully for IdempotencyCache.');
    } catch (err) {
        console.error('Failed to connect to Redis:', err);
        // 🎯 FIX: Use the exported dispatchLog function
        AuditLogger.dispatchLog({ 
            level: 'CRITICAL', // ⬅️ MODIFIED: Changed 'FATAL' to 'CRITICAL' (as FATAL is not in the map)
            event: 'REDIS_INIT_FAILED', 
            details: { error: err.message } 
        });
        throw new Error('Redis connection failed.');
    }
}

/**
 * Retrieves the cached result of an idempotent operation.
 * @param {string} key - The unique Idempotency Key.
 * @returns {Promise<string|null>} The cached value (the result of the operation), or null.
 */
async function get(key) {
    const redisKey = `idempotency:${key}`;

    if (!client || !client.isOpen) {
        // 🎯 FIX: Use the exported dispatchLog function
        AuditLogger.dispatchLog({ 
            level: 'WARN', // ⬅️ MODIFIED: Changed 'WARNING' to 'WARN' (to match LOG_LEVEL_MAP)
            event: 'IDEMPOTENCY_GET_BYPASS', 
            details: { key, reason: 'Client Disconnected' } 
        });
        return null; 
    }
    
    try {
        const result = await client.get(redisKey);
        
        if (result) {
            // 🎯 FIX: Use the exported dispatchLog function
            AuditLogger.dispatchLog({ 
                level: 'INFO', 
                event: 'IDEMPOTENCY_CACHE_HIT', 
                details: { key } 
            });
        }
        return result;

    } catch (error) {
        // 🎯 FIX: Use the exported dispatchLog function
        AuditLogger.dispatchLog({ 
            level: 'ERROR', // ERROR is generally mapped to CRITICAL or a custom log level
            event: 'IDEMPOTENCY_GET_ERROR', 
            details: { key, error: error.message } 
        });
        return null;
    }
}

/**
 * Stores the successful result of an idempotent operation with an expiration time.
 * @param {string} key - The unique Idempotency Key.
 * @param {string} value - The JSON stringified result of the successful operation.
 * @param {number} ttlSeconds - Time-to-live in seconds (e.g., 3600 for 1 hour).
 * @returns {Promise<boolean>} - True if set successfully, false if key already existed (NX condition hit).
 */
async function set(key, value, ttlSeconds = 3600) {
    const redisKey = `idempotency:${key}`;
    let success = false;

    if (!client || !client.isOpen) {
        // 🎯 FIX: Use the exported dispatchLog function
        AuditLogger.dispatchLog({ 
            level: 'CRITICAL', // ⬅️ Using CRITICAL for failed set, as idempotency guarantee is lost
            event: 'IDEMPOTENCY_SET_FAILED', 
            details: { key, reason: 'Client Disconnected' } 
        });
        return false;
    }
    
    try {
        const result = await client.set(redisKey, value, {
            EX: ttlSeconds,
            NX: true 
        });

        if (result === 'OK') {
            success = true;
            // 🎯 FIX: 'SUCCESS' is not a valid level, changing to 'INFO' or 'RISK' for transactional success
            AuditLogger.dispatchLog({ 
                level: 'INFO', 
                event: 'IDEMPOTENCY_KEY_CREATED', 
                details: { key, ttl: ttlSeconds } 
            });
        } else {
            // 🎯 FIX: Use the exported dispatchLog function
            AuditLogger.dispatchLog({ 
                level: 'INFO', 
                event: 'IDEMPOTENCY_KEY_SKIPPED_NX', 
                details: { key, reason: 'Key already exists (NX condition met)' } 
            });
        }
        return success;

    } catch (error) {
        // 🎯 FIX: Use the exported dispatchLog function
        AuditLogger.dispatchLog({ 
            level: 'CRITICAL', 
            event: 'IDEMPOTENCY_SET_CRIT_ERROR', 
            details: { key, error: error.message } 
        });
        // 🎯 CRITICAL FIX: The error class 'TransientPaymentError' is undefined. Replace with a standard Error.
        throw new Error(`Idempotency storage failure for key ${key}. Review necessary. Original error: ${error.message}`);
    }
}


module.exports = {
    initializeClient,
    get,
    set,
};