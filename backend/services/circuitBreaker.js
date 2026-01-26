// services/circuitBreaker.js (TITAN NEXUS v4.0 - Zenith Observability & Adaptive Resilience)

// Conceptual Imports for a Production Environment
const logger = require("../config/logger");
const Metrics = require("../utils/metricsClient");
const Tracing = require("../utils/tracingClient");
// const EventEmitter = require('events'); // Conceptual: For event emission

/**
 * @typedef {'CLOSED' | 'OPEN' | 'HALF_OPEN'} CircuitState
 */
const STATES = {
    CLOSED: 'CLOSED',
    OPEN: 'OPEN',
    HALF_OPEN: 'HALF_OPEN'
};

// --- Custom Errors (Retained) ---
class ServiceUnavailableError extends Error {
    constructor(message, name) {
        super(message);
        this.name = 'ServiceUnavailableError';
        this.breakerName = name;
        this.code = 'EOPENBREAKER';
    }
}

class BreakerTimeoutError extends Error {
    constructor(name) {
        super(`Circuit Breaker Timeout for service: ${name}`);
        this.name = 'BreakerTimeoutError';
        this.breakerName = name;
        this.code = 'ETIMEOUTBREAKER';
    }
}

/**
 * @typedef {object} RequestOutcome
 * @property {boolean} success - True if the call succeeded, false otherwise.
 * @property {string} [errorType] - The class name of the error (e.g., 'BreakerTimeoutError', 'DbConnectionError').
 */

/**
 * @class CircuitBreaker
 * @augments EventEmitter (Conceptual)
 * @desc Implements the Sliding Window Circuit Breaker pattern for maximum resilience and observability.
 */
class CircuitBreaker /* extends EventEmitter */ {

    /**
     * @param {function(...args: any[]): Promise<any>} action - The async function to protect.
     * @param {object} [options] - Configuration options.
     * @param {string} [options.name] - Breaker name for logging/metrics.
     * @param {number} [options.windowSize=100] - Number of recent calls to track for error rate calculation.
     * @param {number} [options.minimumRequestThreshold=10] - Minimum number of calls needed in the window to consider tripping.
     * @param {number} [options.errorPercentageThreshold=50] - Error percentage (0-100) to trip the circuit.
     * @param {number} [options.resetTimeout=60000] - Time (ms) to wait in OPEN state before transitioning to HALF-OPEN.
     * @param {number} [options.timeout=5000] - Internal timeout (ms) for the protected action.
     * @param {number} [options.halfOpenSuccessThreshold=2] - Required consecutive successful calls in HALF-OPEN to close the circuit.
     * @param {number} [options.resetTimeoutJitter=0.1] - Percentage of randomness to apply to resetTimeout (0-1).
     */
    constructor(action, options = {}) {
        // super(); // Conceptual: Initialize EventEmitter

        this.action = action;
        this.name = options.name || action.name || 'AnonymousBreaker';
        /** @type {CircuitState} */
        this.state = STATES.CLOSED;
        
        this.lastFailureTime = 0;
        this.lastSuccessTime = Date.now();
        this.successCount = 0; // Success counter for HALF-OPEN state

        // Sliding Window Configuration
        this.windowSize = options.windowSize || 100;
        /** @type {RequestOutcome[]} */
        this.requestLog = []; 
        this.minimumRequestThreshold = options.minimumRequestThreshold || 10; 
        this.errorPercentageThreshold = options.errorPercentageThreshold || 50;
        
        // General Configuration
        this.resetTimeout = options.resetTimeout || 60000;
        this.timeout = options.timeout || 5000;
        this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold || 2; 
        this.resetTimeoutJitter = options.resetTimeoutJitter || 0.1; 
        
        this.metricTags = { breaker: this.name };
        
        this.calculateErrorRate(); 
    }

