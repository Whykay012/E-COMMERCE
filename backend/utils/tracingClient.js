// utils/tracingClient.js (OPEN-TELEMETRY CONTEXT MANAGER: Resilient & Context-Aware)

// --- External Dependencies (Conceptual OpenTelemetry/OTel SDK) ---
// NOTE: These dependencies assume you have the respective @opentelemetry packages installed.
const { trace, context, propagation, diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const OTLPExporter = require('./otelExporter'); // Assumed OTLP/gRPC/HTTP Exporter stub
const Logger = require('./logger');

// --- Configuration ---
const SERVICE_NAME = process.env.SERVICE_NAME || 'recommendation-gateway';
const TRACING_ENABLED = process.env.TRACING_ENABLED === 'true';

// --- Internal State ---
let tracer = null;
let isInitialized = false;

// =================================================================================
// 🛡️ INITIALIZATION AND RESILIENCE
// =================================================================================

/**
 * @desc Initializes the OpenTelemetry tracing provider and exporter. 
 */
const initialize = async () => {
    if (!TRACING_ENABLED) {
        Logger.warn('TRACING_DISABLED', { reason: 'TRACING_ENABLED environment variable is false.' });
        // Set up a no-op tracer to prevent application crashes
        tracer = trace.getTracer(SERVICE_NAME);
        return;
    }

    try {
        // 1. Configure the Telemetry Diagnostics (for OTel internal errors)
        diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

        // 2. Define Service Resource
        const resource = Resource.default().merge(
            new Resource({
                [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
                [SemanticResourceAttributes.SERVICE_VERSION]: process.env.GIT_COMMIT_SHA || 'N/A',
            })
        );

        // 3. Setup Tracer Provider
        const provider = new NodeTracerProvider({ resource });

        // 4. Setup Exporter and Processor
        // NOTE: OTLPExporter needs to be implemented/imported correctly from your OTel SDK packages.
        const exporter = new OTLPExporter({ endpoint: process.env.OTEL_EXPORTER_ENDPOINT });
        // Batching processor is crucial for performance (sends spans in batches)
        provider.addSpanProcessor(new BatchSpanProcessor(exporter));

        // 5. Register Provider (Makes it the global instance)
        provider.register();

        // 6. Get the tracer instance
        tracer = trace.getTracer(SERVICE_NAME, '1.0.0');
        isInitialized = true;

        Logger.info('TRACING_INITIALIZED', { exporter: process.env.OTEL_EXPORTER_ENDPOINT });
    } catch (e) {
        Logger.critical('TRACING_INIT_FAILED', { error: e.message, action: 'Running in No-Op Mode' });
        tracer = trace.getTracer(SERVICE_NAME); // Default to No-Op Tracer on failure
    }
};

/**
 * @desc Shuts down the tracer provider, ensuring all pending spans are exported.
 */
const shutdown = async () => {
    if (!isInitialized || !TRACING_ENABLED) return;

    const provider = trace.getTracerProvider();
    // In Node.js, the provider has the shutdown method
    if (provider && typeof provider.shutdown === 'function') {
        // Force flush all remaining spans before exiting
        await provider.shutdown();
        Logger.info('TRACING_SHUTDOWN_FLUSHED');
    }
    isInitialized = false;
};

// =================================================================================
// 🔗 CONTEXT PROPAGATION AND ACCESS
// =================================================================================

/**
 * @desc Synchronously retrieves the current trace and span IDs from the active context.
 * Essential for log enrichment and audit trails.
 * @returns {{traceId: string|undefined, spanId: string|undefined}}
 */
const getCurrentContext = () => {
    if (!isInitialized) return { traceId: undefined, spanId: undefined };

    const spanContext = trace.getSpanContext(context.active());
    
    return {
        traceId: spanContext?.traceId,
        spanId: spanContext?.spanId,
    };
};

/**
 * @desc Injects tracing headers into an object (e.g., HTTP headers) for downstream services.
 * @param {object} carrier - The object to inject headers into (e.g., `{ headers: {} }`).
 * @returns {object} The carrier object with added headers (e.g., `traceparent`).
 */
const injectTracingHeaders = (carrier) => {
    if (!isInitialized) return carrier;

    // Uses the OTel TextMapPropagator to ensure standard header format (W3C Trace Context)
    propagation.inject(context.active(), carrier);
    return carrier;
};

// =================================================================================
// ✍️ TRACING API (BUSINESS LOGIC INTEGRATION)
// =================================================================================

/**
 * @desc Starts a new span tied to the current active context (or creates a new trace if none exists).
 * Use this primarily for custom instrumentation where you manage the span lifecycle manually.
 * @param {string} name - The descriptive name of the operation (e.g., 'DB_FETCH_USER').
 * @param {object} [attributes={}] - Key-value metadata to attach to the span.
 * @returns {object} The new active span instance.
 */
const startSpan = (name, attributes = {}) => {
    if (!isInitialized) return { end: () => {}, setAttribute: () => {}, setStatus: () => {}, isRecording: () => false }; // No-Op Span

    const newSpan = tracer.startSpan(name, { attributes });
    
    // ⚠️ CORRECTION: The line below was incomplete. This line sets the span as the active context.
    const activeContext = trace.setSpan(context.active(), newSpan);
    
    // We bind the context to the execution flow.
    // In most async scenarios, using `withSpan` is safer.
    context.makeActive(activeContext); 
    
    return newSpan;
};

/**
 * @desc Execute a function within the context of a new span.
 * This is the preferred method for instrumenting asynchronous code as it handles context and span lifecycle automatically.
 * @param {string} name - The name of the span.
 * @param {function} fn - The function to execute. The span is passed as the first argument.
 * @returns {Promise<T>} The result of the executed function.
 */
const withSpan = (name, fn) => {
    if (!isInitialized) return fn(); 

    return tracer.startActiveSpan(name, async (span) => {
        try {
            const result = await fn(span);
            span.setStatus({ code: trace.SpanStatusCode.OK }); // Use the exposed status code
            return result;
        } catch (error) {
            span.setStatus({ code: trace.SpanStatusCode.ERROR, message: error.message }); // Use the exposed status code
            span.recordException(error);
            throw error;
        } finally {
            span.end();
        }
    });
};


module.exports = {
    initialize,
    shutdown,
    getCurrentContext,
    injectTracingHeaders,
    startSpan,
    withSpan, // The primary way to instrument asynchronous functions
    isInitialized: () => isInitialized,
    
    // 💡 ADVANCE: Expose OTel Status Codes for external use (e.g., setting span status in other modules)
    SpanStatusCode: trace.SpanStatusCode 
};