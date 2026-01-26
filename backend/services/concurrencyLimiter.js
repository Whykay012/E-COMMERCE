// utils/concurrencyLimiter.js (OMEGA MAGNU-X V2 - Adaptive & Observable Concurrency Limiter)

const MetricLogger = require('./simpleMetricLogger'); 
const AuditLogger = require('../services/auditLogger');
const { log: auditLog } = AuditLogger;

// Custom Error for explicit rejection
class ConcurrencyLimitError extends Error {
    constructor(message, code = "CONCURRENCY_LIMIT_EXCEEDED") {
        super(message);
        this.name = 'ConcurrencyLimitError';
        this.code = code;
    }
}

/**
 * The Concurrency Limiter manages a fixed pool of active slots, providing fair
 * access via a waiting queue. It is superior to Token Bucket for managing
 * backend resource load (threads, connections).
 */
class ConcurrencyLimiter {
    /**
     * @param {number} initialMaxConcurrent - The starting maximum number of concurrent requests allowed.
     * @param {string} name - The name for logging and metrics (e.g., 'BiometricServiceConcurrency').
     */
    constructor(initialMaxConcurrent, name = 'AdaptiveConcurrencyLimiter') {
        this.initialMaxConcurrent = initialMaxConcurrent;
        this.maxConcurrent = initialMaxConcurrent; // Dynamic control point
        this.name = name;
        this.activeSlots = 0; // Number of currently executing tasks
        this.waitQueue = [];  // Queue of waiting Promise resolvers (FIFO for simplicity)
        this.metricName = `concurrency_${name.toLowerCase()}`;
        
        auditLog({ 
            level: 'INFO', 
            event: 'CONCURRENCY_INIT', 
            details: { name: this.name, max: this.maxConcurrent }
        });
    }

    /**
     * Attempts to acquire a concurrency slot. If all slots are full, the request
     * is placed in a waiting queue for fairness, or rejected if the wait exceeds the timeout.
     * * @param {number} timeoutMs - Maximum time in milliseconds to wait for a slot.
     * @returns {Promise<void>} Resolves when a slot is acquired.
     * @throws {ConcurrencyLimitError} If the timeout is reached.
     */
    async acquireSlot(timeoutMs = 5000) {
        const startTime = process.hrtime.bigint(); // High-resolution timer for queue delay

        // 1. Check if a slot is immediately available
        if (this.activeSlots < this.maxConcurrent) {
            this.activeSlots++;
            MetricLogger.reportGauge(this.metricName, this.activeSlots);
            // Report 0ms delay for immediate acquisition
            MetricLogger.reportHistogram(`${this.metricName}_queue_delay_ms`, 0); 
            return;
        }

        // 2. If no slot, enqueue the request and wait
        MetricLogger.reportCount(`${this.metricName}_queued_total`, 1);
        
        return new Promise((resolve, reject) => {
            let timeoutId;

            // Define the entry handlers
            const entry = { 
                resolve: () => {
                    clearTimeout(timeoutId);
                    
                    // --- 💡 OBSERVABILITY UPGRADE: Log Queue Delay ---
                    const endTime = process.hrtime.bigint();
                    const delayMs = Number(endTime - startTime) / 1000000;
                    MetricLogger.reportHistogram(`${this.metricName}_queue_delay_ms`, Math.round(delayMs)); 
                    // ----------------------------------------------------

                    this.activeSlots++; // Acquire slot when resolved from queue
                    MetricLogger.reportGauge(this.metricName, this.activeSlots);
                    resolve();
                },
                reject: (error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                }
            };
            
            this.waitQueue.push(entry);
            MetricLogger.reportGauge(`${this.metricName}_queue_length`, this.waitQueue.length);

            // Set up the timeout mechanism
            timeoutId = setTimeout(() => {
                // Remove this entry from the queue if the timeout fires
                const index = this.waitQueue.indexOf(entry);
                if (index > -1) {
                    this.waitQueue.splice(index, 1);
                    MetricLogger.reportGauge(`${this.metricName}_queue_length`, this.waitQueue.length);
                }
                
                MetricLogger.reportCount(`${this.metricName}_queue_timeout`, 1);
                entry.reject(new ConcurrencyLimitError(
                    `Failed to acquire slot for ${this.name}: Queue timeout after ${timeoutMs}ms. Max concurrent: ${this.maxConcurrent}`,
                    "CONCURRENCY_QUEUE_TIMEOUT"
                ));
            }, timeoutMs);
        });
    }

