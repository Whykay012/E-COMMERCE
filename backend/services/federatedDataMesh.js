// services/federatedDataMesh.js (HYPER-GOVERNANCE DYNAMIC GATEWAY: Runtime Policy & Traceability)

// --- Core Dependencies ---
const QueryClient = require('./dataMeshQueryClient'); 
const EventClient = require('./eventMeshClient');  
const CacheClient = require('./highSpeedCacheClient'); 
const JobClient = require('./asyncJobQueueClient');  
const PolicyStore = require('./centralPolicyStore'); 

// --- Utility Dependencies ---
const CircuitBreaker = require('../utils/circuitBreaker'); 
const Metrics = require('../utils/metricsClient');
const Logger = require('../utils/logger'); // ULTIMATE PINO LOGGER
const Tracing = require('../utils/tracingClient'); // OPEN-TELEMETRY CONTEXT MANAGER
const { InternalServerError } = require('../errors/custom-errors');
const { hashData } = require('../utils/cryptoUtils');


// =================================================================================
// 🛡️ INTERNAL RESILIENCE & POLICY CONFIGURATION (Now dynamically updated)
// =================================================================================

// Define circuit breakers for each core operation type for maximum isolation
const QUERY_BREAKER = new CircuitBreaker({ name: 'MeshQueryBreaker', failureThreshold: 5, timeout: 3000 });
const EVENT_BREAKER = new CircuitBreaker({ name: 'EventSendBreaker', failureThreshold: 10, timeout: 1500 });
const JOB_BREAKER = new CircuitBreaker({ name: 'AsyncJobBreaker', failureThreshold: 3, timeout: 5000 });

let runtimeQueryPolicies = {}; // Will be populated dynamically

/**
* @desc Fetches and updates policies from the central store at runtime.
*/
const fetchRuntimePolicies = async () => {
  // Use Tracing.withSpan for full visibility into the policy refresh process
  await Tracing.withSpan('policy.fetch.runtime', async (span) => {
    try {
      const policies = await PolicyStore.get('RECOMMENDATION_QUERIES');
      runtimeQueryPolicies = policies;
      Logger.audit('DYNAMIC_POLICY_UPDATE', { 
        action: 'POLICY_REFRESH', 
        entityId: 'RECOMMENDATION_QUERIES', 
        count: Object.keys(policies).length 
      });
      span.setAttribute('policy.count', Object.keys(policies).length);
    } catch (error) {
      Logger.critical('POLICY_FETCH_CRITICAL_FAIL', { error: error.message, action: 'Using stale/default policies.' });
      span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Policy Store Failure' });
      // Fail safe: use existing or hardcoded defaults if PolicyStore fails.
      if (Object.keys(runtimeQueryPolicies).length === 0) {
        runtimeQueryPolicies = {
          'ForYouQuery': { timeout: 1500, cacheTTL: 60, fallbackName: 'GlobalFallbackQuery' },
          'AlsoBoughtQuery': { timeout: 800, cacheTTL: 3600, fallbackName: 'StaticEmptyRecs' },
          'GlobalFallbackQuery': { timeout: 200, cacheTTL: 86400 }
        };
      }
    }
  });
};


// =================================================================================
// 🎯 PUBLIC API: POLICY-DRIVEN ABSTRACTION
// =================================================================================

