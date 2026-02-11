/**
 * ZENITH OMEGA - CACHE INVALIDATION WORKER
 * Listen to: Titan Nexus Kafka
 * Purpose: Ensure global cache consistency across the cluster
 */
const broker = require('../services/messageBrokerClient');
const cache = require('../lib/redisCacheUtil');
const Logger = require('../utils/logger');
const Metrics = require('../utils/metricsClient');

const TOPIC = 'cache-invalidation-topic';
const CONSUMER_GROUP = 'notif-cache-invalidator-group';

async function startCacheInvalidator() {
    try {
        await broker.subscribe(TOPIC, CONSUMER_GROUP, async (message) => {
            const { action, userId, timestamp } = message;

            Logger.info('CACHE_INVALIDATION_RECEIVED', { action, userId, timestamp });

            if (action === 'PURGE_USER') {
                const start = Date.now();
                
                // 💡 Use Option B's purgePattern to wipe all paginated notification fragments
                // This clears: notifs:u:123:c:start:l:10, notifs:u:123:c:next:l:10, etc.
                const pattern = `notifs:u:${userId}:*`;
                const deletedCount = await cache.purgePattern(pattern);

                Metrics.timing('cache.purge_latency', Date.now() - start);
                Metrics.increment('cache.purge_success', deletedCount);

                Logger.debug('USER_CACHE_PURGED', { userId, keysDeleted: deletedCount });
            }
        });

        Logger.info(`[WORKER] Cache Invalidator active on ${TOPIC}`);
    } catch (err) {
        Logger.error('[WORKER:CRITICAL] Cache Invalidator failed to start', { error: err.message });
        process.exit(1);
    }
}

module.exports = { startCacheInvalidator };