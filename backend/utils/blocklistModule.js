// utils/blocklist.js (FINAL OMEGA NEXUS ZENITH)

const Logger = require('./logger'); 
const Tracing = require('./tracingClient'); 
const InternalServerError = require('../errors/internal-server-error');
const { ATOMIC_SET_BLOCK_SCRIPT } = require('./services/rateLimiter/luaScripts'); // NEW

// --- Configuration ---
const BLOCKLIST_KEY_PREFIX = 'sec:block:'; 
// Max allowed TTL for any single automatic block instance (30 minutes)
const MAX_ALLOWED_BAN_SECONDS = 30 * 60; 

// --- Lua Script SHA Holder (Must be loaded at application startup) ---
let atomicBlockScriptSha = null;

// =============================================================================
// Initialization/Setup
// =============================================================================

/**
 * @desc Pre-loads the atomic block script into Redis and stores the SHA.
 * This should be called once during application startup.
 * @param {object} redisClient - The initialized Redis client instance.
 */
const initializeBlocklist = async (redisClient) => {
    try {
        if (redisClient.status !== 'ready') {
            throw new Error("Redis client is not ready for script loading.");
        }
        atomicBlockScriptSha = await redisClient.script('LOAD', ATOMIC_SET_BLOCK_SCRIPT);
        Logger.info('BLOCKLIST_LUA_LOADED', { sha: atomicBlockScriptSha });
    } catch (error) {
        Logger.critical('BLOCKLIST_LUA_LOAD_FAILED', { error: error.message });
        // Fail process or alert SREs aggressively
        throw error; 
    }
};

// =============================================================================
// Core Functions
// =============================================================================

/**
 * @desc Temporarily blocks an identifier using atomic Lua scripting for safety.
 * @param {object} redisClient - The initialized and ready Redis client instance.
 * @param {string} identifier - The unique identifier (e.g., 'ip:1.1.1.1' or 'user:123').
 * @param {number} banSeconds - The duration of the temporary ban in seconds.
 * @param {string} reason - Optional context for the ban (e.g., 'BRUTE_FORCE', 'RATE_LIMIT_EXCEED').
 * @returns {Promise<boolean>} True if the block was successfully set or extended.
 */
const temporarilyBlock = async (
    redisClient, 
    identifier, 
    banSeconds, 
    reason = 'RATE_LIMIT_EXCEED'
) => {
    return Tracing.withSpan('Blocklist:temporarilyBlock', async (span) => {
        const key = `${BLOCKLIST_KEY_PREFIX}${identifier}`;
        span.setAttribute('block.identifier', identifier);
        span.setAttribute('block.duration_s', banSeconds);
        span.setAttribute('block.reason', reason);

        if (!redisClient || redisClient.status !== 'ready' || !atomicBlockScriptSha) {
            Logger.critical('BLOCKLIST_REDIS_OR_LUA_UNAVAILABLE', { identifier, action: 'block' });
            return false;
        }

        try {
            // Execute the ATOMIC Lua script
            const [isBlocked, finalTTL] = await redisClient.evalsha(
                atomicBlockScriptSha, 
                1, // KEYS count
                key, // KEYS[1]
                banSeconds, // ARGV[1] (New TTL)
                MAX_ALLOWED_BAN_SECONDS // ARGV[2] (Max TTL Cap)
            );

            const isSuccess = isBlocked === 1;
            const ttlSeconds = parseInt(finalTTL, 10);
            
            if (isSuccess) {
                Logger.alert('IDENTIFIER_TEMPORARILY_BLOCKED', { 
                    identifier, 
                    duration: `${ttlSeconds}s`,
                    reason
                });
            } else {
                // This means the ban was not applied because it already exceeded the MAX_ALLOWED_BAN_SECONDS
                Logger.warn('BLOCK_DENIED_MAX_TTL', { 
                    identifier, 
                    currentTTL: ttlSeconds, 
                    maxTTL: MAX_ALLOWED_BAN_SECONDS 
                });
            }
            
            span.setAttribute('block.success', isSuccess);
            span.setAttribute('block.finalTTL_s', ttlSeconds);
            return isSuccess;

        } catch (error) {
            Logger.error('BLOCKLIST_SET_FAILURE_LUA_ERROR', { error: error.message, key });
            throw new InternalServerError('Failed to execute atomic blocklist operation.');
        }
    });
};

/**
 * @desc Checks if an identifier is currently blocked. (O(1) efficiency remains)
 */
const isBlocked = async (redisClient, identifier) => {
    return Tracing.withSpan('Blocklist:isBlocked', async (span) => {
        const key = `${BLOCKLIST_KEY_PREFIX}${identifier}`;
        span.setAttribute('block.identifier', identifier);

        if (!redisClient || redisClient.status !== 'ready') {
            Logger.critical('BLOCKLIST_REDIS_UNAVAILABLE', { identifier, action: 'check' });
            return false;
        }

        try {
            // EXISTS is the fastest command for a security check.
            const exists = await redisClient.exists(key);
            const isBanned = exists === 1;
            span.setAttribute('block.status', isBanned ? 'BANNED' : 'CLEAN');
            
            return isBanned;

        } catch (error) {
            Logger.error('BLOCKLIST_CHECK_FAILURE', { error: error.message, key });
            return false;
        }
    });
};

/**
 * @desc Manually removes a block from an identifier (e.g., via admin tool).
 */
const unblock = async (redisClient, identifier) => {
    return Tracing.withSpan('Blocklist:unblock', async () => {
        const key = `${BLOCKLIST_KEY_PREFIX}${identifier}`;
        
        try {
            const deletedCount = await redisClient.del(key);
            if (deletedCount > 0) {
                Logger.info('IDENTIFIER_MANUALLY_UNBLOCKED', { identifier });
            }
            return deletedCount;
        } catch (error) {
            Logger.error('BLOCKLIST_UNBLOCK_FAILURE', { error: error.message, key });
            return 0;
        }
    });
};

module.exports = {
    initializeBlocklist, // NEW: Must be called at startup
    temporarilyBlock,
    isBlocked,
    unblock,
    BLOCKLIST_KEY_PREFIX,
    MAX_ALLOWED_BAN_SECONDS
};