// config/biometricConfig.js (MAGNUS OMEGA FINAL)

const Config = {
    // --- Biometric API & Business Logic Settings ---
    
    // API Endpoint and Key
    BIOMETRIC_ENDPOINT: process.env.BIOMETRIC_ENDPOINT || 'http://default-biometric-api.com',
    BIOMETRIC_API_KEY: process.env.BIOMETRIC_API_KEY,
    HTTP_TIMEOUT_MS: 15000,
    
    // Business Logic Thresholds
    MATCH_SCORE_THRESHOLD: 0.98,
    LIVENESS_SCORE_THRESHOLD: 0.90,

    // --- Resilience Settings (Retry & Rate Limiting) ---
    
    // Retry Strategy
    RETRY_COUNT: 3,
    RETRYABLE_STATUSES: [429, 500, 503, 504],
    
    // Token Bucket Rate Limiter
    RATE_LIMIT_CAPACITY: 10,
    RATE_LIMIT_FILL_RATE_PER_SEC: 5,
    RATE_LIMIT_WAIT_MS: 5000, // New: Max time (ms) to wait for a token before throwing an error.

    // --- Circuit Breaker Settings (Sliding Window Model) ---
    
    // CB_FAILURE_THRESHOLD (Consecutive Count Model) is replaced by % error rate
    // We retain the name for compatibility but define it as a percentage threshold.
    CB_FAILURE_THRESHOLD: 50,      // Threshold for opening the circuit (e.g., 50% error rate).
    CB_WINDOW_SIZE: 100,           // Number of requests in the sliding window to evaluate the rate.
    CB_RETRY_TIMEOUT_MS: 60000,    // Time (ms) to wait in the OPEN state before transitioning to HALF-OPEN.
    
    // --- Adaptive Resilience (Xenith Asynchronous Fallback Mode) ---
    
    // Feature Toggle
    ENABLE_ASYNC_FALLBACK: process.env.ENABLE_ASYNC_FALLBACK === 'true',
    
    // Queue Destination
    ASYNC_QUEUE_ENDPOINT: process.env.ASYNC_QUEUE_ENDPOINT || '/submit_for_batch',
    
    // Hysteresis: Time (ms) to remain in the fallback state even after the primary service recovers, 
    // ensuring stability and avoiding rapid transition ("flapping").
    HYSTERESIS_TIMEOUT_MS: 5000, 
};

// Allows runtime override for testing/staging
module.exports = Config;