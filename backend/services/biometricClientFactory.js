// services/biometricClientFactory.js (OMEGA MAGNU-X EDITION - FINAL REFACTOR)

const createBiometricClient = require('../clients/biometricHttpClient');
const retryStrategy = require('../utils/retryStrategy');
const MetricLogger = require('../utils/simpleMetricLogger'); // Advanced Metric Client
const AuditLogger = require('../services/auditLogger');
const Config = require('../config/biometricConfig');
const crypto = require('crypto');
const { log: auditLog } = AuditLogger;

// 💡 CRITICAL FIX: Resilience Dependencies & Errors
const { ConcurrencyLimiter, ConcurrencyLimitError } = require('../utils/concurrencyLimiter'); 
const { 
    CircuitBreaker, 
    ServiceUnavailableError, 
    BreakerTimeoutError 
} = require('../utils/circuitBreaker'); 

// 💡 Dependency Restoration: Idempotency Persistence Layer
const { persistResponse, getCachedResponse } = require('./idempotencyService'); 

// Custom Error (Remains centralized)
class BiometricVerificationError extends Error {
 constructor(message, code, providerDetails = {}) {
  super(message);
  this.name = 'BiometricVerificationError';
  this.code = code;
  this.providerDetails = providerDetails;
 }
}

/**
* @typedef {object} BiometricClientDependencies
* @property {ConcurrencyLimiter} concurrencyLimiterInstance - The pre-configured Concurrency Limiter.
* @property {CircuitBreaker} circuitBreakerInstance - The pre-configured Sliding Window Circuit Breaker instance.
*/

const IDEMPOTENCY_STEP_NAME = "biometric_kyc"; 

// --- HMAC UTILITY ---
/**
* Creates an HMAC-SHA256 signature for the request body.
* @param {string} body - The JSON stringified body of the request.
* @param {string} secret - The secret key (e.g., API Key)
* @returns {string} The HMAC signature.
*/
const generateHmacSignature = (body, secret) => {
 return crypto.createHmac('sha256', secret)
    .update(body)
    .digest('hex');
};
// --- END HMAC UTILITY ---

