// utils/retryStrategy.js (OMEGA MAGNU-X V3 - Adaptive Performance-Aware Backoff)

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)); 
const MetricLogger = require('./simpleMetricLogger'); 
const AuditLogger = require('../services/auditLogger');
const { log: auditLog } = AuditLogger;

// --- CONFIGURATION ---
const JITTER_MAX_MS = 2000;   // Maximum random component to add to the delay
const BACKOFF_BASE_MS = 100;  // Base time for the exponential calculation
const MAX_DELAY_MS = 30000;   // Absolute ceiling for the backoff delay

// --- ADAPTIVE CONTROL STATE ---
// We need a place to store state across retry calls, typically a shared cache.
// For this example, we will use a module-level variable to simulate persistent state.
let consecutiveFailures = 0; // State that persists across calls for dynamic penalty

// --- ADAPTIVE WEIGHTS ---
const FAILURE_PENALTY_MS = 1000; // Extra penalty added per consecutive failure
const FAILURE_PENALTY_CAP = 10000; // Cap the total penalty component

/**
 * Executes a function with a Performance-Aware Adaptive Retry mechanism.
 * It uses Jittered Backoff, obeys Retry-After headers, and applies an
 * additional delay penalty based on consecutive failures to slow down during an outage.
 * * @param {function} func - The asynchronous function to execute.
 * @param {number} maxRetries - Maximum number of attempts.
 * @param {number[]} retryableStatuses - Array of HTTP statuses/error codes that trigger a retry.
 * @returns {Promise<any>} The result of the successful function execution.
 * @throws {Error} The final error if all retries fail.
 */
async function retryStrategy(func, maxRetries = 3, retryableStatuses = [429, 500, 503, 504]) {
    let lastError = null;
    let attempt = 0;

    while (attempt <= maxRetries) {
        attempt++;

        try {
            // 1. Attempt Execution
            const result = await func();
            
            // 2. Success: Reset the global failure state
            if (consecutiveFailures > 0) {
                auditLog({ level: 'INFO', event: 'RETRY_SUCCESS_DECAY', details: { oldFailures: consecutiveFailures } });
            }
            consecutiveFailures = 0; 
            
            return result; // Success

        } catch (error) {
            // Store the error for eventual throwing
            lastError = error;
            const statusCode = error.response?.status || error.code;

            // 3. Determine if Retry is Warranted
            const shouldRetry = retryableStatuses.includes(statusCode);

            if (shouldRetry) {
                // FAILURE: Increment the global failure state
                consecutiveFailures++;
                
                const retryAfterHeader = error.response?.headers?.['retry-after'];
                let delayMs;
                
                if (retryAfterHeader) {
                    // --- 🔱 V1: Adaptive Rate-Limiting Awareness (Obey Hint) ---
                    const retryAfter = parseInt(retryAfterHeader, 10);
                    delayMs = (retryAfterHeader.toLowerCase().includes('ms')) ? retryAfter : retryAfter * 1000;
                    MetricLogger.reportCount('retry_hint_used', 1);

                } else {
                    // --- ⚙️ V2: Decorrelated Jittered Backoff ---
                    const exponentialDelay = Math.min(
                        MAX_DELAY_MS, 
                        BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
                    );
                    const jitter = Math.random() * JITTER_MAX_MS;
                    
                    delayMs = exponentialDelay + jitter;
                }
                
                // --- 🌟 V3: Performance-Aware Adaptive Penalty ---
                // Add a penalty based on how many times the system has failed back-to-back.
                const failurePenalty = Math.min(
                    FAILURE_PENALTY_CAP, 
                    consecutiveFailures * FAILURE_PENALTY_MS
                );

                delayMs += failurePenalty; // Apply the penalty
                delayMs = Math.max(BACKOFF_BASE_MS, delayMs); // Final safety minimum

                auditLog({ 
                    level: 'WARN', 
                    event: 'RETRY_ADAPTIVE_BACKOFF', 
                    details: { 
                        attempt, 
                        status: statusCode, 
                        consecFails: consecutiveFailures, 
                        penalty: failurePenalty, 
                        finalDelay: Math.round(delayMs) 
                    } 
                });
                MetricLogger.reportCount('retry_adaptive_penalty_applied', 1, { status: statusCode });
                MetricLogger.reportGauge('consecutive_retry_failures', consecutiveFailures); // Track penalty driver

                if (attempt <= maxRetries) {
                    await sleep(delayMs);
                    MetricLogger.reportHistogram('retry_delay_ms', Math.round(delayMs));
                    continue; // Loop for the next attempt
                }
            }

            // 4. Fail if not retryable or max retries reached
            break; 
        }
    }

    // 5. Final Failure
    MetricLogger.reportCount('retry_strategy_exhausted', 1, { finalStatus: lastError.response?.status || lastError.code });
    auditLog({ 
        level: 'ERROR', 
        event: 'RETRY_STRATEGY_FAILED', 
        details: { attempts: maxRetries, finalError: lastError.message, code: lastError.code } 
    });
    throw lastError;
}

module.exports = retryStrategy;