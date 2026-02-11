// services/messageBrokerClient.js

const { Kafka, logLevel } = require('kafkajs'); 
const logger = require('../utils/logger'); 
const { v4: uuidv4 } = require('uuid'); // Needed for default idempotency key

// --- Configuration (Defaults & Environment Variables) ---
const KAFKA_BROKERS = process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092'];
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'inventory-service-producer';
const CONNECTION_RETRIES = parseInt(process.env.KAFKA_CONNECT_RETRIES || '5');
const RETRY_DELAY_MS = parseInt(process.env.KAFKA_RETRY_DELAY_MS || '3000');

// --- Kafka Client Setup ---
const kafka = new Kafka({
    clientId: CLIENT_ID,
    brokers: KAFKA_BROKERS,
    logLevel: logLevel.WARN, // Reduce verbose logging unless needed
    retry: { 
        initialRetryTime: 100,
        maxRetryTime: 30000,
        retries: 20 // High retry count for transient network failures during send
    }
    // Production Authentication and TLS should be configured here:
    // ssl: true, 
    // sasl: { mechanism: 'aws', ... }, 
});

// The Producer instance
const producer = kafka.producer({
    allowAutoTopicCreation: false, // ZENITH: Must be managed externally
    transactionalId: `${CLIENT_ID}-tx`, // Required for Exactly-Once Semantics
    // Fine-tune batching for performance:
    batchSize: 16384, // 16kb
    linger: 10,       // 10ms wait time
});

let isConnected = false;

/**
 * @desc Attempts to connect the Kafka Producer with robust retry logic.
 */
const connectProducer = async () => {
    if (isConnected) return;
    
    for (let i = 0; i < CONNECTION_RETRIES; i++) {
        try {
            await producer.connect();
            isConnected = true;
            logger.info(`[Kafka] Producer connected successfully on attempt ${i + 1}.`);
            return;
        } catch (error) {
            logger.warn(`[Kafka] Connection attempt ${i + 1} failed: ${error.message}. Retrying in ${RETRY_DELAY_MS}ms.`);
            if (i === CONNECTION_RETRIES - 1) {
                logger.error('[Kafka] FATAL: All connection attempts failed.');
                throw new Error("KAFKA_CONNECTION_FAILED");
            }
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
};

/**
 * @desc Sends a single message to a Kafka topic, enforcing JSON serialization.
 * @param {string} topic - The target Kafka topic.
 * @param {object} payload - The message content.
 * @param {string} [idempotencyKey] - Optional key for partition-level ordering. Defaults to UUID.
 */
const sendMessage = async (topic, payload, idempotencyKey) => {
    if (!isConnected) {
        throw new Error('Kafka producer is not connected. Check connection status.');
    }
    
    // ZENITH ENHANCEMENT: Provide a default key for resilience if not passed
    const messageKey = idempotencyKey || uuidv4(); 
    
    try {
        const message = {
            value: JSON.stringify(payload),
            key: messageKey, // Used for message ordering within a partition
            headers: {
                'timestamp': new Date().toISOString(),
                'producerId': CLIENT_ID,
            }
        };

        const result = await producer.send({
            topic: topic,
            messages: [message],
            acks: -1, // Highest durability: Wait for all in-sync replicas
        });

        // The result contains the topic, partition, and offset where the message was written.
        const jobId = `${result[0].baseOffset}-${result[0].topicName}-${result[0].partition}`;
        logger.info(`[Kafka] Published message to topic '${topic}' with offset/job ID: ${jobId}`);
        
        return jobId;

    } catch (error) {
        logger.error(`[Kafka] Failed to send message to topic ${topic} (Key: ${messageKey}):`, error);
        // Map Kafka errors to a clean internal error type
        throw new Error(`Failed to dispatch event to queue: ${error.name}`);
    }
};

/**
 * @desc Sends multiple messages to the same topic transactionally (Exactly-Once Semantics).
 * IMPORTANT: This should ONLY be used for topics requiring E-O-S (e.g., financial ledger updates).
 * @param {string} topic 
 * @param {Array<object>} messages - Array of payloads.
 * @param {string} transactionId - A unique ID for this transaction (e.g., orderId or sagaId).
 * @returns {Array<string>} Array of message IDs (offsets).
 */
const sendTransactionalMessages = async (topic, messages, transactionId) => {
    if (!isConnected) {
        throw new Error('Kafka producer is not connected.');
    }
    if (!transactionId) {
        throw new Error('Transaction ID is required for transactional messages.');
    }

    const transaction = await producer.transaction();
    
    try {
        const kafkaMessages = messages.map((payload, index) => ({
            value: JSON.stringify(payload),
            key: transactionId, // Use the same transaction ID key for ordering
            headers: {
                'timestamp': new Date().toISOString(),
                'producerId': CLIENT_ID,
                'transactionIndex': index.toString(),
            }
        }));

        await transaction.send({
            topic: topic,
            messages: kafkaMessages,
        });

        await transaction.commit();
        logger.info(`[Kafka] Transaction ${transactionId} committed successfully to topic ${topic}. Messages sent: ${messages.length}`);
        
        // Return a stable transaction ID instead of volatile offsets
        return [transactionId]; 

    } catch (error) {
        // Rollback ensures that none of the messages are visible to consumers
        await transaction.abort(); 
        logger.error(`[Kafka] Transaction ${transactionId} failed and rolled back:`, error);
        throw new Error(`Transactional send failed and was aborted: ${error.name}`);
    }
};


// At the top of messageBrokerClient.js with your other variables
const activeConsumers = []; // 💡 Track consumers for graceful exit

/**
 * @desc Subscribes to a topic and tracks the consumer for lifecycle management.
 */
const subscribe = async (topic, groupId, onMessage) => {
    const consumer = kafka.consumer({ groupId });
    
    try {
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: false });

        await consumer.run({
            eachMessage: async ({ message }) => {
                try {
                    const payload = JSON.parse(message.value.toString());
                    await onMessage(payload);
                } catch (parseError) {
                    logger.error(`[Kafka:Consumer] Failed to parse JSON`, { topic, error: parseError.message });
                }
            },
        });

        activeConsumers.push(consumer); // 💡 Store for shutdown
        logger.info(`[Kafka] Consumer ${groupId} active on ${topic}`);
        return consumer;
    } catch (error) {
        logger.error(`[Kafka] Subscription failed`, { topic, error: error.message });
        throw error;
    }
};

/**
 * @desc Full cleanup: Disconnects producer AND all active consumers.
 */
const disconnectAll = async () => {
    logger.info('[Kafka] Initiating full cluster disconnect...');
    
    // 1. Clean up Producer
    if (isConnected) {
        try {
            await producer.disconnect();
            isConnected = false;
            logger.info('[Kafka] Producer disconnected.');
        } catch (err) {
            logger.error('[Kafka] Producer disconnect error', { error: err.message });
        }
    }

    // 2. Clean up Consumers
    for (const consumer of activeConsumers) {
        try {
            await consumer.disconnect();
            logger.info('[Kafka] Consumer closed safely.');
        } catch (err) {
            logger.error('[Kafka] Consumer disconnect error', { error: err.message });
        }
    }
};

// Update your exports
module.exports = {
    connectProducer,
    sendMessage,
    sendTransactionalMessages,
    subscribe,
    disconnectProducer: disconnectAll, // 💡 Map old name to new full-cleanup logic
};
