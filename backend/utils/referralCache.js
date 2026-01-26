/**
 * utils/cache.js
 * Centralized caching utility for key generation, CRUD, and specialized Redis commands.
 * This is the single source of truth for all cache interactions.
 */
const { getRedisClient } = require("../lib/redisClient");

// --- Configuration Constants (Read from environment variables) ---
// Using sensible defaults if environment variables are missing
const DEFAULT_REFERRAL_TTL = parseInt(process.env.REFERRAL_CACHE_TTL || "300", 10); // 5 minutes
const DEFAULT_ADMIN_TTL = parseInt(process.env.ADMIN_REFERRAL_CACHE_TTL || "60", 10); // 1 minute
const IDEMPOTENCY_KEY_TTL = parseInt(process.env.IDEMPOTENCY_KEY_TTL || "86400", 10); // 24 hours

// --- Key Generators ---

function referralCacheKey(userId) {
    return `referral:user:${userId}`;
}

function referralCodeKey(code) {
    return `referral:code:${code}`;
}

function adminListKey({ page = 1, limit = 25 } = {}) {
    return `admin:referrals:page=${page}:limit=${limit}`;
}

/**
 * Generates the key used to track the status of a request for idempotency.
 * @param {string} key - The unique ID provided by the client (e.g., UUID).
 * @returns {string} The formatted Redis key.
 */
function idempotencyKey(key) {
    return `idempotency:tx:${key}`;
}

// --- CRUD Operations ---

async function cacheGet(key) {
    const r = getRedisClient();
    try {
        const raw = await r.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        // Log error but gracefully fail by returning null if not critical
        console.error("[Cache] cacheGet error:", err.message);
        return null;
    }
}

async function cacheSet(key, value, ttl = DEFAULT_REFERRAL_TTL) {
    const r = getRedisClient();
    try {
        const payload = JSON.stringify(value);
        if (ttl > 0) {
            // Use the standard SET command with expiry (EX)
            await r.set(key, payload, { EX: ttl });
        } else {
            await r.set(key, payload);
        }
    } catch (err) {
        console.error("[Cache] cacheSet error:", err.message);
        // Fail silently in non-critical SET operations
    }
}

/**
 * Attempts to set a key ONLY IF it does not already exist (Set-If-Not-Exists).
 * This is the critical operation for guaranteed idempotency and distributed locking.
 * @param {string} key - The idempotency key.
 * @param {string} value - A simple value (e.g., "processing" or the transaction ID).
 * @param {number} ttl - The time-to-live for the key.
 * @returns {Promise<boolean>} True if the key was set (i.e., this is the first request), false otherwise.
 */
async function cacheSetNX(key, value, ttl = IDEMPOTENCY_KEY_TTL) {
    const r = getRedisClient();
    try {
        const result = await r.set(key, value, {
            NX: true, // Only set if the key does not exist
            EX: ttl   // Set the expiry time
        });
        // result is 'OK' if set, or null if not set (key existed)
        return result === 'OK';
    } catch (err) {
        console.error("[Cache] cacheSetNX error:", err.message);
        // CRITICAL: If Redis fails during an idempotency check, we MUST abort the transaction.
        throw new Error("Caching service failed during critical idempotency check. Aborting.");
    }
}

async function cacheDel(...keys) {
    const r = getRedisClient();
    try {
        if (keys.length) await r.del(...keys);
    } catch (err) {
        console.error("[Cache] cacheDel error:", err.message);
        // Fail silently
    }
}

// --- Special Operations ---

/**
 * Invalidates all keys matching the admin list pattern using SCAN.
 */
async function invalidateAdminReferralCaches() {
    const r = getRedisClient();
    try {
        // Use scanStream to safely iterate over keys without blocking the Redis server
        const stream = r.scanStream({ match: "admin:referrals:*", count: 100 });
        const delKeys = [];
        for await (const keys of stream) {
            if (keys.length) delKeys.push(...keys);
        }
        
        if (delKeys.length) {
            console.log(`[Cache] Invalidating ${delKeys.length} admin cache keys.`);
            await r.del(...delKeys);
        }
    } catch (err) {
        console.error("[Cache] invalidateAdminReferralCaches error:", err.message);
    }
}

module.exports = {
    // Key Generators
    referralCacheKey,
    referralCodeKey,
    adminListKey,
    idempotencyKey,

    // CRUD & Special Operations
    cacheGet,
    cacheSet,
    cacheDel,
    cacheSetNX,
    invalidateAdminReferralCaches,
    
    // Constants
    DEFAULT_REFERRAL_TTL,
    DEFAULT_ADMIN_TTL,
};