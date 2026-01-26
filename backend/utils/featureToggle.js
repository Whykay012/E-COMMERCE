// utils/featureToggle.js (HOLISTIC ORCHESTRATOR: Cost-Awareness & Shadow Testing)

// --- External Dependencies ---
const PolicyClient = require('./externalToggleClient'); 
const LocalCache = require('./localToggleCache'); 
const PushListener = require('./policyPushListener'); 
const Logger = require('./logger'); 
const Metrics = require('./metricsClient');
const CircuitBreaker = require('./circuitBreaker');
const RateLimiter = require('./rateLimiter'); 

// 💡 UPGRADE: Import the Apollo Audit Facade (AuditLogger) which was previously auditLogTransport
// Assuming the file is now named auditLogger.js in the same directory, or adjust path as needed.
const AuditLogger = require('./auditLogger'); 

const BadRequestError = require('../errors/bad-request-error')

// --- Configuration ---
const DEFAULT_FALLBACK_TTL_SECONDS = 300;
const CLIENT_TIMEOUT_MS = 200; 

let dynamicMaxRPS = 1000; 

const TOGGLE_BREAKER = new CircuitBreaker({ 
    name: 'FeatureToggleBreaker', 
    failureThreshold: 5, 
    timeout: CLIENT_TIMEOUT_MS * 2
});

const POLICY_RATE_LIMITER = new RateLimiter({ 
    limit: dynamicMaxRPS, 
    interval: 1000 
});

// --- Critical Policy Requirements ---
const CRITICAL_FLAGS_CONTEXT = {
    'REC_ASYNC_JOB_ENABLED': { fields: ['userId', 'tier'], ttl: 60 }, 
    'COSMETIC_UI_CHANGE': { fields: [], ttl: 3600 } 
};

// =================================================================================
// 🛡️ INTERNAL RESILIENCE & CACHING
// =================================================================================

/**
 * @desc Dynamically reads PolicyClient response headers to update internal throttling limits.
 */
const adjustRateLimitBasedOnQuota = (policyResponse) => {
    const remaining = policyResponse.metadata?.quotaRemaining;
    const recommendedMax = policyResponse.metadata?.recommendedRPS;

    if (recommendedMax !== undefined && recommendedMax < dynamicMaxRPS) {
        dynamicMaxRPS = recommendedMax;
        POLICY_RATE_LIMITER.setLimit(dynamicMaxRPS);
        Logger.alert('RATE_LIMIT_ADJUSTED_DOWN', { newLimit: dynamicMaxRPS, reason: 'External Recommendation' }); 
    } else if (remaining !== undefined && remaining < 50) { 
        const newLimit = Math.max(10, Math.floor(POLICY_RATE_LIMITER.getLimit() * 0.5));
        POLICY_RATE_LIMITER.setLimit(newLimit);
        Logger.alert('RATE_LIMIT_ADJUSTED_CRITICAL', { newLimit, reason: `Quota remaining: ${remaining}` }); 
    }
};

/**
 * @desc Attempts to fetch the policy decision from the external service.
 */
const fetchDecisionFromExternalSource = async (key, context) => {
    if (!POLICY_RATE_LIMITER.canProceed() || TOGGLE_BREAKER.isOpened()) {
        Metrics.increment('feature.external_fetch.blocked');
        return null; 
    }

    Metrics.increment('feature.external_fetch.attempt');

    try {
        const result = await TOGGLE_BREAKER.execute(async () => {
            return PolicyClient.evaluate(key, context, { timeout: CLIENT_TIMEOUT_MS });
        });
        
        Metrics.increment('feature.external_fetch.success');
        
        adjustRateLimitBasedOnQuota(result);

        const policyConfig = CRITICAL_FLAGS_CONTEXT[key] || {};
        const ttl = policyConfig.ttl || DEFAULT_FALLBACK_TTL_SECONDS;

        await LocalCache.set(key, result, ttl); 
        
        return { 
            decision: result.enabled, 
            source: 'external', 
            ruleId: result.rule || 'default_on',
            shadowDecision: result.shadowEnabled 
        };

    } catch (error) {
        Metrics.increment('feature.external_fetch.fail');
        Logger.warn('TOGGLE_EXTERNAL_FAIL', { key, err: error }); 
        return null; 
    }
};


// =================================================================================
// 🎯 PUBLIC API: CONTEXT-AWARE GOVERNANCE
// =================================================================================

/**
 * @desc Evaluates a feature flag based on a complex runtime context.
 */