// --- FACTORY FUNCTION ---
function createBiometricClientService(dependencies) {
 // 💡 CRITICAL FIX: Destructure the correct dependency name
 const { concurrencyLimiterInstance, circuitBreakerInstance } = dependencies; 

 // Internal HTTP Client Setup (fully instrumented via interceptors)
 const httpClient = createBiometricClient({
  endpoint: Config.BIOMETRIC_ENDPOINT,
  apiKey: Config.BIOMETRIC_API_KEY,
  timeout: Config.HTTP_TIMEOUT_MS,
 }, { 
  auditLogger: AuditLogger,
  metricLogger: MetricLogger 
 });

 const generateIdempotencyKey = (userId, livenessVideoBase64) => {
  const input = `${userId}:${crypto.createHash('sha256').update(livenessVideoBase64).digest('hex').substring(0, 16)}`;
  return crypto.createHash('sha256').update(input).digest('hex');
 };
 
 // 💡 HYSTERESIS CONTROL VARIABLES (Encapsulated)
 let asyncFallbackHysteresisActive = false;
 let fallbackDeactivationTimeout = null;
 
 // --- CORE EXECUTION PIPELINE FUNCTION ---
 /**
 * Executes the verification request wrapped in Circuit Breaker and Retries.
 * @param {object} requestData 
 * @param {string} idempotencyKey
 */
 const executeVerificationPipeline = (requestData, idempotencyKey) => async () => {
  const requestBodyString = JSON.stringify(requestData);
  
  // 🛡️ SECURITY UPGRADE: HMAC Signature Generation
  const hmacSignature = generateHmacSignature(requestBodyString, Config.BIOMETRIC_API_SECRET_KEY || Config.BIOMETRIC_API_KEY);
  
  /**
     * The innermost function: Actual network call with business validation.
     * This is the function that the Retry Strategy will attempt multiple times.
     */
  const executeVerification = async () => {
   const response = await httpClient.post(`/verify`, requestData, {
    headers: {
     'Content-Type': 'application/json',
     'X-Request-HMAC': hmacSignature, 
     'X-Idempotency-Key': idempotencyKey 
    }
   });

   const providerData = response.data;
   const scoreDetails = { score: providerData.liveness_score, matchScore: providerData.match_score };
   
   if (!providerData.is_live || providerData.liveness_score < Config.LIVENESS_SCORE_THRESHOLD) {
    MetricLogger.reportCount('biometric.service.failure', 1, { reason: 'LIVENESS_FAIL' });
    throw new BiometricVerificationError(
     `Liveness check failed (Score: ${providerData.liveness_score}).`,
     "LIVENESS_FAIL",
     scoreDetails
    );
   }

   if (!providerData.match_success || providerData.match_score < Config.MATCH_SCORE_THRESHOLD) {
    MetricLogger.reportCount('biometric.service.failure', 1, { reason: 'MATCH_FAIL' });
    throw new BiometricVerificationError(
     `Face match failed (Score: ${providerData.match_score}).`,
     "MATCH_FAIL",
     scoreDetails
    );
   }
   
   // Success path
   return { success: true, score: providerData.match_score, providerId: providerData.verification_id, providerData };
  };
  
    /**
     * The component that is passed to the Circuit Breaker:
     * This function wraps the execution with the Adaptive Retry Strategy.
     */
    const retryWrapper = async () => {
        return await retryStrategy(executeVerification, Config.RETRY_COUNT, Config.RETRYABLE_STATUSES);
    };

    // 4. Execution via Circuit Breaker
  const result = await circuitBreakerInstance.execute(retryWrapper);

    // If circuitBreaker.execute succeeds, the call succeeded (potentially after retries)
  // 💡 CORRECTED: Removed the incorrect 'circuitBreakerInstance.success()' call.
    // The success is logged/recorded inside circuitBreakerInstance.execute().
    
  MetricLogger.reportCount('biometric.service.success', 1);

  // 5. Success Hysteresis Deactivation
  if (asyncFallbackHysteresisActive) {
   clearTimeout(fallbackDeactivationTimeout);
   fallbackDeactivationTimeout = setTimeout(() => {
    asyncFallbackHysteresisActive = false;
    auditLog({ level: 'INFO', event: 'ASYNC_FALLBACK_HYSTERESIS_OFF', details: { service: circuitBreakerInstance.name } });
   }, Config.HYSTERESIS_TIMEOUT_MS || 5000); 
  }

  return result;
 };
 // --- END CORE EXECUTION PIPELINE FUNCTION ---


 const BiometricClient = {
  testMode: false,

  verifyLivenessAndMatch: async (userId, livenessVideoBase64) => {
   
   if (BiometricClient.testMode) {
    MetricLogger.reportCount('biometric.service.mock_success', 1);
    return { success: true, score: 0.99, providerId: 'MOCK_ID_TEST_MODE' };
   }

   if (!Config.BIOMETRIC_ENDPOINT || !Config.BIOMETRIC_API_KEY) {
    throw new BiometricVerificationError("Biometric client not fully configured.", "CONFIG_MISSING");
   }
   
   const idempotencyKey = generateIdempotencyKey(userId, livenessVideoBase64);

   // 1. ULTRA-EFFICIENT IDEMPOTENCY CHECK
   const cachedItem = await getCachedResponse(idempotencyKey, IDEMPOTENCY_STEP_NAME);
   if (cachedItem) {
    MetricLogger.reportCount('idempotency.client.cache_hit', 1);
    auditLog({ level: 'INFO', event: 'BIOMETRIC_REPLAYED_FROM_CACHE', details: { userId, key: idempotencyKey } });
    return cachedItem.body; 
   }

   let slotAcquired = false; // Flag to ensure release on failure
   
   // 2. 🛡️ CRITICAL FIX: CONCURRENCY LIMITER ACQUISITION (Try...Finally Pattern)
   try {
    // Acquire slot. If full, request waits in the queue until timeout.
    await concurrencyLimiterInstance.acquireSlot(Config.RATE_LIMIT_WAIT_MS || 3000); 
    slotAcquired = true; // Mark slot as acquired only on success

   } catch (error) {
    // Catch ConcurrencyLimitError (Queue timeout or max concurrent exceeded)
    if (error instanceof ConcurrencyLimitError) {
     MetricLogger.reportCount('client.throttled.concurrency', 1);
     throw new BiometricVerificationError(`Client-side concurrency limit exceeded.`, "CLIENT_THROTTLED_CONCURRENCY");
    }
    throw error; 
   }

   const requestData = {
    user_reference: userId,
    data: livenessVideoBase64,
    nonce: Date.now().toString(),
    challenge: ["turn_head", "smile", "open_mouth"]
   };

   // --- EXECUTION POINT: CALL THE PIPELINE ---
   try {
    // 3. The Breaker wraps the Retry logic, which wraps the HTTP call.
    const finalResult = await executeVerificationPipeline(requestData, idempotencyKey)();

    // IDEMPOTENCY PERSISTENCE: Success
    await persistResponse(idempotencyKey, `/internal/biometric/verify`, 200, finalResult, IDEMPOTENCY_STEP_NAME);
    
    // Return only the necessary public fields
    const { score, providerId, success } = finalResult;
    return { score, providerId, success };

   } catch (error) {

        // 💡 CRITICAL: Map Breaker errors to domain errors
        let finalCode = error.code;
        let finalMessage = error.message;

        if (error instanceof ServiceUnavailableError || error instanceof BreakerTimeoutError) {
            // This captures the Breaker's 'EOPENBREAKER' or the internal timeout 'ETIMEOUTBREAKER'
            MetricLogger.reportCount('biometric.service.failure_total', 1, { code: 'CIRCUIT_OPEN' });
            
            // 6. ADAPTIVE RESILIENCE: Xenith Fallback Mode
            if (Config.ENABLE_ASYNC_FALLBACK && !asyncFallbackHysteresisActive) {
                asyncFallbackHysteresisActive = true;
                auditLog({ level: 'WARN', event: 'ASYNC_FALLBACK_HYSTERESIS_ON', details: { service: circuitBreakerInstance.name } });

                // Queue the failed request for processing once the circuit recloses
                await BiometricClient.queueVerification(userId, requestData, error.code, idempotencyKey);
                finalCode = "ASYNC_QUEUED";
                finalMessage = "Service unavailable, transaction queued for asynchronous processing.";
                
                // Persist ASYNC_QUEUED status for idempotency replay
                const asyncResult = { success: false, status: finalCode, providerId: null, queueTime: new Date().toISOString() };
                await persistResponse(idempotencyKey, `/internal/biometric/verify`, 202, asyncResult, IDEMPOTENCY_STEP_NAME);

                return asyncResult;
            }
            
            finalCode = "CIRCUIT_OPEN_SYNC_FAIL"; // Final synchronous failure due to Breaker
            finalMessage = `Biometric service is unavailable. Reason: ${error.name}.`;

        } else {
            // Handle all other errors (Axios errors, LIVENESS_FAIL, MATCH_FAIL)
            MetricLogger.reportCount('biometric.service.failure_total', 1, { code: error.code || 'UNKNOWN' });
            finalCode = error.code || 'UNKNOWN';
        }


    // Handle expected business/API errors
    const failureResult = { code: finalCode, message: finalMessage, providerDetails: error.providerDetails || {} };
    const status = error.isAxiosError ? (error.response?.status || 500) : 400;

    // IDEMPOTENCY PERSISTENCE: Record final failure
    await persistResponse(idempotencyKey, `/internal/biometric/verify`, status, failureResult, IDEMPOTENCY_STEP_NAME);

    if (error.name === 'BiometricVerificationError') {
     auditLog({ level: 'ALERT', event: `BIOMETRIC_FAIL_${error.code}`, details: { userId, code: error.code, provider: error.providerDetails } });
     throw error; 
    }
    
    MetricLogger.reportCount(`biometric.service.failure_api`, 1, { code: finalCode });
    throw new BiometricVerificationError(finalMessage, finalCode);
   
   } finally {
    // 🛡️ CRITICAL FIX: CONCURRENCY LIMITER RELEASE GUARANTEE
    // Must be in 'finally' to ensure the slot is released regardless of success or failure
    if (slotAcquired) {
     concurrencyLimiterInstance.releaseSlot();
    }
   }
  },

  queueVerification: async (userId, requestPayload, reason, idempotencyKey) => {
   auditLog({
    level: 'WARN',
    event: 'BIOMETRIC_ASYNC_FALLBACK',
    details: { userId, reason, queue: Config.ASYNC_QUEUE_ENDPOINT, key: idempotencyKey }
   });

   try {
    // Assumes httpClient is capable of making this secondary call, possibly to an internal queue service
    await httpClient.post(Config.ASYNC_QUEUE_ENDPOINT, {
     metadata: { timestamp: Date.now(), source: 'sync_client_fallback', reason, idempotency_key: idempotencyKey },
     payload: requestPayload
    });
    MetricLogger.reportCount('biometric.async_queued', 1);
   } catch (e) {
    auditLog({ level: 'CRITICAL', event: 'QUEUE_SUBMISSION_FAILURE', details: { userId, error: e.message, key: idempotencyKey } });
    MetricLogger.reportCount('biometric.queue_failed', 1);
    throw new BiometricVerificationError(`Failed to submit to async queue: ${e.message}`, "QUEUE_CRITICAL_FAILURE");
   }
  }
 };
 
 return BiometricClient;
}

module.exports = {
 createBiometricClientService,
 BiometricVerificationError
};