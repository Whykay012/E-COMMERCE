// utils/dataMeshQueryClient.js (DataMeshQueryClient: Adaptive Concurrency, Tracing, Abort Signals)

// --- External Dependencies ---
const HTTPClient = require('axios'); 
const CircuitBreaker = require('./circuitBreaker'); 
const Logger = require('./logger'); 
const Metrics = require('./metricsClient'); 
const Semaphore = require('./concurrencySemaphore'); 
const Tracing = require('./tracingClient'); // CRITICAL: Import TracingClient
const { InternalServerError, GatewayTimeoutError } = require('../errors/custom-errors'); 
const { AbortController } = require('abort-controller'); // For Node < 16, need explicit import

// --- Configuration ---
const DATA_MESH_ENDPOINT = process.env.DATA_MESH_URL || 'https://data.mesh.api/v2'; 
const MAX_CONCURRENT_QUERIES = 50; 
const REQUEST_TIMEOUT_MS = 2500; 

// Shared resources
const meshBreaker = new CircuitBreaker({ 
    name: 'DataMeshBreaker',
    failureThreshold: 5,
    timeout: 3000, 
    resetTimeout: 30000 
});
const concurrencyLimiter = new Semaphore(MAX_CONCURRENT_QUERIES); 

const QueryClient = {
    VERSION: '2.1.1', // Bumped version for tracing implementation

    /**
     * @typedef {object} QueryOptions
     * @property {number} [retries=3] - Max retries on transient errors.
     * @property {number} [timeout=REQUEST_TIMEOUT_MS] - Per-request timeout in ms.
     * @property {string} [traceId] - Distributed tracing identifier (DEPRECATED: Now auto-injected).
     */
    async query(dataProduct, queryParams, options = {}) {
        
        // 🚀 UPGRADE: Wrap the entire request lifecycle in a span.
        return Tracing.withSpan(`DataMeshQuery.${dataProduct}`, async (span) => {
            const { retries = 3, timeout = REQUEST_TIMEOUT_MS } = options;
            let attempt = 0;
            
            span.setAttribute('datamesh.data_product', dataProduct);
            span.setAttribute('datamesh.retries.max', retries);
            
            // 💡 TRACING: Create a dedicated span for the concurrency semaphore wait time.
            await Tracing.withSpan('DataMeshQuery.acquireSemaphore', async () => concurrencyLimiter.acquire());
            
            try {
                while (attempt < retries) {
                    const abortController = new AbortController();
                    const timeoutId = setTimeout(() => abortController.abort(), timeout);

                    try {
                        // 💡 TRACING: Start a span for the individual HTTP attempt.
                        const response = await Tracing.withSpan(`DataMeshQuery.attempt.${attempt + 1}`, async (attemptSpan) => {
                            
                            const url = `${DATA_MESH_ENDPOINT}/${dataProduct}`;
                            
                            // 🚀 UPGRADE: Auto-inject tracing headers from the current context.
                            const headers = { 
                                'X-Client-Version': QueryClient.VERSION, 
                                // Placeholder object for propagation.inject to populate
                            };
                            Tracing.injectTracingHeaders(headers);
                            
                            Metrics.timing('datamesh.query.latency.start', Date.now());
                            attemptSpan.setAttribute('http.url', url);

                            return await HTTPClient.get(url, {
                                params: queryParams,
                                headers: headers,
                                signal: abortController.signal,
                                // Use the internal Axios timeout config for better error handling
                                timeout: timeout 
                            });
                        }); // End inner Tracing.withSpan (attemptSpan)

                        clearTimeout(timeoutId);
                        Metrics.increment(`datamesh.query.success.attempt.${attempt + 1}`);
                        Metrics.timing('datamesh.query.latency.end');
                        
                        // 💡 TRACING: Record the final success attempt number on the root span
                        span.setAttribute('datamesh.retries.successful_attempt', attempt + 1);

                        return response.data;

                    } catch (error) {
                        clearTimeout(timeoutId);
                        
                        const isTimeout = error.code === 'ECONNABORTED' || HTTPClient.isCancel(error) || abortController.signal?.aborted;
                        const isTransient = isTimeout || (error.response?.status >= 500 && error.response.status < 600);
                        
                        // 💡 TRACING: Record the error details on the root span
                        span.recordException(error);
                        span.setAttribute('http.response.status_code', error.response?.status);

                        if (isTimeout) {
                            Metrics.increment('datamesh.query.timeout');
                            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Gateway Timeout' });
                            throw new GatewayTimeoutError(`Data Mesh query timed out after ${timeout}ms.`);
                        }

                        if (attempt >= retries || !isTransient || meshBreaker.isOpened()) {
                            Metrics.critical('datamesh.query.fatal_fail');
                            Logger.error('DATAMESH_QUERY_FATAL', { dataProduct, queryParams, error: error.message, attempt });
                            
                            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Permanent failure or Circuit Open' });
                            throw new InternalServerError(`Data Mesh query failed permanently after ${attempt + 1} tries.`);
                        }

                        // --- Retry Logic ---
                        attempt++;
                        const maxBackoff = 1000 * Math.pow(2, attempt); 
                        const backoffTime = Math.random() * maxBackoff; 
                        
                        Logger.warn('DATAMESH_QUERY_RETRY', { dataProduct, attempt, backoffTime: backoffTime.toFixed(0) });
                        
                        // 💡 TRACING: Trace the backoff wait time explicitly
                        await Tracing.withSpan('DataMeshQuery.backoffWait', async (waitSpan) => {
                            waitSpan.setAttribute('wait.duration_ms', backoffTime.toFixed(0));
                            await new Promise(resolve => setTimeout(resolve, backoffTime));
                        });
                    }
                }
            } finally {
                // The root span is still active here, only the concurrency limiter is released.
                concurrencyLimiter.release();
            }
        }); // End root Tracing.withSpan
    },
    
    initialize: async () => {
        Logger.info('DATAMESH_QUERY_INIT', { version: QueryClient.VERSION, maxConcurrent: MAX_CONCURRENT_QUERIES });
    },
    
    getHealth: () => ({
        breakerStatus: meshBreaker.status(),
        concurrencyStatus: concurrencyLimiter.getStatus(),
        version: QueryClient.VERSION
    })
};

module.exports = QueryClient;