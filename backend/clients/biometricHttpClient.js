// clients/biometricHttpClient.js (Nexus Zenith Apex Enterprise FINAL)

const axios = require('axios');
// Use the final, advanced utility clients as defaults
const TracingClient = require('../utils/tracingClient'); 
const MetricsClient = require('../utils/metricsClient'); // The new semantic metrics client

/**
 * Creates a dedicated, pre-configured, and injectable Axios client instance.
 * It is integrated with Auditing, Metrics, and Tracing for full observability.
 * @param {Object} config - Configuration object (endpoint, apiKey, timeout).
 * @param {Object} dependencies - External dependencies.
 * @param {Object} dependencies.auditLogger - Logger instance for auditing (Uses semantic methods like .error, .warn).
 * @param {Object} dependencies.metricLogger - Metrics reporting instance (Uses semantic methods like .timing, .increment).
 * @param {Object} [dependencies.tracingClient=TracingClient] - Optional tracing client.
 * @returns {axios.AxiosInstance}
 */
const createBiometricClient = ({ endpoint, apiKey, timeout = 15000 }, { 
    auditLogger, 
    metricLogger = MetricsClient, // Use the new Metrics Client by default
    tracingClient = TracingClient 
}) => {
    
    // 1. Create a dedicated Axios instance
    const client = axios.create({
        baseURL: endpoint,
        timeout: timeout,
        headers: {
            'X-API-Key': apiKey, 
            'Content-Type': 'application/json',
            'Accept': 'application/json' 
        }
    });

    // 2. Request Interceptor: Start Timer and Inject TRACING Headers 
    client.interceptors.request.use(
        (config) => {
            // Attach a start time for precise latency calculation
            config.metadata = config.metadata || {};
            config.metadata.startTime = process.hrtime();
            
            // 💡 TRACING INTEGRATION: Inject W3C Trace Context Headers 
            try {
                // The injectTracingHeaders function adds traceparent/tracestate headers to config.headers
                tracingClient.injectTracingHeaders(config.headers);
                config.metadata.traceId = tracingClient.getCurrentContext().traceId || 'N/A';
            } catch (e) {
                // Use the semantic logging method
                auditLogger.warn('TRACING_HEADER_INJECTION_FAILED', { error: e.message });
            }
            
            return config;
        },
        (error) => {
            // Error before request is sent (e.g., network configuration failure)
            auditLogger.critical('BIOMETRIC_HTTP_REQUEST_PRE_SEND_ERROR', { message: error.message, code: error.code });
            return Promise.reject(error);
        }
    );

    // 3. Response Interceptor: Stop Timer, Log Success, Report Metrics
    client.interceptors.response.use(
        (response) => {
            const duration = process.hrtime(response.config.metadata.startTime);
            const durationMs = (duration[0] * 1000) + (duration[1] / 1e6);
            
            // Define metric tags for context
            const metricTags = { 
                status: response.status, 
                url_path: response.config.url, 
                method: response.config.method 
            };

            // 💡 METRICS ADVANCE: Use the semantic 'timing' function
            metricLogger.timing('biometric.http.roundtrip.latency', durationMs, metricTags);
            // Use the semantic 'increment' function
            metricLogger.increment(`biometric.http.status.${response.status}`, 1, metricTags);

            // Log successful request details (using semantic audit logger)
            auditLogger.audit('BIOMETRIC_HTTP_RESPONSE_SUCCESS', { 
                entityId: response.config.metadata.traceId || 'N/A', 
                action: 'API_CALL_SUCCESS',
                status: response.status, 
                url: response.config.url, 
                duration: `${durationMs.toFixed(3)}ms`
            });
            
            return response;
        },
        // 4. Error Interceptor: Log Failure, Report Metrics, Calculate Latency
        (error) => {
            const config = error.config || {};
            const traceId = config?.metadata?.traceId || 'N/A';
            let durationMs = -1;
            
            if (config.metadata?.startTime) {
                const duration = process.hrtime(config.metadata.startTime);
                durationMs = (duration[0] * 1000) + (duration[1] / 1e6);
                metricLogger.timing('biometric.http.failed_roundtrip.latency', durationMs, { traceId });
            }
            
            // Determine the nature of the error
            const isTimeout = error.code === 'ECONNABORTED';
            const isNetworkError = error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND';
            const isHttpError = !!error.response;
            
            const status = isHttpError ? error.response.status : (isTimeout ? 408 : 500);
            const errorType = isTimeout ? 'TIMEOUT' : (isNetworkError ? 'NETWORK_FAIL' : (isHttpError ? 'HTTP_FAIL' : 'UNKNOWN'));
            const data = error.response ? error.response.data : { code: error.code, message: error.message };
            
            const metricTags = { status, error_type: errorType, method: config.method };
            
            // 💡 METRICS ADVANCE: Use the semantic 'increment' function
            metricLogger.increment(`biometric.http.error`, 1, metricTags);
            
            // Log the network/HTTP error with semantic details (using semantic error logger)
            auditLogger.error(`BIOMETRIC_HTTP_ERROR_${errorType}`, { 
                status, 
                message: error.message, 
                data, 
                durationMs: durationMs.toFixed(3),
                traceId,
                err: error // Attach the original error object for stack trace
            });

            // Re-throw the original error for the `retryStrategy`
            return Promise.reject(error);
        }
    );

    return client;
};

module.exports = createBiometricClient;