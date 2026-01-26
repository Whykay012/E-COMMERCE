// controllers/recommendationsController.js

// --- 🎯 Federated Core Dependencies (Asynchronous Command/Query) ---
const { 
    executeFederatedQuery,
    sendEventCommand,
    checkPrecomputationStatus, 
    startAsyncRecommendationJob,  // 💡 UPGRADE: New non-blocking job starter
    checkJobStatus                // 💡 UPGRADE: New job status checker
} = require('../services/federatedDataMesh');

// --- 🛡️ Resilience, Security & Policy Enforcement Dependencies ---
const { BadRequestError, ForbiddenError, ServiceUnavailableError, InternalServerError } = require('../errors/custom-errors');
const CircuitBreaker = require('../utils/circuitBreaker'); 
const FeatureToggle = require('../utils/featureToggle'); 
const JSONSchemaValidator = require('../utils/jsonSchemaValidator');
const Logger = require('../utils/logger'); 
const Metrics = require('../utils/metricsClient');
const { hashData } = require('../utils/cryptoUtils'); 
const { StandardErrorMap } = require('../utils/errorCodes'); // 💡 UPGRADE: Standardized App Error Codes

// --- Contextual Policy and Resilience Instances ---
const FEDERATION_BREAKER = new CircuitBreaker({ name: 'FederatedRecsBreaker', failureThreshold: 7, timeout: 5000 });
const USER_TIER_THROTTLE_MAP = {
    'premium': '200/minute',
    'standard': '50/minute',
    'guest': '10/minute'
};
const DEFAULT_RATE_LIMIT_POLICY = USER_TIER_THROTTLE_MAP.standard;

// --- Security Constants ---
const API_VERSION = 'v4.0.0'; // Major version bump for async change
const RESOURCE_PATH = '/api/recommendations';


/**
 * 📢 Endpoint: GET /api/recommendations/for-you
 * 💡 QUANTUM ASYNC PATTERN: Returns Job ID if computation is expensive/stale.
 */
