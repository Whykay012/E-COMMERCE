"use strict";

const logger = require("../utils/logger");

/**
 * COSMOS HYPER-FABRIC: Redis Security Helpers
 * ------------------------------------------
 * Centralized logic for temporary bans and blocklist lookups.
 * Includes a Global Kill Switch for emergency bypass.
 */

// 🚨 GLOBAL KILL SWITCH
// Set this to 'true' via Environment Variables to bypass all security checks.
const SECURITY_KILL_SWITCH = process.env.REDIS_SECURITY_BYPASS === "true";

/**
 * @desc Atomically blocks an identifier (IP/User) in Redis.
 */
async function temporarilyBlock(redis, key, durationSeconds = 300) {
    // 1. Kill Switch Check
    if (SECURITY_KILL_SWITCH) return;

    // 2. Client Readiness Check
    if (!redis || redis.status !== "ready") {
        logger.error("REDIS_HELPER_ERROR: Redis not ready for blocking operations");
        return;
    }

    const blockKey = `blocklist:${key}`;
    try {
        /**
         * ⚡ FIRE-AND-FORGET
         * We don't await because the user is already being rejected.
         * We catch errors to prevent unhandled promise rejections.
         */
        redis.set(blockKey, "1", "EX", durationSeconds).catch(err => {
            logger.error({ err: err.message }, "ASYNC_SET_BLOCK_FAILURE");
        });
        
        logger.warn("SECURITY_EVENT_IDENTIFIER_BLOCKED", {
            key: blockKey,
            duration: `${durationSeconds}s`
        });
    } catch (err) {
        logger.error({ err: err.message }, "FAILED_TO_INITIATE_TEMPORARY_BLOCK");
    }
}

/**
 * @desc Checks if an identifier is currently on the blocklist.
 */
async function isBlocked(redis, key) {
    // 1. Kill Switch Check - If active, let everyone through.
    if (SECURITY_KILL_SWITCH) {
        if (Math.random() < 0.01) { // Log once every 100 requests to avoid spamming
            logger.warn("RATE_LIMITER_BYPASSED: Global Kill Switch is ACTIVE");
        }
        return false;
    }

    // 2. Fail Open: If Redis is connecting or reconnecting, let the request pass.
    if (!redis || redis.status !== "ready") {
        return false; 
    }

    const blockKey = `blocklist:${key}`;
    try {
        /**
         * ⚡ O(1) Complexity
         * Fastest possible lookup in the Cluster.
         */
        const exists = await redis.exists(blockKey);
        return exists === 1;
    } catch (err) {
        // Log the failure but do NOT block the user (Fail-Open).
        logger.error({ err: err.message, key: blockKey }, "BLOCKLIST_CHECK_FAILURE_FAIL_OPEN");
        return false; 
    }
}

module.exports = {
    temporarilyBlock,
    isBlocked
};