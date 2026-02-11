"use strict";

/**
 * COSMOS HYPER-FABRIC: Redis LUA Registry
 * --------------------------------------
 * This file contains the pre-compiled LUA scripts for the Rate Limiter.
 * Pre-loading these scripts ensures atomic operations and O(1) execution time.
 */

// 1. Fixed Window Counter (FWC) - Best for high-volume spam protection
const FWC_LUA = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])

  local current = redis.call("INCR", key)
  if current == 1 then
      redis.call("EXPIRE", key, window)
  end
  local ttl = redis.call("TTL", key)
  return { current, ttl }
`;

// 2. Sliding Window Log (SWL) - Best for high-security (OTP/Auth) 
// Prevents "bursting" at the edge of window boundaries.
const SWL_LUA = `
  local key = KEYS[1]
  local max_requests = tonumber(ARGV[1])
  local window_ms = tonumber(ARGV[2])
  local penalty_ms = tonumber(ARGV[3]) or 0
  local now = redis.call("TIME")
  local now_ms = (now[1] * 1000) + math.floor(now[2] / 1000)
  local window_start = now_ms - window_ms

  -- Remove old entries
  redis.call("ZREMRANGEBYSCORE", key, 0, window_start)

  -- Count current entries
  local current_count = redis.call("ZCARD", key)

  if current_count >= max_requests then
      -- If blocked and penalty exists, push the window forward
      if penalty_ms > 0 then
          redis.call("PEXPIRE", key, penalty_ms)
      end
      return { 0, current_count + 1, redis.call("PTTL", key) }
  end

  -- Add current request
  redis.call("ZADD", key, now_ms, now_ms)
  redis.call("PEXPIRE", key, window_ms)
  
  return { 1, current_count + 1, window_ms }
`;

/**
 * In a production environment, these SHAs are generated 
 * when the Redis client connects.
 */
module.exports = {
  FWC_LUA,
  SWL_LUA,
  // These placeholders will be populated by the redisClient during boot
  FWC_SHA: null, 
  SWL_SHA: null
};