exports.getForYouRecs = async (req, res, next) => {
    Metrics.increment('quantum.for_you.request_count');

    // 1. 🛡️ SECURITY: WAF Context and Bot Score Check
    const wafContext = req.waf || {}; // Assumed to be injected by WAF/Service Mesh
    if (wafContext.botScore && wafContext.botScore > 0.8) {
        Logger.security('WAF_BOT_BLOCKED', { userId: req.user?.id, score: wafContext.botScore, path: req.path });
        Metrics.increment('security.bot_request_denied');
        // Return 403 or 429 for automated requests
        throw new ForbiddenError("Request denied by security layer due to suspicious activity.");
    }

    // 2. Input Validation & Context
    const validationResult = JSONSchemaValidator.validate(req.query, recommendationQuerySchema);
    if (!validationResult.valid) {
        throw new BadRequestError(`Invalid query parameters: ${validationResult.errors.join(', ')}`);
    }
    const { limit, fields } = validationResult.data;

    const authContext = req.user; 
    const userId = authContext?.id;
    const userTier = authContext?.tier || 'standard';
    
    if (!userId) {
        throw new ForbiddenError("Authentication required for personalized recommendations.");
    }
    
    const context = { userId, limit, fields, userTier, recommendationType: 'for-you' };
    const cacheKey = `for_you:${userId}`;
    
    // 3. Pre-computation Status Check
    const { isReady, dataHash, lastCalculated } = await checkPrecomputationStatus(cacheKey, 'for-you');

    // 4. CLIENT CACHE NEGOTIATION (ETag)
    if (isReady && dataHash && req.headers['if-none-match'] === dataHash) {
        return res.status(304).send();
    }
    
    // 5. QUANTUM ASYNC DECISION: If data is NOT ready AND this is a complex user/query (e.g., premium tier), start a job.
    if (!isReady && userTier === 'premium') {
        const jobId = await startAsyncRecommendationJob(context);
        
        Metrics.increment('quantum.for_you.async_job_started');
        
        // 💡 UPGRADE: 202 ACCEPTED response with job details
        res.set('API-Version', API_VERSION);
        res.set('Location', `${RESOURCE_PATH}/job/${jobId}`);
        return res.status(202).json({
            type: StandardErrorMap.ASYNC_JOB_ACCEPTED.type,
            title: StandardErrorMap.ASYNC_JOB_ACCEPTED.title,
            status: 202,
            detail: "Complex personalized recommendations are computing. Poll the status_url for results.",
            jobId: jobId,
            status_url: `${RESOURCE_PATH}/job/${jobId}` // 💡 HATEOAS link for polling
        });
    }

    // --- SYNCHRONOUS FLOW (Fallback or Simple Queries) ---
    
    // 6. GRACEFUL DEGRADATION / FEDERATED QUERY EXECUTION
    let queryResult;
    try {
        queryResult = await FEDERATION_BREAKER.execute(() => 
            executeFederatedQuery('ForYouQuery', context, authContext)
        );
    } catch (error) {
        Logger.error('FEDERATION_QUERY_FAIL', { context, error: error.message, code: StandardErrorMap.FEDERATION_FAIL.code });
        // Fallback or rethrow the error using the standardized format
        throw new ServiceUnavailableError(
            "Service mesh is unavailable. Please try the standard recommendations.",
            StandardErrorMap.FEDERATION_FAIL.code
        );
    }
    
    // 7. EVENT-DRIVEN Command Policy (Only send event if we served stale sync data)
    if (queryResult.isStale && FeatureToggle.isEnabled('rec_engine_recalc_mesh')) {
        sendEventCommand('USER_VIEWED_STALE_REC', { userId, key: cacheKey, priority: 'HIGH' })
            .catch(err => Logger.error('EVENT_SEND_FAILURE', { context, error: err.message }));
    }

    // 8. FINAL RESPONSE
    const finalHash = dataHash || (queryResult.data.length > 0 ? hashData(queryResult.data) : null);

    res.set('X-Content-Type-Options', 'nosniff');
    res.set('API-Version', API_VERSION);
    res.set('Cache-Control', 'max-age=10, private, stale-while-revalidate=60'); 
    if (finalHash) {
        res.set('ETag', finalHash);
    }

    res.status(200).json({
        metadata: {
            apiContract: API_VERSION,
            rateLimitPolicy: req.rateLimitPolicy || USER_TIER_THROTTLE_MAP[userTier],
            serviceHealth: FEDERATION_BREAKER.isClosed() ? 'CIRCUIT_OPEN' : 'OK',
            source: queryResult.source,
            calculationStatus: isReady ? 'ready' : 'pending_sync',
            lastCalculated: lastCalculated || 'N/A',
            _links: {
                self: { href: `${RESOURCE_PATH}/for-you?limit=${limit}` }
            }
        },
        requestContext: context,
        data: queryResult.data
    });
};


/**
 * 📢 Endpoint: GET /api/recommendations/job/:jobId
 * 💡 QUANTUM ASYNC PATTERN: Polling endpoint for results.
 */
exports.getJobStatus = async (req, res, next) => {
    const { jobId } = req.params;
    if (!jobId) {
        throw new BadRequestError("Job ID is required.");
    }
    
    // Check job status and fetch results if complete
    const { status, result, error, progress } = await checkJobStatus(jobId);

    // 💡 UPGRADE: WebSockets are recommended for the final state, but HTTP polling is the foundation.
    if (status === 'COMPLETE') {
        res.status(200).json({
            jobId,
            status: 'COMPLETE',
            result: result,
            metadata: {
                apiContract: API_VERSION,
                _links: { 
                    self: { href: `${RESOURCE_PATH}/job/${jobId}` },
                    // Once complete, link to a permanent cache endpoint if available
                    data_link: { href: `${RESOURCE_PATH}/cache/${jobId}` } 
                }
            }
        });
    } else if (status === 'FAILED') {
        res.status(500).json({
            jobId,
            status: 'FAILED',
            error: error || 'Unknown computation error.',
            type: StandardErrorMap.ASYNC_JOB_FAILED.type,
            title: StandardErrorMap.ASYNC_JOB_FAILED.title,
            detail: "The asynchronous job failed during processing."
        });
    } else {
        // PENDING or PROCESSING (Still waiting)
        res.status(200).json({
            jobId,
            status: status,
            progress: progress || 0,
            message: `Job is ${status.toLowerCase()}. Please retry later.`,
            metadata: {
                apiContract: API_VERSION,
                _links: { self: { href: `${RESOURCE_PATH}/job/${jobId}` } }
            }
        });
    }
};

