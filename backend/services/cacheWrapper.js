// services/redisCacheUtil.js
// ADVANCED ENTERPRISE CACHE UTILITY
// Netflix / Stripe / AWS Grade

const redis = require("../config/redis");
// 💡 Add the unified logger utility
const logger = require("../utils/logger"); 

// ---------------- CONFIG ----------------

const NULL_MARKER = "null";
const STALE_PREFIX = "stale:";
const LOCK_PREFIX = "lock:";

const DEFAULT_NULL_TTL = 10;
const DEFAULT_STALE_TTL = 60;
const DEFAULT_LOCK_TTL = 5; // seconds – prevents stampede

// ---------------- HEALTH CHECK ----------------

const isRedisReady = () =>
  redis && redis.status === "ready";

// ---------------- SAFE JSON ----------------

function safeJSONParse(value, key) {
  try {
    return JSON.parse(value);
  } catch (err) {
    // 🚨 Use logger.error for data integrity issues
    logger.error(`[CACHE:JSON_PARSE_FAIL] Failed to parse cached value for key.`, { key, error: err.message });
    return null;
  }
}

// ---------------- LOCK (SINGLE-FLIGHT) ----------------

async function acquireLock(key) {
  if (!isRedisReady()) return false;

  return redis.set(
    `${LOCK_PREFIX}${key}`,
    "1",
    "NX",
    "EX",
    DEFAULT_LOCK_TTL
  );
}

async function releaseLock(key) {
  if (!isRedisReady()) return;
  await redis.del(`${LOCK_PREFIX}${key}`);
}

// ---------------- CORE READ-THROUGH CACHE ----------------

/**
* Advanced Read-Through Cache:
* - Stampede protection (locks)
* - Stale-while-revalidate
* - Graceful degradation
* - Penetration protection
*/
async function cached(
  key,
  ttlSeconds,
  computeFn,
  staleTtlSeconds = DEFAULT_STALE_TTL
) {
  // ---- 0. Fail-open if Redis unavailable ----
  if (!isRedisReady()) {
    // 💡 Use logger.warn for operational status/bypass
    logger.warn(`[CACHE:BYPASS] Redis not ready. Bypassing cache for key.`, { key });
    return computeFn();
  }

  // ---- 1. Try fresh cache ----
  try {
    const cachedValue = await redis.get(key);
    if (cachedValue !== null) {
      if (cachedValue === NULL_MARKER) return null;
      return safeJSONParse(cachedValue, key);
    }
  } catch (err) {
    // 🚨 Use logger.error for critical infrastructure read failures
    logger.error(`[CACHE:READ_FAIL] Failed to read fresh cache for key.`, { key, error: err.message });
  }

  // ---- 2. Stampede protection ----
  const lockAcquired = await acquireLock(key);

  if (!lockAcquired) {
    // Another request is computing → serve stale
    try {
      const stale = await redis.get(`${STALE_PREFIX}${key}`);
      if (stale) {
        // 💡 Use logger.warn for single-flight contention
        logger.warn(`[CACHE:STALE_SINGLEFLIGHT] Serving stale cache due to single-flight lock.`, { key });
        return safeJSONParse(stale, key);
      }
    } catch (_) {}

    return computeFn(); // last-resort
  }

  // ---- 3. Compute fresh value ----
  try {
    const fresh = await computeFn();

    if (fresh === null || fresh === undefined) {
      await redis.set(key, NULL_MARKER, "EX", DEFAULT_NULL_TTL);
      return null;
    }

    const serialized = JSON.stringify(fresh);

    // Store fresh
    await redis.set(key, serialized, "EX", ttlSeconds);

    // Store stale (longer TTL)
    await redis.set(
      `${STALE_PREFIX}${key}`,
      serialized,
      "EX",
      staleTtlSeconds
    );

    return fresh;

  } catch (err) {
    // 🚨 Use logger.error for critical compute function failure
    logger.error(`[CACHE:COMPUTE_FAIL] Compute function failed for key.`, { key, error: err.message, stack: err.stack });

    // ---- 4. Serve stale on failure ----
    try {
      const stale = await redis.get(`${STALE_PREFIX}${key}`);
      if (stale) {
        // 💡 Use logger.warn for a fallback scenario
        logger.warn(`[CACHE:STALE_FALLBACK] Serving stale cache after compute failure.`, { key });
        return safeJSONParse(stale, key);
      }
    } catch (_) {}

    throw err;

  } finally {
    await releaseLock(key);
  }
}

// ---------------- SIMPLE GET ----------------

/**
* Low-level GET
* Fail-open, safe, penetration-aware
*/
const get = async (key) => {
  if (!isRedisReady()) return null;

  try {
    const value = await redis.get(key);
    if (!value || value === NULL_MARKER) return null;
    return safeJSONParse(value, key);
  } catch (err) {
    // 🚨 Use logger.error for read failures
    logger.error(`[CACHE:SIMPLE_GET_FAIL] Failed during simple GET.`, { key, error: err.message });
    return null;
  }
};

// ---------------- SIMPLE SET ----------------

/**
* Low-level SET
* Ensures consistent null handling
*/
const set = async (key, value, ttlSeconds) => {
  if (!isRedisReady()) return;

  try {
    const storeValue =
      value === null || value === undefined
        ? NULL_MARKER
        : JSON.stringify(value);

    await redis.set(key, storeValue, "EX", ttlSeconds);
  } catch (err) {
    // 🚨 Use logger.error for write failures
    logger.error(`[CACHE:SIMPLE_SET_FAIL] Failed during simple SET.`, { key, error: err.message });
  }
};

// ---------------- EXPORT ----------------

module.exports = {
  cached,
  get,
  set,
  client: redis
};