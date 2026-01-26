// =================================================================================
// services/policyEngine.js (AETHELRED HYPERSCALE: CONCURRENT & LIVE-UPDATE PDP)
// =================================================================================

const Logger = require('../utils/logger');
const Tracing = require('../utils/tracingClient');
const ForbiddenError = require('../errors/forbidden-error');
const Metrics = require('../utils/metricsClient');
const InternalServerError = require('../errors/internal-server-error');

// --- 💡 Real-Time Dependencies ---
const PolicyPushListener = require('../utils/policyPushListener'); 

// =================================================================================
// --- INITIAL POLICY RULESET (Dynamically Updated at Runtime) ---
// =================================================================================

// Policy rules are defined in a mutable array, which is swapped on real-time updates.
let DYNAMIC_POLICY_RULES = [ 
    // 1. Transactional Velocity Check (Concurrency Group 1)
    {
        name: 'TxnVelocityLimit',
        resource: 'payment:transfer',
        action: 'execute',
        evaluate: async (user, context) => {
            // Simulated call to a High-Volume Data Store
            const velocityScore = await riskService.getVelocityScore(user.id);
            if (velocityScore > 5) return { authorized: false, reason: 'Transaction velocity exceeded 5 per hour.' };
            return { authorized: true };
        }
    },
    // 2. Runtime Risk Score (Concurrency Group 1)
    {
        name: 'RuntimeRiskBlocking',
        resource: '*',
        action: '*',
        evaluate: (user, context) => {
            if (context.riskScore > 80) {
                return { authorized: false, reason: 'Request blocked by high-risk score.' };
            }
            return { authorized: true };
        }
    },
    // 3. Data Segregation (Concurrency Group 2: Low-latency check)
    {
        name: 'DataSegregation',
        resource: 'payment:read',
        action: 'read',
        evaluate: (user, context) => {
            if (context.targetUserId && user.id !== context.targetUserId && user.role !== 'admin') {
                return { authorized: false, reason: 'Not authorized to view another user\'s data.' };
            }
            return { authorized: true };
        }
    },
    // 4. Geo-Fencing Policy (Concurrency Group 1)
    {
        name: 'GeoFencingCritical',
        resource: '*',
        action: '*',
        evaluate: async (user, context) => {
            const geoData = await geoIpService.lookup(context.ip);
            if (geoData.isSanctionedCountry) {
                return { authorized: false, reason: 'Access denied from sanctioned country.' };
            }
            return { authorized: true };
        }
    },
];

// =================================================================================
// --- SIMULATED EXTERNAL ABAC SERVICES ---
// =================================================================================

const userService = {
    getAbacAttributes: async (userId) => {
        // Simulate network latency for attribute fetch
        await new Promise(resolve => setTimeout(resolve, 5)); 
        return { role: (userId === 'admin123') ? 'admin' : 'user', country: 'US', level: 'gold' };
    },
};
const riskService = {
    getRiskScore: async (userId, ip) => {
        // Simulate network latency for risk scoring
        await new Promise(resolve => setTimeout(resolve, 15)); 
        return (userId === 'riskyUser' || ip.startsWith('10.')) ? 90 : 10;
    },
    getVelocityScore: async (userId) => {
        // Simulate high-volume data store lookup
        await new Promise(resolve => setTimeout(resolve, 10)); 
        return userId === 'spammer' ? 6 : 1;
    }
};
const geoIpService = {
    lookup: async (ip) => {
        // Simulate GeoIP lookup latency
        await new Promise(resolve => setTimeout(resolve, 10));
        return { country: 'US', isSanctionedCountry: ip.startsWith('192.0.2.') };
    }
};

// =================================================================================
// ⚙️ INITIALIZATION AND REAL-TIME UPDATE HANDLING
// =================================================================================

/**
 * @desc Handler function called by the PolicyPushListener when a new policy bundle arrives.
 */