/**
 * 📢 Endpoint: GET /api/recommendations/also-bought/:productId
 * 💡 REMAINS SYNCHRONOUS: Co-purchase is generally a simpler, highly cacheable dataset.
 */
exports.getAlsoBoughtRecs = async (req, res, next) => {
    // ... (logic from ZENITH BEYOND APOLLO - ETag, Pre-check, etc. remains the same) ...
    Metrics.increment('orchestrator.also_bought.request_count');

    // 1. Input Validation
    const paramValidation = JSONSchemaValidator.validate(req.params, alsoBoughtParamsSchema);
    const queryValidation = JSONSchemaValidator.validate(req.query, recommendationQuerySchema);
    if (!paramValidation.valid || !queryValidation.valid) {
        throw new BadRequestError("Invalid input ID or parameters.");
    }
    const { limit, fields } = queryValidation.data;
    const { productId } = paramValidation.data;
    
    const context = { productId, limit, fields, recommendationType: 'also-bought' };
    const cacheKey = `also_bought:${productId}`;

    // 2. Pre-computation Status Check
    const { isReady, dataHash, lastCalculated } = await checkPrecomputationStatus(cacheKey, 'also-bought');

    // 3. CLIENT CACHE NEGOTIATION (ETag)
    if (isReady && dataHash && req.headers['if-none-match'] === dataHash) {
        Metrics.increment('orchestrator.also_bought.cache_hit_negotiated');
        return res.status(304).send();
    }
    
    // 4. FEDERATED QUERY EXECUTION
    let queryResult;
    try {
        queryResult = await FEDERATION_BREAKER.execute(() => 
            executeFederatedQuery('AlsoBoughtQuery', context, req.user)
        );
    } catch (error) {
        Logger.warn('FEDERATION_FAIL_PRODUCT', { productId, error: error.message });
        // Standardized graceful degradation response
        queryResult = { data: [], source: 'empty_response', isStale: true, status: 'GRACEFUL_DEGRADATION' };
    }

    // 5. EVENT-DRIVEN Command Policy
    if ((queryResult.isStale || !isReady) && FeatureToggle.isEnabled('rec_engine_recalc_mesh')) {
        sendEventCommand('PRODUCT_VIEWED_STALE_REC', { productId, key: cacheKey, priority: 'LOW' })
            .catch(err => Logger.warn('EVENT_SEND_FAILURE_LOW_PRIORITY', { context, error: err.message }));
    }

    // 6. FINAL RESPONSE
    const finalHash = dataHash || (queryResult.data.length > 0 ? hashData(queryResult.data) : null);

    res.set('X-Content-Type-Options', 'nosniff');
    res.set('API-Version', API_VERSION);
    res.set('Cache-Control', 'max-age=3600, public, stale-while-revalidate=7200'); 
    if (finalHash) {
        res.set('ETag', finalHash);
    }
    
    res.status(200).json({
        metadata: {
            apiContract: API_VERSION,
            rateLimitPolicy: DEFAULT_RATE_LIMIT_POLICY,
            serviceHealth: FEDERATION_BREAKER.isClosed() ? 'CIRCUIT_OPEN' : 'OK',
            source: queryResult.source,
            calculationStatus: isReady ? 'ready' : 'pending_sync',
            lastCalculated: lastCalculated || 'N/A',
            _links: {
                self: { href: `${RESOURCE_PATH}/also-bought/${productId}?limit=${limit}` },
                reportIssue: { href: '/api/support/report?context=alsoBought', method: 'POST' }
            }
        },
        requestContext: context,
        data: queryResult.data
    });
};