/**
* @desc Executes a federated query via the mesh, enforcing defined policies and resilience.
*/
const executeFederatedQuery = async (operationName, context, authContext) => {
  const policy = runtimeQueryPolicies[operationName];
  if (!policy) {
    Logger.error('UNKNOWN_QUERY_POLICY_RUNTIME', { operationName });
    throw new InternalServerError(`Unknown query operation: ${operationName}`);
  }
  
  // Use Tracing.withSpan for automatic span lifecycle management
  return Tracing.withSpan(`federated.query.${operationName}`, async (span) => {
    
    span.setAttribute('query.operation', operationName);
    Metrics.increment(`mesh.query.attempt.${operationName}`);
    let result;
    const startTime = process.hrtime.bigint();

    // 1. SECURITY GOVERNANCE HOOK
    const complianceCheck = await checkSecurityCompliance(operationName, authContext);
    if (!complianceCheck.isCompliant) {
      throw new InternalServerError(`Query ${operationName} blocked by compliance policy: ${complianceCheck.reason}`);
    }

    try {
      // 2. Enforce Circuit Breaker, Timeouts, and Trace Propagation
      result = await QUERY_BREAKER.execute(async () => {
        return await QueryClient.execute(operationName, context, {
          timeout: policy.timeout,
          auth: authContext,
          // Explicitly pass the trace context for the next hop
          tracingHeaders: Tracing.injectTracingHeaders({}) 
        });
      });
      
      Metrics.timing(`mesh.query.latency.${operationName}`, (Number(process.hrtime.bigint() - startTime) / 1000000));
      Metrics.increment(`mesh.query.success.${operationName}`);
      
    } catch (error) {
      Metrics.increment(`mesh.query.fail.${operationName}`);
      Logger.warn('MESH_QUERY_FAILURE', { operationName, error: error.message, isCircuitOpen: QUERY_BREAKER.isOpened() });

      // 3. Fallback to Guaranteed Policy
      if (policy.fallbackName && runtimeQueryPolicies[policy.fallbackName]) {
        Metrics.increment(`mesh.query.fallback.${operationName}`);
        span.setAttribute('fallback.executed', policy.fallbackName);
        // Recurse to execute the fallback query (will use its own policy and tracing)
        const fallbackResult = await executeFederatedQuery(policy.fallbackName, context, authContext);
        return { 
          ...fallbackResult,
          source: `federated_fallback_${policy.fallbackName}`,
          isStale: true,
          status: 'DEGRADED_FALLBACK'
        };
      }
      // 4. Critical Failure is automatically recorded by Tracing.withSpan
      throw new InternalServerError(`Federated query failed critically for ${operationName}.`, error.name);
    }
    
    // 5. Standardize Result Structure
    return {
      data: result.data,
      source: 'federated_mesh',
      isStale: result.isStale || false, 
      status: 'FRESH'
    };
  }); // Tracing.withSpan handles span.end()
};


/**
* @desc Sends an immutable command/event to the event mesh with resilience and tracing.
*/
const sendEventCommand = (eventName, payload) => {
  // Use Tracing.withSpan for event sending, ensuring end-to-end trace propagation
  return Tracing.withSpan(`event.send.${eventName}`, async (span) => {
    
    span.setAttribute('event.name', eventName);
    Metrics.increment(`mesh.event.attempt.${eventName}`);

    try {
      await EVENT_BREAKER.execute(() => EventClient.send(eventName, { 
        ...payload, 
        // Inject trace headers into the event payload for worker traceability
        traceHeaders: Tracing.injectTracingHeaders({})
      }));
      Metrics.increment(`mesh.event.success.${eventName}`);
    } catch (error) {
      Metrics.increment(`mesh.event.fail.${eventName}`);
      // Note: Tracing.withSpan handles recording the error on the span
      Logger.error('EVENT_COMMAND_CRITICAL_FAIL', { eventName, error: error.message });
      throw error; // Re-throw to be caught by withSpan's error handling
    }
  });
};


/**
* @desc Centralized Security/Compliance Check.
* @returns {Promise<{isCompliant: boolean, reason: string}>} Compliance result.
*/
const checkSecurityCompliance = async (operationName, authContext) => {
  // Example 1: Geo-Policy Enforcement (PII access restriction)
  if (operationName === 'PIIAccessQuery' && authContext.geo !== 'EU') {
    Metrics.security('blocked.geopolicy');
    // 🚨 Use Logger.security for a contract-enforced, non-sampled security log
    Logger.security('QUERY_BLOCKED_GEOPOLICY', { 
      operationName, 
      userId: authContext.userId || 'UNKNOWN', 
      eventCode: 'GEO_BLOCK',
      geo: authContext.geo 
    });
    return { isCompliant: false, reason: 'Geo-policy violation' };
  }
  
  // Example 2: MFA Requirement Check
  const securityPolicy = await PolicyStore.get(`SECURITY:${operationName}`) || {};
  if (securityPolicy.requiresMFA && !authContext.hasMFA) {
    Metrics.security('blocked.mfa.required');
    // 🚨 Use Logger.security for a contract-enforced, non-sampled security log
    Logger.security('QUERY_BLOCKED_MFA', { 
      operationName, 
      userId: authContext.userId || 'UNKNOWN', 
      eventCode: 'MFA_REQUIRED' 
    });
    return { isCompliant: false, reason: 'MFA required' };
  }
  
  // Example 3: Audit Log for successful Policy Compliance Check
  Logger.audit('QUERY_POLICY_CHECK_SUCCESS', {
    entityId: operationName,
    action: 'POLICY_CHECK',
    userId: authContext.userId || 'N/A'
  });

  return { isCompliant: true, reason: 'N/A' };
};


