/**
 * redisMfaStore.js
 * Optimized Zenith Omega implementation
 */

// 1. Define the script once at the top level
const ATOMIC_INCREMENT_SCRIPT = `
    local current = redis.call('GET', KEYS[1])
    if not current then return nil end

    local data = cjson.decode(current)
    data.a = data.a + 1
    
    local updated = cjson.encode(data)
    local ttl = redis.call('TTL', KEYS[1])
    
    if ttl > 0 then
        redis.call('SETEX', KEYS[1], ttl, updated)
    else
        redis.call('SET', KEYS[1], updated)
    end
    
    return updated
`;

// 2. Initialize the command once when the store is loaded
// Assuming 'redis' is your ioredis instance
if (typeof redis.atomicIncrement !== "function") {
  redis.defineCommand("atomicIncrement", {
    numberOfKeys: 1,
    lua: ATOMIC_INCREMENT_SCRIPT,
  });
}

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
