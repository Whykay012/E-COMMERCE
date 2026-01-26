"use strict";

const EventEmitter = require('events');
const ws = require('ws'); 
const Logger = require('./logger'); 
const Tracing = require('./tracingClient'); 
const Metrics = require('./metricsClient'); 

// --- Custom Error for Backoff Logic ---
/**
 * Custom error class used to signal the PolicyPushListener  
 * whether to retry or fail the backoff process.
 */
class ConnectionError extends Error {
    constructor(message, code, isConnectionError = false) {
        super(message);
        this.name = 'ConnectionError';
        this.code = code;
        this.isConnectionError = isConnectionError; // Flag for exponential-backoff logic
        Error.captureStackTrace(this, ConnectionError);
    }
}

// --- Client State ---
class PolicyWssClient extends EventEmitter {
    constructor() {
        super();
        this.client = null;
        this.url = null;
        this.connectionAttempts = 0; // New: Track connection attempts for metrics
    }

    /**
     * @desc Establishes a WebSocket connection with authentication and tracing context injection.
     * @param {object} config - Configuration object.
     * @param {string} config.url - WebSocket endpoint URL.
     * @param {string} config.token - Authentication token (e.g., JWT).
     */
    async connect({ url, token }) {
        this.connectionAttempts++;
        Metrics.increment('wss.connection_attempt', 1, { attempt: this.connectionAttempts });
        
        // 🚀 TRACING: Inherit current span context or start a new one if not present
        return Tracing.withSpan('WssClient.connect', async (span) => {
            if (this.client) {
                await this.disconnect();
            }

            this.url = url;
            span.setAttribute('wss.url', url);
            
            return new Promise((resolve, reject) => {
                try {
                    let headers = { 'Authorization': `Bearer ${token}` };
                    
                    // 🔑 ENHANCEMENT: Inject OpenTelemetry trace context into the handshake headers
                    const carrier = { headers };
                    Tracing.injectTracingHeaders(carrier);
                    headers = carrier.headers;

                    this.client = new ws(url, {
                        handshakeTimeout: 5000, 
                        headers: headers
                    });

                    this.client.on('open', () => {
                        // 🔑 ENHANCEMENT: Use Logger.audit for successful connection establishment
                        Logger.audit('WSS_CONNECTION_SUCCESS', { url, action: 'connect', entityId: this.url });
                        
                        Metrics.increment('wss.connection_success');
                        span.setAttribute('wss.status', 'open');
                        this.setupListeners();
                        resolve();
                    });

                    this.client.on('error', (error) => {
                        const code = error.code || 500;
                        
                        // Set span status for failed connection
                        span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: `Connect error: ${error.message}` });
                        span.recordException(error);
                        
                        Logger.error('WSS_CLIENT_ERROR', { url, error: error.message, code: code });
                        Metrics.increment('wss.connection_error', 1, { code: code.toString() });
                        
                        // Determine retryability based on system/network errors or generic 5xx status
                        const isRetryable = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(error.code) || code >= 500;
                        
                        // Clean up error listener
                        this.client.removeAllListeners('error');
                        
                        reject(new ConnectionError(
                            `WSS connection failed: ${error.message}`, 
                            code, 
                            isRetryable
                        ));
                    });
                    
                    this.client.on('unexpected-response', (req, res) => {
                         const status = res.statusCode;
                         
                         // Treat 401/403 (Auth/Forbidden) as Security/Critical failure
                         if (status >= 400 && status < 500) {
                             Logger.security('WSS_HANDSHAKE_AUTH_FAIL', { url, status, userId: 'UNKNOWN', eventCode: 'WSS_AUTH_4XX' });
                             Metrics.increment('wss.connection_auth_fail', 1, { status });
                         } else {
                             Logger.critical('WSS_UNEXPECTED_RESPONSE', { url, status });
                         }

                         const isRetryable = status >= 500;
                         span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: `Handshake failed with status: ${status}` });
                         
                         this.client.close();
                         reject(new ConnectionError(
                             `WSS handshake failed with status: ${status}`,
                             status,
                             isRetryable 
                         ));
                    });

                } catch (e) {
                    Logger.critical('WSS_CLIENT_INSTANTIATION_FAIL', { error: e.message });
                    Metrics.increment('wss.instantiation_fail');
                    reject(new ConnectionError(`WSS client instantiation failed: ${e.message}`, 500, true));
                }
            });
        }); // End Tracing.withSpan
    }

    /**
     * @desc Sets up persistent listeners after a successful connection.
     */
    setupListeners() {
        if (!this.client) return;
        
        this.client.removeAllListeners('error'); 
        
        this.client.on('message', (data) => {
            // Metrics for incoming data
            Metrics.increment('wss.message_received');
            Metrics.timing('wss.message_size_bytes', data.length);
            this.emit('message', data.toString()); 
        });

        this.client.on('close', (code, reason) => {
            const reasonStr = reason.toString() || 'No reason provided';
            
            // 🔑 ENHANCEMENT: Use AUDIT logging for unexpected close codes
            if (code !== 1000 && code !== 1001) {
                 Logger.audit('WSS_CONNECTION_UNEXPECTED_CLOSE', { 
                    url: this.url, 
                    action: 'close', 
                    entityId: this.url, 
                    code, 
                    reason: reasonStr 
                });
            } else {
                 Logger.info('WSS_CLIENT_CLOSED_NORMAL', { url: this.url, code });
            }
            
            Metrics.increment('wss.connection_close', 1, { code });
            this.client = null;
            this.emit('close', { code, reason: reasonStr }); // Emit close event with details
        });

        this.client.on('error', (error) => {
            // These are runtime errors (e.g., severe socket issue after open)
            Logger.error('WSS_CLIENT_RUNTIME_ERROR', { url: this.url, error: error.message });
            Metrics.increment('wss.runtime_error');
            // Force a close event to trigger immediate reconnect attempt via PolicyPushListener
            this.client.close(1006, 'Runtime Error'); 
        });
    }

    /**
     * @desc Gracefully closes the WebSocket connection.
     */
    async disconnect() {
        return Tracing.withSpan('WssClient.disconnect', async () => {
            if (this.client) {
                this.client.removeAllListeners();
                
                // 1000 is a normal closure
                this.client.close(1000, 'Shutdown requested'); 
                this.client = null;
                // 🔑 ENHANCEMENT: Audit log for graceful shutdown
                Logger.audit('WSS_CONNECTION_DISCONNECTED', { url: this.url, action: 'disconnect', entityId: this.url, code: 1000 });
            }
        });
    }

    /**
     * @desc Sends a message over the WebSocket (e.g., for subscription or pong).
     */
    send(data) {
        if (this.client && this.client.readyState === ws.OPEN) {
            this.client.send(data, (err) => {
                if (err) {
                    Logger.error('WSS_SEND_ERROR_NETWORK', { url: this.url, error: err.message });
                    Metrics.increment('wss.message_send_fail', 1, { reason: 'network' });
                } else {
                    Metrics.increment('wss.message_sent'); 
                }
            });
        } else {
            Metrics.increment('wss.message_send_fail', 1, { reason: 'not_open' });
            Logger.warn('WSS_SEND_FAILED', { reason: 'Client not open or connecting' });
        }
    }
}

// Export a singleton instance
module.exports = new PolicyWssClient();