    /**
     * @private
     * @desc Calculates the error rate based on the current sliding window log.
     */
    calculateErrorRate() {
        const totalRequests = this.requestLog.length;
        let failureCount = 0;
        
        if (totalRequests === 0) {
            this.errorRate = 0;
            this.totalRequests = 0;
            return;
        }

        failureCount = this.requestLog.filter(r => !r.success).length;
        
        this.errorRate = (failureCount / totalRequests) * 100;
        this.totalRequests = totalRequests;

        // 📊 Emit Window Metrics
        Metrics.gauge('circuit_breaker.window_total', totalRequests, this.metricTags);
        Metrics.gauge('circuit_breaker.window_errors', failureCount, this.metricTags);
        Metrics.gauge('circuit_breaker.error_rate_pct', this.errorRate, this.metricTags);
    }
    
    /**
     * @private
     * @param {boolean} success - Whether the call succeeded.
     * @param {Error} [error] - The error object if failure occurred.
     * @desc Records the outcome of a call into the sliding window.
     */
    recordWindowOutcome(success, error) {
        /** @type {RequestOutcome} */
        const outcome = { success };
        if (!success && error) {
            // 💡 DETAIL: Track the specific type of error
            outcome.errorType = error.name; 
        }

        this.requestLog.push(outcome);
        if (this.requestLog.length > this.windowSize) {
            this.requestLog.shift();
        }
        this.calculateErrorRate();
    }

