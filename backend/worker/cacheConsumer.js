/**
 * workers/cacheConsumer.js
 * ZENITH OMEGA - Cache Invalidation Worker (Kafka)
 */
const { Kafka } = require('kafkajs');
const cache = require("../services/redisCacheUtil");
const logger = require("../config/logger");
const Metrics = require("../utils/metricsClient");

const kafka = new Kafka({
    clientId: 'omega-cache-cluster',
    brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']
});

const consumer = kafka.consumer({ groupId: 'cache-invalidation-group' });

/**
 * @desc Connects and starts the Kafka polling loop
 */
const startCacheConsumer = async () => {
    try {
        await consumer.connect();
        // Subscribe to the invalidation topic
        await consumer.subscribe({ topic: 'cache-invalidation-topic', fromBeginning: false });

        logger.info("[Kafka:Consumer] Cache Invalidation Worker online and subscribed.");

        await consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                const startTime = Date.now();
                
                try {
                    const rawData = message.value.toString();
                    const payload = JSON.parse(rawData);

                    logger.debug(`[Cache:Purge] Processing ${payload.action} for User: ${payload.userId}`);

                    if (payload.action === 'PURGE_USER') {
                        // 1. Generate keys to invalidate based on user prefix
                        const userPrefix = `notifs:u:${payload.userId}:*`;
                        
                        // 2. Perform the delete via the shared redis client
                        const keys = await cache.client.keys(userPrefix);
                        if (keys.length > 0) {
                            await cache.client.del(...keys);
                            logger.info(`[Cache:Purge] Successfully invalidated ${keys.length} keys for user ${payload.userId}`);
                        }
                    }

                    // 3. Track Metrics
                    Metrics.increment('cache.worker.purge_success');
                    Metrics.timing('cache.worker.processing_time', Date.now() - startTime);

                } catch (err) {
                    logger.error("[Cache:Worker] Failed to process purge message", { error: err.message });
                    Metrics.increment('cache.worker.purge_failure');
                }
            },
        });
    } catch (error) {
        logger.error("[Kafka:Consumer] Fatal error starting consumer", { error: error.message });
        throw error; // Re-throw to be caught by the boot sequence
    }
};

/**
 * @desc Gracefully disconnects from the Kafka cluster
 */
const stopCacheConsumer = async () => {
    try {
        logger.info("[Kafka:Consumer] Disconnecting from brokers...");
        await consumer.disconnect();
        logger.info("[Kafka:Consumer] Disconnected successfully.");
    } catch (error) {
        logger.error("[Kafka:Consumer] Error during disconnection", { error: error.message });
    }
};

// EXPORT BOTH FUNCTIONS
module.exports = { 
    startCacheConsumer, 
    stopCacheConsumer 
};