const handlePolicyUpdate = (update) => {
    Tracing.withSpan('PolicyEngine:handleLiveUpdate', (span) => {
        if (update.type === 'POLICY_BUNDLE_V1' && update.rules) {
            // Atomic swap of the policy rules array
            DYNAMIC_POLICY_RULES = update.rules;
            Metrics.gauge('policy.rules_count', DYNAMIC_POLICY_RULES.length);
            Logger.audit('POLICY_RULES_REFRESHED', { 
                version: update.version, 
                ruleCount: DYNAMIC_POLICY_RULES.length 
            });
            span.setAttribute('policy.version', update.version);
        } else {
            Logger.warn('UNRECOGNIZED_OR_INVALID_POLICY_UPDATE', { type: update.type });
        }
    });
};

/**
 * @desc Sets up the Policy Engine and subscribes to the real-time stream.
 */
const initializePolicyEngine = async () => {
    // 1. Subscribe to the real-time policy stream
    PolicyPushListener.subscribe(handlePolicyUpdate);
    // 2. Ensure the WebSocket connection is established (includes backoff/auth logic)
    await PolicyPushListener.initialize(); 
    Logger.info('POLICY_ENGINE_LIVE_READY');
};


// =================================================================================
// 🛡️ POLICY DECISION POINT (PDP)
// =================================================================================

/**
 * @desc Policy Decision Point (PDP) implementation using concurrent evaluation.
 */
const evaluate = async (userId, resource, action, context = {}) => {
    return Tracing.withSpan('PolicyEngine:evaluateAccess (Concurrent PDP)', async (span) => {
        span.setAttributes({ userId, resource, action });
        const start = Date.now();
        
        // 1. Fetch ALL primary attributes and risk scores concurrently
        const [userAttributes, riskScore, geoIpData] = await Promise.all([
            userService.getAbacAttributes(userId),
            riskService.getRiskScore(userId, context.ip),
            geoIpService.lookup(context.ip)
        ]);
        
        // 2. Compile full evaluation context
        const evaluationContext = {
            ...context,
            userAttributes: userAttributes,
            riskScore: riskScore, 
            geoIpData: geoIpData,
        };
        const user = { id: userId, role: userAttributes.role };

        // 3. Filter Relevant Policies (Uses the currently active DYNAMIC_POLICY_RULES)
        const relevantPolicies = DYNAMIC_POLICY_RULES.filter(policy => 
            (policy.resource === '*' || policy.resource === resource) &&
            (policy.action === '*' || policy.action === action)
        );
        
        // 4. Execute all relevant policies concurrently using Promise.allSettled
        const evaluationPromises = relevantPolicies.map(policy => 
            // Wrap policy execution in its own span for granular tracing
            Tracing.withSpan(`PolicyEval:${policy.name}`, (policySpan) => {
                policySpan.setAttributes({ policy_name: policy.name, resource, action });
                return policy.evaluate(user, evaluationContext).then(result => ({ policy, result }));
            })
        );

        const settledResults = await Promise.allSettled(evaluationPromises);

        // 5. Analyze Results (Fail-Closed Strategy)
        for (const settledResult of settledResults) {
            if (settledResult.status === 'rejected') {
                // Dependency failure on a policy evaluation leads to a deny (Fail-Closed)
                Logger.error('POLICY_ENGINE_DEPENDENCY_FAILURE_FAIL_CLOSED', { 
                    policy: settledResult.value?.policy?.name || 'Unknown', 
                    error: settledResult.reason.message 
                });
                Metrics.security('policy.dependency.fail_closed', { dependency: settledResult.value?.policy?.name || 'unknown' });
                throw new InternalServerError('Critical policy dependency failure. Access denied.'); 
            }

            const { policy, result } = settledResult.value;
            
            if (!result.authorized) {
                // IMMEDIATE DENY: Policy violation found
                Metrics.security('policy.deny.final', { policy: policy.name, resource, action });
                Logger.security('ACCESS_POLICY_VIOLATION_DENIED', { userId, resource, action, policy: policy.name, reason: result.reason });
                throw new ForbiddenError(`Access denied: ${result.reason}`);
            }
        }
        
        const duration = Date.now() - start;
        Metrics.security('policy.allow', { resource, action, duration_ms: duration });
        
        return { authorized: true, details: { policiesChecked: relevantPolicies.length, duration_ms: duration } };
    });
};


module.exports = {
    initializePolicyEngine, 
    evaluate,
    enforceAccess: evaluate,
};