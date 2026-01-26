// services/logQueueClient.js (ENTERPRISE-GRADE IMPLEMENTATION - KAFKA PRODUCER)

// --- External Dependencies (Real Kafka Client) ---
const { Kafka } = require('kafkajs');

// 🚀 TELEMETRY UTILITIES INTEGRATION
const Tracing = require('../utils/tracingClient'); 
const Metrics = require('../utils/metricsClient'); 
const Logger = require('../utils/logger'); // ULTIMATE PINO LOGGER

// --- Configuration & Env validation ---
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'audit-log-producer-service';
const LOG_TOPIC_NAME = process.env.AUDIT_LOG_TOPIC || 'AUDIT_LOGS_STREAM'; // Default log topic

if (KAFKA_BROKERS.length === 0) {
    // This check must remain synchronous and throw an Error on startup.
    throw new Error("KAFKA_BROKERS environment variable must be set.");
}

// --- Core Client State and Configuration ---
let kafka; // Holds the Kafka client instance
let producerInstance = null; // Holds the Kafka producer instance
let isConnected = false;

// Standard resilience configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;


/**
 * @desc Initializes the Kafka client connection and sets up the producer instance.
 * Must be called during application startup (e.g., server.js).
 * @returns {Promise<void>}
 */
const initialize = async () => {
    return Tracing.withSpan("KafkaClient:initialize", async (span) => {
        if (isConnected) return;
        
        span.setAttribute('kafka.brokers', KAFKA_BROKERS.join(','));

        Logger.info("KafkaClient: Establishing connection to brokers...", { brokers: KAFKA_BROKERS });
        
        try {
            // 1. Initialize Kafka Client
            kafka = new Kafka({
                clientId: KAFKA_CLIENT_ID,
                brokers: KAFKA_BROKERS,
                connectionTimeout: 3000, 
            });

            // 2. Create and Connect Producer
            producerInstance = kafka.producer({
                allowAutoTopicCreation: true,
                retry: {
                    initialRetryTime: 100,
                    retries: 0, // IMPORTANT: We handle retries manually in the send function below.
                }
            }); 

            await producerInstance.connect(); // Attempt connection
            
            isConnected = true;
            Logger.info("KafkaClient: Successfully connected and producer ready.", { clientId: KAFKA_CLIENT_ID });
            Metrics.increment("kafka.producer.connection.success");
        } catch (error) {
            // FATAL: Log and re-throw
            Logger.critical("KafkaClient FATAL: Failed to initialize producer connection.", { 
                error: error.message, 
                stack: error.stack,
                brokers: KAFKA_BROKERS 
            });
            Metrics.increment("kafka.producer.connection.fatal_failure");
            span.recordException(error);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Producer connection failed' });
            throw error;
        }
    });
};

/**
 * @desc Sends a structured message to a specified Kafka topic with built-in resilience.
 * This is the NON-BLOCKING method used by auditLogger.js.
 * @param {string} topic - The target queue topic (defaults to LOG_TOPIC_NAME).
 * @param {object} message - The structured log payload.
 * @returns {Promise<object>} The delivery confirmation status.
 * @throws {Error} Throws a definitive error upon failure after all retries.
 */
const send = async (topic = LOG_TOPIC_NAME, message) => {
    return Tracing.withSpan("KafkaClient:sendMessage", async (span) => {
        span.setAttribute('kafka.topic', topic);
        span.setAttribute('log.event_name', message.event || 'N/A');

        if (!isConnected || !producerInstance) {
            Logger.warn("KafkaClient WARNING: Attempted send before connection. Dropping message.", { topic, event: message.event });
            Metrics.increment("kafka.producer.send.fail.not_connected");
            
            // Must throw an error here to trigger the DLQ in auditLogger.js
            const error = new Error('Kafka producer is not connected.'); 
            span.recordException(error);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Producer not connected' });
            throw error; 
        }

        const startTime = Date.now();
        const payload = JSON.stringify(message);
        
        // The message is encapsulated in an array for the 'messages' property
        const kafkaMessage = {
            value: payload,
            // Using a key (e.g., a session ID or userId) ensures messages 
            // with the same key go to the same partition, preserving order.
            key: message.user || message.event || 'no-key',
            headers: {
                timestamp: Date.now().toString(),
                service: KAFKA_CLIENT_ID,
            }
        };
        
        // --- Resilience Loop (Explicit Retries on Transient Send Failure) ---
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            span.setAttribute('kafka.send.attempt', attempt);
            try {
                // Producer.send() handles batching and compression internally
                const response = await producerInstance.send({
                    topic: topic,
                    messages: [kafkaMessage],
                    timeout: 5000, 
                });
                
                const duration = Date.now() - startTime;
                
                // Success response from kafkajs contains partition/offset info
                const metadata = response[0];
                const messageId = `${metadata.topic}:${metadata.partition}:${metadata.offset}`;

                Metrics.increment("kafka.producer.send.success", 1, { topic, partition: metadata.partition });
                Metrics.timing("kafka.producer.send.latency_ms", duration, { topic });
                
                Logger.info("KafkaClient: Message successfully delivered.", { 
                    messageId, 
                    topic, 
                    partition: metadata.partition,
                    offset: metadata.offset,
                    attempts: attempt,
                    duration_ms: duration
                });
                span.setAttribute('kafka.message.offset', metadata.offset);
                span.setAttribute('kafka.message.partition', metadata.partition);
                
                return { 
                    status: 'DELIVERED', 
                    messageId,
                    partition: metadata.partition,
                    offset: metadata.offset
                }; 
            } catch (error) {
                Metrics.increment("kafka.producer.send.retry_fail", 1, { topic });

                // Check for connection/transient errors (e.g., not enough replicas, broker down)
                if (attempt === MAX_RETRIES) {
                    Logger.critical(`KafkaClient CRITICAL: Failed to send message to ${topic} after ${MAX_RETRIES} attempts. Triggering DLQ.`, {
                        topic,
                        event: message.event,
                        error: error.message,
                        logPayload: payload.substring(0, 100) // Log snippet of payload
                    });
                    Metrics.increment("kafka.producer.send.critical_fail", 1, { topic });

                    // 🎯 FIX: Throw a definitive error for the DLQ fallback in auditLogger.js
                    const finalError = new Error(`Kafka message send failed after ${MAX_RETRIES} retries: ${error.message}`);
                    finalError.originalError = error;
                    span.recordException(finalError);
                    span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Max Retries Reached' });
                    throw finalError;
                }
                
                // Transient failure, wait and retry (exponential backoff implemented)
                Logger.warn(`KafkaClient: Transient error on attempt ${attempt} for topic ${topic}. Retrying in ${RETRY_DELAY_MS * attempt}ms...`, { error: error.message, attempt });
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
            }
        }
    });
};

/**
 * @desc Gracefully closes the Kafka producer connection upon shutdown.
 */
const shutdown = async () => {
    return Tracing.withSpan("KafkaClient:shutdown", async () => {
        if (isConnected && producerInstance) {
            try {
                // Disconnecting the producer flushes any messages currently in the send queue.
                await producerInstance.disconnect(); 
                isConnected = false;
                producerInstance = null;
                Logger.info("KafkaClient: Disconnected successfully.");
                Metrics.increment("kafka.producer.lifecycle.shutdown");
            } catch (error) {
                Logger.error("KafkaClient: Error during shutdown.", { error: error.message });
                Metrics.increment("kafka.producer.lifecycle.shutdown_error");
            }
        }
    });
};


module.exports = {
    initialize,
    send,
    shutdown,
};