const isEnabled = async (key, context, defaultValue = false) => {
    const policyConfig = CRITICAL_FLAGS_CONTEXT[key];

    // 1. CONTEXT VALIDATION POLICY ENFORCEMENT
    if (policyConfig) {
        for (const field of policyConfig.fields) {
            if (!context?.[field]) {
                Metrics.security('feature.decision.validation_fail');
                Logger.security('FLAG_CONTEXT_INVALID', { key, missingField: field, context: context, eventCode: 'CONTEXT_VIOLATION', userId: context.userId || 'N/A' });
                throw new BadRequestError(`Missing critical context field '${field}' required for feature flag '${key}'.`);
            }
        }
    } else if (!context || !context.userId) {
        return defaultValue;
    }

    // ... (Steps 2-4: Cache and Default Fallbacks) ...
    let decisionResult = await fetchDecisionFromExternalSource(key, context);

    if (!decisionResult) {
        const cached = await LocalCache.get(key);
        if (cached && cached.enabled !== undefined) {
            Metrics.increment('feature.decision.local_cache');
            decisionResult = { 
                decision: cached.enabled, 
                source: 'local_cache', 
                ruleId: cached.rule || 'stale',
                shadowDecision: cached.shadowEnabled 
            };
        }
    }
    
    if (!decisionResult) {
        decisionResult = { decision: defaultValue, source: 'hard_default', ruleId: 'hardcoded', shadowDecision: defaultValue };
        Logger.alert('TOGGLE_FATAL_FALLBACK', { key, finalValue: defaultValue, userId: context.userId }); 
    }
    
    // 5. SHADOW MODE CHECK and DECOUPLED AUDIT
    if (decisionResult.shadowDecision !== undefined) {
        if (decisionResult.decision !== decisionResult.shadowDecision) {
            Metrics.increment(`feature.shadow_mode.discrepancy.${key}`);
            
            // 💡 UPGRADE: Use the Apollo Audit Facade's dispatch function (log)
            AuditLogger.log({
                level: 'SECURITY', // Use the high-level semantic log for the audit facade
                event: 'SHADOW_MODE_DISCREPANCY',
                userId: context.userId, // Apollo Facade uses top-level userId
                details: {
                    key: key,
                    liveDecision: decisionResult.decision,
                    shadowDecision: decisionResult.shadowDecision,
                    context: { userId: context.userId, tier: context.tier }, // Keep context in details
                },
            });

            // Log to the main structured logger as well (semantic 'audit' level)
            Logger.audit('SHADOW_MODE_DISCREPANCY', { 
                key, 
                live: decisionResult.decision, 
                shadow: decisionResult.shadowDecision, 
                entityId: context.userId, 
                action: 'Discrepancy' 
            });
        }
    }

    // 6. Final Metrics and Return
    Metrics.increment(`feature.decision.source.${decisionResult.source}`);
    
    return decisionResult.decision;
};

// =================================================================================
// 💡 MODULE LIFECYCLE MANAGEMENT
// =================================================================================

const isEnabledSync = (key) => {
    const cached = LocalCache.getSync(key); 
    return cached ? cached.enabled : false;
}

const getHealth = () => ({
    externalClient: PolicyClient.isConnected(),
    circuitStatus: TOGGLE_BREAKER.status(),
    cacheStatus: LocalCache.isConnected(),
    rateLimitStatus: `${POLICY_RATE_LIMITER.getRemaining()}/${POLICY_RATE_LIMITER.getLimit()}`,
    pushListenerStatus: PushListener.isConnected(),
    // 💡 ADD: Expose AuditLogger Health/Version
    auditFacadeVersion: AuditLogger.getFacadeVersion() 
});


module.exports = {
    isEnabled,
    isEnabledSync,
    getHealth,
    
    initialize: async () => {
        Logger.initialize(); 

        await Promise.all([
            PolicyClient.initialize(),
            LocalCache.initialize(),
            PushListener.initialize(),
            AuditLogger.initialize() // 💡 UPGRADE: Use the new module name AuditLogger
        ]);
        
        PushListener.subscribe(PushListener.handlePolicyPushUpdate);
        await PolicyClient.loadInitialFlags().then(flags => LocalCache.setMany(flags));
        
        Logger.info('HOLISTIC_ORCHESTRATOR_INITIALIZED');
    },
    shutdown: async () => {
        PushListener.unsubscribe(PushListener.handlePolicyPushUpdate);
        await Promise.all([
            PolicyClient.shutdown(),
            LocalCache.shutdown(),
            PushListener.shutdown(),
            AuditLogger.shutdown() // 💡 UPGRADE: Use the new module name AuditLogger
        ]);
        
        await Logger.shutdown(); 
        Logger.info('HOLISTIC_ORCHESTRATOR_SHUTDOWN'); 
    }
};