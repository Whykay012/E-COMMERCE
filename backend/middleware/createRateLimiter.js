// services/rateLimiters/rateLimiterFactory.js (V3: PRE-LOADED SCRIPT & DEPENDENCY INJECTION)

const Logger = require("../utils/logger"); // Assume real logger utility
const Tracing = require("../utils/tracingClient"); // Assume tracing utility

// =============================================================================
// LUA SCRIPT FOR ATOMIC RATE LIMIT COUNTING (Fixed Window Counter - FWC)
// =============================================================================

// IMPORTANT: This script is now static and must be pre-loaded at application startup.
const RATE_LIMIT_FWC_SCRIPT = `
    local current = redis.call('INCR', KEYS[1])

    if current == 1 then
        -- Set TTL only on the first request to reset the window
        redis.call('EXPIRE', KEYS[1], ARGV[2])
    end

    local ttl = redis.call('TTL', KEYS[1])

    -- If TTL is < 0 (key exists but has no expire or doesn't exist yet), use the windowSeconds
    if ttl < 0 then
        ttl = tonumber(ARGV[2])
    end

    -- Returns: [current_count, time_to_live_in_seconds]
    return {current, ttl}
`;

// =============================================================================
// RATE LIMITER FACTORY
// =============================================================================

/**
 * Creates a highly efficient, production-ready rate limiting middleware.
 * @param {object} dependencies - Injected dependencies (Redis client, blocklist utils, pre-loaded SHA).
 * @param {string} dependencies.scriptSha - The SHA1 hash of the pre-loaded FWC script.
 * @param {object} dependencies.redisClient - The initialized and ready Redis client instance.
 * @param {function} dependencies.temporarilyBlock - Blocklist utility function.
 * @param {function} dependencies.isBlocked - Blocklist utility function.
 * @returns {function} Factory function that takes config and returns the middleware.
 */
function createRateLimiterFactory({ scriptSha, redisClient, temporarilyBlock, isBlocked }) {
    if (!scriptSha || !redisClient || redisClient.status !== "ready") {
        throw new Error("RateLimiter Factory requires a pre-loaded scriptSha and a ready Redis client.");
    }

    /**
     * @param {object} config - Configuration options for the limiter.
     * @returns {function} Express middleware function.
     */
    return function createLimiter({
        windowSeconds = 60,
        max = 120,
        keyPrefix = "rl",
        identifierFn,
        blockOnExceed = { enabled: false, banSeconds: 300 },
        softBanDelayMs = 0,
    } = {}) {
        
        // 1. Robust identifier function (remains the same)
        const getIdentifier = identifierFn || ((req) => {
            if (req.user && (req.user._id || req.user.id)) {
                return `user:${req.user._id ? req.user._id.toString() : req.user.id.toString()}`;
            }
            const ip = req.headers['x-forwarded-for']?.split(',').shift() || req.ip || req.connection.remoteAddress;
            return `ip:${ip || "unknown"}`;
        });
        
        // 2. The core middleware function
        return async function rateLimiter(req, res, next) {
            const span = Tracing.startSpan('rateLimiterMiddleware');

            try {
                const identifier = getIdentifier(req);
                const blockKey = identifier; 
                span.setAttribute('rateLimit.identifier', identifier);

                // --- 3. Immediate Blocklist Check (Traced) ---
                if (await isBlocked(redisClient, blockKey)) {
                    span.setAttribute('rateLimit.result', 'BLOCKED');
                    res.setHeader("Retry-After", String(blockOnExceed.banSeconds || 300));
                    return res.status(429).json({
                        status: "fail",
                        message: "Temporarily blocked due to abusive activity.",
                    });
                }

                const limitKey = `${keyPrefix}:${identifier}`;
                
                // --- 4. Atomic Rate Limit Check (EVALSHA for extreme performance) ---
                // EVALSHA is faster as it only sends the SHA1 hash instead of the whole script.
                const [currentCountStr, ttlStr] = await redisClient.evalsha(
                    scriptSha,
                    1, // 1 key
                    limitKey, // KEYS[1]
                    max, // ARGV[1] (Contextual, but necessary for the final check)
                    windowSeconds // ARGV[2]
                );

                const current = Number(currentCountStr);
                const ttl = Number(ttlStr);
                const remaining = Math.max(0, max - current);
                const resetIn = ttl > 0 ? ttl : windowSeconds;
                const exceeded = current > max;
                
                span.setAttribute('rateLimit.current', current);
                span.setAttribute('rateLimit.remaining', remaining);
                span.setAttribute('rateLimit.exceeded', exceeded);

                // --- 5. Set Standard Headers (RFC 6585) ---
                res.setHeader("X-RateLimit-Limit", String(max));
                res.setHeader("X-RateLimit-Remaining", String(remaining));
                res.setHeader("X-RateLimit-Reset", String(resetIn)); 

                // --- 6. Logging & Exceeded Logic ---
                if (exceeded) {
                    Logger.warn('RATE_LIMIT_EXCEEDED', { 
                        identifier, route: req.originalUrl, max, current, resetIn 
                    });

                    // a) Apply hard ban if configured (Using the provided utility)
                    if (blockOnExceed && blockOnExceed.enabled) {
                        await temporarilyBlock(redisClient, blockKey, blockOnExceed.banSeconds || 300);
                        span.setAttribute('rateLimit.banApplied', true);
                    }

                    // b) Apply soft ban/delay if configured (non-blocking yield)
                    if (softBanDelayMs > 0) {
                        await new Promise((r) => setTimeout(r, softBanDelayMs));
                        span.setAttribute('rateLimit.softDelayMs', softBanDelayMs);
                    }

                    // c) Respond with 429
                    res.setHeader("Retry-After", String(resetIn));
                    res.status(429).json({
                        status: "fail",
                        code: "RATE_LIMIT_EXCEEDED",
                        message: `Rate limit exceeded. Try again in ${resetIn} seconds.`,
                    });
                    span.end();
                    return;
                }

                // --- 7. Allow Request ---
                span.end();
                return next();

            } catch (err) {
                // FAIL-OPEN (Graceful Degradation): Allow request if Redis is having operational issues
                span.recordError(err);
                span.setAttribute('rateLimit.result', 'FAIL_OPEN');
                Logger.critical("RATE_LIMITER_CRITICAL_FAILURE_FAIL_OPEN", { error: err.message, route: req.originalUrl });
                span.end();
                return next();
            }
        };
    };
}

// Export the script source for pre-loading and the factory function
module.exports = { 
    RATE_LIMIT_FWC_SCRIPT,
    createRateLimiterFactory 
};