// 💡 TRACING WRAPPER IMPLEMENTATION: Check Precomputation Status
const checkPrecomputationStatus = (key, recType) => {
  return Tracing.withSpan(`cache.status.check.${recType}`, async (span) => {
    
    span.setAttribute('cache.key', key);
    
    const statusData = await CacheClient.get(`status:${key}`);
    
    if (statusData) {
      Metrics.cacheHit(`precomputation.${recType}`); // Semantic Metric
      span.setAttribute('cache.hit', true);
      Logger.info('PRECOMPUTATION_STATUS_HIT', { key });
      return { isReady: true, dataHash: statusData.hash, lastCalculated: statusData.timestamp };
    }
    
    Metrics.cacheMiss(`precomputation.${recType}`); // Semantic Metric
    span.setAttribute('cache.hit', false);
    Logger.warn('PRECOMPUTATION_STATUS_MISS', { key });
    return { isReady: false, dataHash: null, lastCalculated: null };
    
    // Errors are automatically recorded and span ended by Tracing.withSpan
  });
};


// 💡 TRACING WRAPPER IMPLEMENTATION: Async Job Queue Operations
const startAsyncRecommendationJob = (jobId, payload) => {
    return Tracing.withSpan(`job.start.${jobId}`, async (span) => {
        span.setAttribute('job.id', jobId);
        Metrics.increment('job.start.attempt');
        
        try {
            await JOB_BREAKER.execute(() => JobClient.start(jobId, payload));
            Metrics.increment('job.start.success');
            Logger.audit('ASYNC_JOB_STARTED', { entityId: jobId, action: 'START_JOB', jobType: payload.type });
        } catch (error) {
            Metrics.increment('job.start.fail');
            Logger.error('ASYNC_JOB_START_FAIL', { jobId, error: error.message });
            throw error;
        }
    });
};

const checkJobStatus = (jobId) => {
    return Tracing.withSpan(`job.check.status.${jobId}`, async (span) => {
        try {
            const status = await JobClient.status(jobId);
            span.setAttribute('job.status', status);
            return status;
        } catch (error) {
            // Error handling is managed by Tracing.withSpan
            throw error;
        }
    });
};


// =================================================================================
// 💡 MODULE EXPORTS (Policy-enforced Facade)
// =================================================================================

module.exports = {
  // High-Level Operations
  executeFederatedQuery,
  sendEventCommand,
  startAsyncRecommendationJob, 
  checkJobStatus, 
  checkPrecomputationStatus, 
  
  // Governance and Lifecycle
  getPolicyStatus: () => ({ 
    status: PolicyStore.isConnected() ? 'LIVE' : 'DEFAULT_SAFE', 
    policies: Object.keys(runtimeQueryPolicies).length 
  }),
  
  initialize: async () => {
    await Promise.all([
      QueryClient.initialize(),
      EventClient.initialize(),
      CacheClient.initialize(),
      JobClient.initialize(),
      PolicyStore.initialize(), 
      Metrics.initialize(), // Ensure Metrics is initialized
      Tracing.initialize()   
    ]);
    await fetchRuntimePolicies(); // Initial dynamic policy load
    
    // Set up a recurring background check to refresh policies
    setInterval(fetchRuntimePolicies, 60000).unref(); 
    
    Logger.info('HYPER_GOVERNANCE_GATEWAY_INITIALIZED');
  },
  shutdown: async () => {
    await Promise.all([
      QueryClient.shutdown(),
      EventClient.shutdown(),
      CacheClient.shutdown(),
      JobClient.shutdown(),
      PolicyStore.shutdown(),
      Metrics.shutdown(), // Ensure Metrics is shut down
      Tracing.shutdown()
    ]);
    Logger.info('HYPER_GOVERNANCE_GATEWAY_SHUTDOWN');
  },
};