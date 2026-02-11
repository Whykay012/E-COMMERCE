/**
 * redisMfaStore.js
 * Optimized Zenith Omega implementation
 */
const cache = require("../lib/redisCacheUtil"); 
const Logger = require("../utils/logger");

// 1. Refined Lua Script with "Null Marker" resilience
const ATOMIC_INCREMENT_SCRIPT = `
    local current = redis.call('GET', KEYS[1])
    if not current or current == "__NULL__" then 
        -- If it's missing or a null marker, initialize a fresh object
        local fresh = { a = 1 }
        local encoded = cjson.encode(fresh)
        redis.call('SETEX', KEYS[1], 300, encoded) -- Default 5m TTL if new
        return encoded
    end

    -- Attempt to decode, pcall (protected call) prevents script crash on bad JSON
    local status, data = pcall(cjson.decode, current)
    
    if not status or type(data) ~= "table" then
        -- If decoding failed, overwrite the garbage with a clean state
        data = { a = 1 }
    else
        data.a = (data.a or 0) + 1
    end
    
    local updated = cjson.encode(data)
    local ttl = redis.call('TTL', KEYS[1])
    
    if ttl > 0 then
        redis.call('SETEX', KEYS[1], ttl, updated)
    else
        redis.call('SET', KEYS[1], updated)
    end
    
    return updated
`;

const redis = cache.client;

if (redis && typeof redis.atomicIncrement !== "function") {
    redis.defineCommand("atomicIncrement", {
        numberOfKeys: 1,
        lua: ATOMIC_INCREMENT_SCRIPT,
    });
}

/**
 * @desc Atomic increment that safely handles __NULL__ markers or missing keys.
 */
exports.atomicIncrementAndFetch = async (nonce) => {
  const key = `mfa:state:${nonce}`;
  try {
    const result = await redis.atomicIncrement(key);
    return result ? JSON.parse(result) : null;
  } catch (err) {
    Logger.error("REDIS_LUA_EXECUTION_ERROR", { key, error: err.message });
    throw err;
  }
};