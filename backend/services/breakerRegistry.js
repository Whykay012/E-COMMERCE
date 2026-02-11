const { CircuitBreaker } = require('./circuitBreaker'); // Your existing Breaker class
const logger = require("../utils/logger");

/**
 * ZENITH OMEGA - BREAKER REGISTRY
 * Centralized state management for all external service breakers.
 */
class BreakerRegistry {
    constructor() {
        this.breakers = new Map();
        this.defaults = {
            failureThreshold: 5,        // Trip after 5 failures
            resetTimeout: 30000,        // Stay open for 30 seconds
            halfOpenMaxRequests: 3,     // Allow 3 probes when half-open
            slidingWindowSize: 60000    // 60-second window
        };
    }

    /**
     * @desc Registers a new provider breaker if it doesn't exist
     */
    register(providerId, options = {}) {
        if (this.breakers.has(providerId)) {
            return this.breakers.get(providerId);
        }

        const config = { ...this.defaults, ...options, name: providerId };
        
        // We initialize with a no-op or specific service binder if needed
        const breaker = new CircuitBreaker(null, config);
        
        this.breakers.set(providerId, breaker);
        
        logger.info(`[BREAKER_REGISTRY] Registered breaker for: ${providerId}`, config);
        return breaker;
    }

    /**
     * @desc Retrieves a breaker. Auto-registers with defaults if missing.
     */
    get(providerId) {
        if (!this.breakers.has(providerId)) {
            return this.register(providerId);
        }
        return this.breakers.get(providerId);
    }

    /**
     * @desc Get a snapshot of all breaker statuses for monitoring/dashboards
     */
    getStats() {
        const stats = {};
        for (const [id, breaker] of this.breakers) {
            stats[id] = {
                state: breaker.state,
                failures: breaker.failureCount,
                nextAttempt: breaker.nextAttempt
            };
        }
        return stats;
    }
}

// Export as a Singleton
const registry = new BreakerRegistry();

// Pre-register your Notification Providers
registry.register('twilio', { failureThreshold: 3, resetTimeout: 15000 });
registry.register('aws-sns', { failureThreshold: 3 });
registry.register('sendgrid', { failureThreshold: 5 });
registry.register('postmark', { failureThreshold: 5 });

module.exports = registry;