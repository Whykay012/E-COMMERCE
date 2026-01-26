// config/appConfig.js (Resilience Adapter for PaymentService)

// 1. Import the specific, detailed configuration for the Biometric Service.
const BiometricConfig = require('./biometricConfig'); 

// 2. Define other general application settings.
// These are typical settings required by other services (e.g., Inventory, OTP, etc.).
const GeneralConfig = {
    // --- General Application Settings ---
    SYSTEM_NAME: 'Zenith-Financial-Platform',
    ENVIRONMENT: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || 8080,
    
    // --- Database Settings (Example) ---
    MONGO_URL: process.env.MONGO_URL || 'mongodb://localhost:27017/zenith_db',
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

    // --- Queue Settings ---
    GENERAL_QUEUE_NAME: 'financial_processing_queue',
    
    // --- Security Settings ---
    WEBHOOK_REPLAY_TTL_SECONDS: 24 * 3600, // 24 hours
    STEPUP_CHALLENGE_TTL_MS: 300 * 1000, // 5 minutes
};

// 3. Create the AppConfig object, merging general settings and 
// specifically mapping Biometric resilience parameters as expected by the PaymentService setup.
const AppConfig = {
    ...GeneralConfig,
    
    // 💡 Adapter Mapping for Biometric Resilience
    // These keys (e.g., MAX_CONCURRENT_BIOMETRIC_CALLS) are what the PaymentService expects
    // when setting up its concurrency limiter and circuit breaker instances.
    
    // Concurrency Limiter Configuration:
    // We map the BiometricConfig's RATE_LIMIT_CAPACITY to the Concurrency Limiter's maxConcurrent.
    MAX_CONCURRENT_BIOMETRIC_CALLS: BiometricConfig.RATE_LIMIT_CAPACITY, 
    
    // Circuit Breaker Configuration:
    // Breaker Timeout (Max time before internal retry logic gives up)
    BIOMETRIC_BREAKER_TIMEOUT_MS: BiometricConfig.HTTP_TIMEOUT_MS, 
    
    // Breaker Error Threshold (e.g., 50% error rate opens the circuit)
    BIOMETRIC_BREAKER_ERROR_THRESHOLD: BiometricConfig.CB_FAILURE_THRESHOLD, 
    
    // Breaker Reset Timeout (Time the circuit stays OPEN before transitioning to HALF-OPEN)
    BIOMETRIC_BREAKER_RESET_MS: BiometricConfig.CB_RETRY_TIMEOUT_MS, 

    // Biometric Fallback (Feature Toggle)
    ENABLE_BIOMETRIC_ASYNC_FALLBACK: BiometricConfig.ENABLE_ASYNC_FALLBACK,
};

module.exports = AppConfig;