    /**
     * @private
     * @param {...any} args - Arguments to pass to the protected function.
     * @returns {Promise<any>}
     * @desc Executes the protected function with internal timeout and cleanup.
     */
    async callProtectedAction(...args) {
        if (this.timeout <= 0) {
            return this.action(...args);
        }
        
        let timeoutHandle;
        
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new BreakerTimeoutError(this.name)), this.timeout);
        });

        try {
            const result = await Promise.race([
                this.action(...args),
                timeoutPromise
            ]);
            clearTimeout(timeoutHandle);
            return result;
        } catch (error) {
            clearTimeout(timeoutHandle);
            throw error;
        }
    }

    /**
     * @param {...any} args - Arguments to pass to the protected function.
     * @returns {Promise<any>}
     * @desc Main entry point for executing the protected service.
     */
    async execute(...args) {
        const startTime = Date.now();
        let result;
        
        try {
            result = await Tracing.withSpan(`circuit_breaker.${this.name}.execute`, async (span) => {

                span.setAttribute('circuit.state', this.state);
                span.setAttribute('circuit.error_rate_pct', this.errorRate.toFixed(1));

                if (this.state === STATES.OPEN) {
                    const timeSinceFailure = Date.now() - this.lastFailureTime;
                    
                    if (timeSinceFailure > this.getJitteredResetTimeout()) {
                        this.transition(STATES.HALF_OPEN);
                    } else {
                        Metrics.increment('circuit_breaker.reject', 1, { ...this.metricTags, reason: 'open' });
                        throw new ServiceUnavailableError(
                            `Circuit Breaker is OPEN for ${this.name}. Wait time remaining: ${(this.getJitteredResetTimeout() - timeSinceFailure) / 1000}s.`,
                            this.name
                        );
                    }
                }

                if (this.state === STATES.HALF_OPEN) {
                    Metrics.increment('circuit_breaker.attempt', 1, { ...this.metricTags, state: 'half_open' });
                    try {
                        const actionResult = await this.callProtectedAction(...args);
                        this.handleHalfOpenSuccess();
                        return actionResult;
                    } catch (error) {
                        this.handleFailure(error, false); // No window record in HALF-OPEN
                        this.transition(STATES.OPEN); 
                        throw error;
                    }
                }
                
                // State is CLOSED
                Metrics.increment('circuit_breaker.attempt', 1, { ...this.metricTags, state: 'closed' });
                try {
                    const actionResult = await this.callProtectedAction(...args);
                    this.handleSuccess(true);
                    return actionResult;
                } catch (error) {
                    this.handleFailure(error, true);
                    throw error;
                }
            });
        } catch (error) {
            throw error;
        } finally {
            const duration = Date.now() - startTime;
            Metrics.timing('circuit_breaker.latency_ms', duration, { ...this.metricTags, state: this.state });
        }
        
        return result;
    }
    
    /**
     * @private
     * @returns {number} The jittered timeout value.
     */
    getJitteredResetTimeout() {
        // Jitter is a good practice to avoid thundering herd problem
        const jitter = this.resetTimeout * this.resetTimeoutJitter * (Math.random() * 2 - 1);
        return this.resetTimeout + jitter;
    }
    
    /**
     * @private
     * @param {boolean} recordToWindow - Should the success be recorded in the sliding window.
     */
    handleSuccess(recordToWindow) {
        this.lastSuccessTime = Date.now();
        Metrics.increment('circuit_breaker.success', 1, this.metricTags);
        
        if (recordToWindow) {
            this.recordWindowOutcome(true);
        }
    }

    /**
     * @private
     * @desc Handles successful call when the state is HALF-OPEN.
     */
    handleHalfOpenSuccess() {
        this.successCount++;
        this.handleSuccess(false);
        Metrics.gauge('circuit_breaker.half_open_successes', this.successCount, this.metricTags);
        
        if (this.successCount >= this.halfOpenSuccessThreshold) {
            this.transition(STATES.CLOSED);
            this.resetCounters(); 
        } else {
            logger.info(`Breaker ${this.name}: Half-Open success (${this.successCount}/${this.halfOpenSuccessThreshold}).`);
        }
    }

    /**
     * @private
     * @param {Error} error - The error that occurred.
     * @param {boolean} recordToWindow - Should the failure be recorded in the sliding window.
     */
    handleFailure(error, recordToWindow) {
        this.lastFailureTime = Date.now();
        this.successCount = 0;
        
        const isTimeout = error instanceof BreakerTimeoutError;
        
        logger.warn(`Breaker ${this.name}: Failure recorded. Type: ${error.name}.`, { error: error.message });
        
        Metrics.increment('circuit_breaker.failure', 1, this.metricTags);
        if (isTimeout) {
            Metrics.increment('circuit_breaker.timeout', 1, this.metricTags);
        }
        
        if (recordToWindow) {
            this.recordWindowOutcome(false, error);
            
            // 💡 SLIDING WINDOW TRIP LOGIC
            if (this.totalRequests >= this.minimumRequestThreshold && this.errorRate >= this.errorPercentageThreshold) {
                this.transition(STATES.OPEN);
                logger.error(`Breaker ${this.name}: TRIP! Error Rate: ${this.errorRate.toFixed(1)}% (Threshold: ${this.errorPercentageThreshold}%) over ${this.totalRequests} calls.`);
                // this.emit('circuitOpen', { name: this.name, errorRate: this.errorRate }); // Conceptual Event Emission
            }
        }
    }

    /**
     * @private
     * @desc Resets the window and counters used for state calculation.
     */
    resetCounters() {
        this.requestLog = [];
        this.successCount = 0;
        this.errorRate = 0;
        this.totalRequests = 0;
        logger.info(`Breaker ${this.name}: Counters reset.`);
        Metrics.gauge('circuit_breaker.half_open_successes', 0, this.metricTags);
    }

    /**
     * @private
     * @param {CircuitState} newState - The state to transition to.
     * @desc Changes the state of the circuit breaker.
     */
    transition(newState) {
        if (this.state !== newState) {
            const oldState = this.state;
            logger.warn(`Breaker ${this.name}: State change: ${oldState} -> ${newState}`);
            this.state = newState;
            
            Metrics.increment('circuit_breaker.state_change', 1, { 
                ...this.metricTags, 
                from: oldState.toLowerCase(), 
                to: newState.toLowerCase() 
            });

            if (newState === STATES.OPEN) {
                this.resetCounters();
            } else if (newState === STATES.CLOSED) {
                this.resetCounters();
            } else if (newState === STATES.HALF_OPEN) {
                this.successCount = 0;
            }
            // this.emit('stateChange', { name: this.name, oldState, newState }); // Conceptual Event Emission
        }
    }

    /**
     * @returns {CircuitState}
     * @desc Public method to check the current state.
     */
    getState() {
        return this.state;
    }
}

module.exports = {
    CircuitBreaker,
    ServiceUnavailableError,
    BreakerTimeoutError
};