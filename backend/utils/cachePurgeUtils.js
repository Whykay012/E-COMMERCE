/**
 * utils/cachePurgeUtil.js
 * ZENITH OMEGA - High-Performance Cache Purge Utility
 */
const { getPrimaryClient } = require('./redisClient');
const Metrics = require('./metricsClient');

/**
 * Perform an atomic-safe pattern purge using SCAN
 * @param {string} userId - The user whose cache needs clearing
 */
const purgeUserCache = async (userId) => {
    const redis = getPrimaryClient();
    const pattern = `notifs:u:${userId}:*`;
    let cursor = '0';
    let deletedCount = 0;

    do {
        // SCAN 100 keys at a time to prevent blocking the Redis event loop
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        
        if (keys.length > 0) {
            await redis.del(...keys);
            deletedCount += keys.length;
        }
    } while (cursor !== '0');

    return deletedCount;
};

module.exports = { purgeUserCache };