const { ATOMIC_SET_BLOCK_SCRIPT } = require('./luaScripts');
const Logger = require("../utils/logger");

/**
 * Handles the logic for checking and setting temporary bans in Redis.
 */
const blocklistUtils = {
    
    /**
     * Checks if a specific identifier is currently blocked.
     * @param {object} redisClient - Active Redis connection.
     * @param {string} identifier - User ID or IP address.
     * @returns {Promise<boolean>}
     */
    isBlocked: async (redisClient, identifier) => {
        try {
            const result = await redisClient.exists(`blocklist:${identifier}`);
            return result === 1;
        } catch (err) {
            Logger.error("BLOCKLIST_CHECK_FAILURE", { identifier, error: err.message });
            return false; // Fail-open to avoid locking everyone out on Redis error
        }
    },

    /**
     * Atomically sets or extends a block on an identifier.
     * Uses the ATOMIC_SET_BLOCK_SCRIPT to ensure TTL capping.
     * * @param {object} redisClient - Active Redis connection.
     * @param {string} identifier - User ID or IP address.
     * @param {number} durationSeconds - How long to block (requested).
     * @param {number} maxDurationSeconds - The absolute limit for a ban (e.g., 24 hours).
     */
    temporarilyBlock: async (redisClient, identifier, durationSeconds, maxDurationSeconds = 86400) => {
        const key = `blocklist:${identifier}`;
        
        try {
            // We use EVAL instead of EVALSHA here for the block script 
            // unless you pre-load this script SHA during startup as well.
            const [success, finalTtl] = await redisClient.eval(
                ATOMIC_SET_BLOCK_SCRIPT,
                1,              // Number of keys
                key,            // KEYS[1]
                durationSeconds,// ARGV[1]
                maxDurationSeconds // ARGV[2]
            );

            if (success === 1) {
                Logger.warn("IDENTIFIER_TEMPORARILY_BLOCKED", { 
                    identifier, 
                    ttl: finalTtl, 
                    reason: "Repeated rate limit breach" 
                });
            } else {
                Logger.info("BLOCK_EXTENSION_DENIED_MAX_REACHED", { identifier, currentTtl: finalTtl });
            }

            return finalTtl;
        } catch (err) {
            Logger.error("TEMPORARY_BLOCK_SET_FAILURE", { identifier, error: err.message });
            return 0;
        }
    }
};

module.exports = blocklistUtils;