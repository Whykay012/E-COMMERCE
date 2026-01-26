// utils/otelExporter.js (ADVANCED OTLP EXPORTER STUB: Simulating Resilience)

const Logger = require('./logger'); 
const { diag, DiagLogLevel } = require('@opentelemetry/api');

// --- Configuration ---
const MAX_EXPORT_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const EXPORT_ENDPOINT = process.env.OTEL_EXPORTER_ENDPOINT || 'http://localhost:4318/v1/traces';

// Set up OTel diagnostics just for this exporter module
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

class OTLPExporter {
    /**
     * @desc Initializes the exporter with configuration.
     * @param {object} options - Exporter configuration options (endpoint, headers, etc.).
     */
    constructor(options = {}) {
        this.endpoint = options.endpoint || EXPORT_ENDPOINT;
        this.isShutdown = false;
        Logger.info('OTLP_EXPORTER_INIT', { endpoint: this.endpoint });
    }

    /**
     * @desc Required OpenTelemetry method. Sends a batch of spans to the OTLP receiver.
     * This method must be resilient and asynchronous, as it's typically called by a BatchSpanProcessor.
     * * @param {Array<Span>} spans - An array of span objects to be exported.
     * @param {function} done - The callback function to signal completion (success or failure).
     */
    export(spans, done) {
        if (this.isShutdown) {
            Logger.warn('OTLP_EXPORT_REJECTED', { reason: 'Exporter is shut down.' });
            return done({ code: 1, message: 'Exporter shut down' }); // Code 1 for non-OK status
        }

        let attempt = 0;

        const performExport = async () => {
            try {
                // 1. Convert Spans to OTLP format (Mocked)
                const otlpPayload = this._toOtlpPayload(spans);

                // 2. Simulate HTTP/gRPC Network Request
                const success = await this._simulateNetworkSend(otlpPayload, this.endpoint);

                if (success) {
                    Logger.debug('OTLP_EXPORT_SUCCESS', { count: spans.length, attempt: attempt + 1 });
                    done({ code: 0 }); // Code 0 for success/OK status
                } else {
                    throw new Error('Simulated network failure.');
                }
            } catch (error) {
                if (attempt < MAX_EXPORT_RETRIES) {
                    attempt++;
                    Logger.warn('OTLP_EXPORT_RETRY', { attempt, max: MAX_EXPORT_RETRIES, error: error.message });
                    setTimeout(performExport, RETRY_DELAY_MS * attempt); // Exponential backoff simulation
                } else {
                    Logger.error('OTLP_EXPORT_FAIL', { count: spans.length, finalError: error.message });
                    // Inform the processor that the export failed
                    done({ code: 1, message: `Failed after ${MAX_EXPORT_RETRIES} attempts.` });
                }
            }
        };

        performExport();
    }

    /**
     * @desc Required OpenTelemetry method. Ensures all buffered spans are sent and cleans up resources.
     * @returns {Promise<void>}
     */
    async shutdown() {
        if (this.isShutdown) return;
        this.isShutdown = true;
        
        // 🚨 REAL LIFE UPGRADE: If the exporter had an internal buffer, it would be flushed here.
        // Since BatchSpanProcessor handles primary buffering, we just simulate graceful termination.

        await new Promise(resolve => setTimeout(resolve, 50)); // Simulate closing HTTP connection/stream
        Logger.info('OTLP_EXPORTER_SHUTDOWN');
    }

    // =========================================================================
    // ⚙️ PRIVATE HELPER METHODS (MOCK)
    // =========================================================================

    /**
     * @desc Mocks the transformation of OTel Span objects into the OTLP wire format.
     */
    _toOtlpPayload(spans) {
        // In a real exporter, this handles serialization (JSON, Protobuf)
        return {
            resourceSpans: spans.map(s => ({ 
                traceId: s.context.traceId, 
                spanId: s.context.spanId, 
                name: s.name 
            }))
        };
    }

    /**
     * @desc Simulates the network POST request with failure and latency.
     * @returns {Promise<boolean>} Resolves to true on success, throws on failure.
     */
    _simulateNetworkSend(payload, url) {
        return new Promise((resolve, reject) => {
            // Success probability: 85% success on first try, decreasing with simulated back-pressure
            const successThreshold = 0.85; 

            if (Math.random() < successThreshold) {
                // Simulated success
                setTimeout(() => resolve(true), Math.random() * 20); 
            } else {
                // Simulated failure
                setTimeout(() => reject(new Error('OTLP Collector Unavailable/Network Timeout')), Math.random() * 5); 
            }
        });
    }
}

module.exports = OTLPExporter;