// utils/rateLimiter.js (Policy Egress Throttler)

const Logger = require('./logger'); 
const Metrics = require('./metricsClient'); // Assuming Metrics client is available here too

/**
 * @class RateLimiter
 * @desc A simple, in-memory rate limiter designed for throttling outbound calls 
 * to external services (like PolicyClient). It uses a basic Token Bucket model,
 * where tokens are refilled based on the defined interval.
 */
class RateLimiter {
    /**
     * @param {object} options
     * @param {number} options.limit - The maximum number of requests allowed per interval.
     * @param {number} options.interval - The time period in milliseconds (e.g., 1000ms for per-second limit).
     */
    constructor({ limit, interval }) {
        if (typeof limit !== 'number' || limit <= 0) {
            throw new Error("RateLimiter must be initialized with a positive 'limit'.");
        }
        if (typeof interval !== 'number' || interval <= 0) {
            throw new Error("RateLimiter must be initialized with a positive 'interval'.");
        }

        this.maxLimit = limit;
        this.currentLimit = limit; // The dynamically adjustable limit (RPS)
        this.intervalMs = interval;
        this.tokens = limit;
        this.lastRefill = Date.now();
        
        Logger.info('EGRESS_RL_INIT', { maxLimit: limit, intervalMs: interval });
    }

    /**
     * @desc Refills the token bucket based on elapsed time since the last action.
     * @private
     */
    _refillTokens() {
        const now = Date.now();
        const elapsedMs = now - this.lastRefill;
        
        if (elapsedMs > 0) {
            // Calculate how many refill cycles (based on interval) have passed
            // We use Math.max(1) here to ensure we don't divide by zero if intervalMs is somehow zero.
            const cycles = Math.floor(elapsedMs / Math.max(1, this.intervalMs));
            
            if (cycles > 0) {
                // Tokens refill based on the current limit and the number of intervals elapsed.
                // Since the interval is 1000ms (1 second in your config), this is effectively RPS.
                const tokensToAdd = cycles * this.currentLimit;

                this.tokens = Math.min(this.currentLimit, this.tokens + tokensToAdd);
                this.lastRefill = now;
            }
        }
    }

    /**
     * @desc Checks if a request can proceed and consumes a token if possible.
     * @returns {boolean} True if the request can proceed, false otherwise.
     */
    canProceed() {
        this._refillTokens();
        
        if (this.tokens > 0) {
            this.tokens -= 1;
            Metrics.increment('policy_client.rate_limiter.proceed');
            return true;
        }
        
        Metrics.increment('policy_client.rate_limiter.throttled');
        Logger.warn('POLICY_CLIENT_THROTTLED', { limit: this.currentLimit, reason: 'Egress Rate Limit Exceeded' });
        
        // This diagram illustrates how the token bucket model works, which is the 
        // underlying mechanism for this rate limiter.
        
        
        return false;
    }

    /**
     * @desc Adjusts the current throttle limit dynamically (used by adjustRateLimitBasedOnQuota).
     * @param {number} newLimit - The new maximum requests per interval.
     */
    setLimit(newLimit) {
        if (newLimit > 0 && newLimit !== this.currentLimit) {
            this.currentLimit = newLimit;
            // When the limit changes, ensure the current tokens are capped by the new limit.
            this.tokens = Math.min(this.tokens, this.currentLimit); 
            Logger.warn('EGRESS_RL_LIMIT_ADJUSTED', { newLimit: this.currentLimit, oldLimit: this.tokens });
        }
    }
    
    /**
     * @returns {number} The current active limit (RPS in your config).
     */
    getLimit() {
        return this.currentLimit;
    }

    /**
     * @returns {number} The estimated number of available requests right now.
     */
    getRemaining() {
        this._refillTokens();
        return Math.floor(this.tokens);
    }
}

module.exports = RateLimiter;