    /**
     * Releases a concurrency slot, decrementing the active count and attempting
     * to pull the next waiting request from the queue.
     */
    releaseSlot() {
        if (this.activeSlots <= 0) {
            auditLog({ 
                level: 'CRITICAL', 
                event: 'SLOT_RELEASE_ERROR', 
                details: { name: this.name, message: 'Attempted to release slot when activeSlots was zero.' } 
            });
            return; 
        }

        // 1. Decrement the active slot count
        this.activeSlots--;
        
        // 2. Check the waiting queue
        if (this.waitQueue.length > 0) {
            // FIFO fairness: Resolve the oldest waiting request
            const nextEntry = this.waitQueue.shift();
            MetricLogger.reportGauge(`${this.metricName}_queue_length`, this.waitQueue.length);
            
            // This calls the entry.resolve(), which increments activeSlots and logs delay.
            nextEntry.resolve();
            MetricLogger.reportCount(`${this.metricName}_queue_resolved`, 1);

        } else {
            // No one is waiting, simply update the gauge
            MetricLogger.reportGauge(this.metricName, this.activeSlots);
        }
    }

    // --- 🔱 ADAPTIVE CONTROL UPGRADES ---

    /**
     * Dynamically adjusts the maximum allowed concurrency. Used by an external
     * feedback mechanism (e.g., an internal performance monitor).
     * @param {number} newMax - The new maximum concurrent value. Must be positive.
     * @returns {void}
     */
    setMaxConcurrent(newMax) {
        if (newMax <= 0 || isNaN(newMax)) {
            auditLog({ level: 'ERROR', event: 'ADAPTIVE_LIMIT_REJECTED', details: { name: this.name, value: newMax, message: 'New max concurrency must be positive.' } });
            return;
        }

        const oldMax = this.maxConcurrent;
        this.maxConcurrent = Math.round(newMax); // Ensure integer

        if (this.maxConcurrent !== oldMax) {
            auditLog({ 
                level: 'WARN', 
                event: 'ADAPTIVE_LIMIT_CHANGED', 
                details: { name: this.name, old: oldMax, new: this.maxConcurrent, active: this.activeSlots }
            });
            
            // If we increase the limit, resolve any waiting requests that can now fit.
            if (this.maxConcurrent > oldMax && this.activeSlots < this.maxConcurrent) {
                this._processWaitingQueue();
            }
        }
    }
    
    /**
     * Internal function to check for and resolve waiting requests after a change
     * in concurrency limit or a slot release.
     */
    _processWaitingQueue() {
        // Resolve as many waiting requests as there are free slots.
        while (this.activeSlots < this.maxConcurrent && this.waitQueue.length > 0) {
            const nextEntry = this.waitQueue.shift();
            MetricLogger.reportGauge(`${this.metricName}_queue_length`, this.waitQueue.length);
            
            // nextEntry.resolve() will handle incrementing activeSlots and logging.
            nextEntry.resolve(); 
            MetricLogger.reportCount(`${this.metricName}_queue_resolved`, 1);
        }
    }

    /**
     * @returns {object} Current state information.
     */
    getStatus() {
        return {
            name: this.name,
            maxConcurrent: this.maxConcurrent,
            initialMaxConcurrent: this.initialMaxConcurrent,
            activeSlots: this.activeSlots,
            waitingRequests: this.waitQueue.length,
            utilization: (this.activeSlots / this.maxConcurrent),
            freeSlots: this.maxConcurrent - this.activeSlots
        };
    }
}

module.exports = {
    ConcurrencyLimiter,
    ConcurrencyLimitError
};