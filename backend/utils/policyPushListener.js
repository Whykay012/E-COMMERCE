// utils/policyPushListener.js (REAL-TIME STREAM ORCHESTRATOR: Backoff & Authentication, TRACED)

// --- Core Dependencies ---
const WebSocketClient = require('./policyWssClient'); 
const Logger = require('./logger'); // <-- Uses ULTIMATE PINO LOGGER
const Metrics = require('./metricsClient');
const Backoff = require('exponential-backoff'); 
const AUTH_TOKEN_PROVIDER = require('../services/authService'); 
const Tracing = require('./tracingClient'); // CRITICAL: Import TracingClient

// --- Configuration ---
const MAX_RECONNECT_ATTEMPTS = 15;
const INITIAL_BACKOFF_MS = 1000;
const PUSH_SERVICE_URL = process.env.PUSH_SERVICE_URL || 'wss://policies.example.com/stream';

// --- Internal State ---
let updateHandler = null;
let isConnected = false;
let backoffInstance = null;
let lastProcessedSequenceId = 0; 

// =================================================================================
// 🛡️ STREAM MANAGEMENT & RESILIENCE
// =================================================================================

/**
 * @desc Attempts to establish the stream connection with exponential backoff.
 */
const connectStream = async () => {
    // 🚀 UPGRADE: Wrap the entire reconnection flow in a span.
    return Tracing.withSpan('PolicyPush.connectStream', async (span) => {
        
        span.setAttribute('stream.url', PUSH_SERVICE_URL);
        span.setAttribute('stream.attempt.max', MAX_RECONNECT_ATTEMPTS);
        
        const token = await AUTH_TOKEN_PROVIDER.getStreamingToken();
        if (backoffInstance) backoffInstance.reset();

        // 
        backoffInstance = Backoff.backoff(
            async () => {
                // 💡 TRACING: Start a sub-span for the actual connection attempt (excluding wait time)
                await Tracing.withSpan('WebSocket.connectAttempt', async () => {
                    await WebSocketClient.connect({ url: PUSH_SERVICE_URL, token });
                });
                isConnected = true;
                Logger.info('PUSH_LISTENER_CONNECTED');
                span.setAttribute('stream.status', 'CONNECTED');
            }, 
            {
                numOfAttempts: MAX_RECONNECT_ATTEMPTS,
                startingDelay: INITIAL_BACKOFF_MS,
                // The onRetry callback runs before the next wait
                retry: (error, attempt) => {
                    isConnected = false;
                    const shouldRetry = error.isConnectionError || error.code >= 500;
                    
                    if (shouldRetry) {
                        Metrics.increment('push_listener.reconnect_attempt');
                        // 💡 TRACING: Log the retry on the main span
                        span.addEvent('reconnect_attempt', { 
                            attempt: attempt, 
                            error_message: error.message 
                        });
                        Logger.warn('PUSH_RECONNECT_RETRY', { error: error, attempt }); 
                    } else {
                        Logger.critical('PUSH_LISTENER_FATAL_ERROR', { error: error, code: error.code }); 
                        // 🛑 TRACING: Record fatal non-retryable error
                        span.recordException(error);
                        span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Fatal Connection Error' });
                    }
                    return shouldRetry;
                }
            }
        );

        try {
            await backoffInstance;
        } catch (e) {
            Logger.critical('PUSH_LISTENER_RECONNECT_FAILED', { error: 'Exhausted all reconnect attempts.', reason: e.message });
            Metrics.increment('push_listener.fatal_disconnect');
            // 🛑 TRACING: Ensure failure status if max attempts are reached
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Max reconnection attempts reached' });
        }
    }); // End Tracing.withSpan
};

/**
 * @desc Processes incoming push messages, ensures idempotency, and forwards.
 */
const messageProcessor = (message) => {
    // 🚀 UPGRADE: Wrap message processing in a span. Since this is an incoming stream message,
    // this span will start a NEW trace unless context is propagated over WSS (highly complex).
    Tracing.withSpan('PolicyPush.processMessage', (span) => {
        Metrics.increment('push_listener.message_received');
        try {
            const update = JSON.parse(message);
            
            span.setAttribute('message.sequence_id', update.sequenceId);
            span.setAttribute('message.event_type', update.type);
            
            // Idempotency Check: Ensures we don't process the same message twice.
            if (update.sequenceId && update.sequenceId <= lastProcessedSequenceId) {
                 Metrics.increment('push_listener.message_duplicate');
                 span.setAttribute('message.status', 'DUPLICATE_SKIPPED');
                 return;
            }

            if (updateHandler) {
                updateHandler(update);
                if (update.sequenceId) lastProcessedSequenceId = update.sequenceId;
                span.setAttribute('message.status', 'PROCESSED');
            } else {
                Logger.warn('PUSH_MESSAGE_DROPPED', { reason: 'No active handler', seqId: update.sequenceId });
                span.setAttribute('message.status', 'DROPPED_NO_HANDLER');
            }
        } catch (e) {
            // Passing the error object directly
            Logger.error('PUSH_MESSAGE_PARSE_FAIL', { err: e, raw: message.substring(0, 50) }); 
            Metrics.increment('push_listener.parse_fail');
            
            // 🛑 TRACING: Record parsing failure
            span.recordException(e);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'JSON Parse Failure' });
        }
    }); // End Tracing.withSpan
};

// =================================================================================
// 💡 MODULE LIFECYCLE MANAGEMENT
// =================================================================================

const initialize = async () => {
    // 🚀 UPGRADE: Wrap initialization in a span
    return Tracing.withSpan('PolicyPush.initialize', async () => {
        WebSocketClient.on('message', messageProcessor);
        WebSocketClient.on('close', connectStream); 
        
        // Attempt the initial connection (which is already traced)
        await connectStream();
        Logger.info('PUSH_LISTENER_ENGINE_INITIALIZED');
    });
};

const shutdown = async () => {
    // 🚀 UPGRADE: Wrap shutdown for tracing
    return Tracing.withSpan('PolicyPush.shutdown', async () => {
        if (backoffInstance) backoffInstance.abort(); 
        WebSocketClient.off('message', messageProcessor);
        WebSocketClient.off('close', connectStream);
        await WebSocketClient.disconnect();
        isConnected = false;
        Logger.info('PUSH_LISTENER_SHUTDOWN');
    });
};

const handlePolicyPushUpdate = (update) => {
    // Note: The main logic for handling the update should start its own span
    if (update.key) {
        Logger.audit('POLICY_UPDATE_RECEIVED', { key: update.key, version: update.version });
    }
};

module.exports = {
    initialize,
    shutdown,
    handlePolicyPushUpdate, // Exposing the handler for subscription
    isConnected: () => isConnected,
    subscribe: (handler) => {
        if (updateHandler) Logger.warn('PUSH_LISTENER_HANDLER_OVERWRITE');
        updateHandler = handler;
        Logger.info('PUSH_LISTENER_SUBSCRIBED');
    },
    unsubscribe: () => {
        updateHandler = null;
        Logger.info('PUSH_LISTENER_UNSUBSCRIBED');
    }
};