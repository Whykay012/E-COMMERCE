// services/rateLimiters/luaScripts.js (Centralized Enterprise Repository)

// =============================================================================
// 1. Fixed Window Counter (FWC) Script
//    (Most performant, least fair algorithm)
// =============================================================================
const RATE_LIMIT_FWC_SCRIPT = `
    local current = redis.call('INCR', KEYS[1])
    local windowSeconds = tonumber(ARGV[2])

    if current == 1 then
        redis.call('EXPIRE', KEYS[1], windowSeconds)
    end

    local ttl = redis.call('TTL', KEYS[1])

    if ttl < 0 then
        ttl = windowSeconds
    end

    -- Returns: [current_count, time_to_live_in_seconds]
    return {current, ttl}
`;

// =============================================================================
// 2. Sliding Window Log (SWL) Script - With Penalty Logic
//    (Most accurate, most fair algorithm)
// =============================================================================
const RATE_LIMIT_SWL_SCRIPT = `
    local key = KEYS[1]
    local max_requests = tonumber(ARGV[1])
    local window_ms = tonumber(ARGV[2])
    local penalty_seconds = tonumber(ARGV[3]) or 0
    
    local redis_time = redis.call('TIME')
    local current_ms = tonumber(redis_time[1]) * 1000 + (tonumber(redis_time[2]) / 1000)
    local trim_time = current_ms - window_ms

    -- Check for active Penalty Block (Key: {key}:block)
    local penalty_key = key .. ':block'
    if redis.call('EXISTS', penalty_key) == 1 then
        local ttl = redis.call('TTL', penalty_key)
        return {0, max_requests, ttl} -- DENY, Max Usage, Remaining Block Time
    end

    -- Remove expired timestamps (older than the window)
    redis.call('ZREMRANGEBYSCORE', key, 0, trim_time)
    local request_count = redis.call('ZCARD', key)

    -- Check if the limit is exceeded
    if request_count >= max_requests then
        local reset_time_ms = 0
        local oldest_ts = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        
        if oldest_ts and #oldest_ts > 1 then
            local oldest_request_time = tonumber(oldest_ts[2])
            reset_time_ms = window_ms - (current_ms - oldest_request_time)
        end
        
        if penalty_seconds > 0 then
            redis.call('SET', penalty_key, 'BLOCKED', 'EX', penalty_seconds)
            return {0, max_requests, penalty_seconds} 
        end

        return {0, request_count, math.ceil(reset_time_ms / 1000)} -- DENY
    else
        -- Allow request and add the new timestamp
        redis.call('ZADD', key, current_ms, current_ms)
        redis.call('EXPIRE', key, math.ceil(window_ms / 1000) + 1)

        return {1, request_count + 1, 0} -- ALLOW
    end
`;

// =============================================================================
// 3. Atomic Security Block/Extend Script (New Addition)
//    (Handles secure ban extension and max-TTL capping)
// =============================================================================
const ATOMIC_SET_BLOCK_SCRIPT = `
    local key = KEYS[1]
    local new_ttl = tonumber(ARGV[1])
    local max_ttl = tonumber(ARGV[2])
    
    -- Check current TTL
    local current_ttl = redis.call('TTL', key)

    -- If the key exists AND the current TTL is already >= max_ttl, deny extension.
    if current_ttl > 0 and current_ttl >= max_ttl then
        -- Return 0 (DENY/MAX REACHED) and the current_ttl
        return {0, current_ttl}
    end

    -- If the new TTL is greater than the max_ttl, cap it.
    local final_ttl = math.min(new_ttl, max_ttl)

    -- Set the key atomically, guaranteeing the expiration
    redis.call('SET', key, 'BLOCKED', 'EX', final_ttl)
    
    -- Return 1 (SUCCESS) and the final_ttl
    return {1, final_ttl}
`; 

// Map of algorithm names to their script source
const SCRIPTS = {
    FWC: RATE_LIMIT_FWC_SCRIPT,
    SWL: RATE_LIMIT_SWL_SCRIPT,
};

module.exports = {
    SCRIPTS,
    RATE_LIMIT_FWC_SCRIPT,
    RATE_LIMIT_SWL_SCRIPT,
    ATOMIC_SET_BLOCK_SCRIPT, // EXPORTED FOR THE BLOCKLIST UTILITY
};