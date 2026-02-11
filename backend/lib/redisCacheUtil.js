const { cacheConnection } = require('../lib/redisCacheClient');
const logger = require("../utils/logger");

const LOCK_TTL = 5; 
const NULL_MARKER = "__NULL__";

const redisCacheUtil = {
    // 💡 The raw connection for direct operations like deduplication NX locks
    client: cacheConnection,

    async cached(key, ttl, fetchFn, staleTtl = 60) {
        if (!this.client) return { value: await fetchFn(), stale: false };

        try {
            // 1. L2 Fresh Look
            const data = await this.client.get(key);
            if (data) {
                return { value: data === NULL_MARKER ? null : JSON.parse(data), stale: false };
            }

            // 2. Single-Flight Lock
            const lockKey = `lock:${key}`;
            const acquired = await this.client.set(lockKey, "1", "NX", "EX", LOCK_TTL);

            if (!acquired) {
                // Fallback to Stale while another node rebuilds
                const staleData = await this.client.get(`stale:${key}`);
                if (staleData) {
                    logger.debug(`[CACHE] Serving stale data: ${key}`);
                    return { value: JSON.parse(staleData), stale: true };
                }
                // Hard fallback
                return { value: await fetchFn(), stale: false };
            }

            // 3. Rebuild
            try {
                const result = await fetchFn();
                const serialized = result === null ? NULL_MARKER : JSON.stringify(result);

                await this.client.set(key, serialized, "EX", ttl);
                await this.client.set(`stale:${key}`, serialized, "EX", ttl + staleTtl);

                return { value: result, stale: false };
            } finally {
                await this.client.del(lockKey);
            }
        } catch (err) {
            logger.error(`[CACHE:CRITICAL] Engine failure for ${key}`, { error: err.message });
            return { value: await fetchFn(), stale: false };
        }
    },

    async get(key) {
        if (!this.client) return null;
        const val = await this.client.get(key);
        if (!val || val === NULL_MARKER) return null;
        try { return JSON.parse(val); } catch { return val; }
    },

    async set(key, value, ttl) {
        if (!this.client) return null;
        const val = value === null ? NULL_MARKER : JSON.stringify(value);
        // Set both fresh and stale for consistency
        await this.client.set(`stale:${key}`, val, "EX", ttl + 86400);
        return this.client.set(key, val, "EX", ttl);
    },

    async del(key) {
        if (!this.client) return null;
        return this.client.del(key);
    },

    async purgePattern(pattern) {
        if (!this.client) return 0;
        let cursor = '0';
        let deleted = 0;
        do {
            const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
            cursor = next;
            if (keys.length) {
                await this.client.del(...keys);
                deleted += keys.length;
            }
        } while (cursor !== '0');
        return deleted;
    }
};

// 💡 EXPORT MAPPING (Maintains OMNIA-NEXUS & ZENITH compatibility)
module.exports = {
    // Methods for ProductDataService
    cached: redisCacheUtil.cached.bind(redisCacheUtil),
    cachedWithStale: redisCacheUtil.cached.bind(redisCacheUtil),
    get: redisCacheUtil.get.bind(redisCacheUtil),
    set: redisCacheUtil.set.bind(redisCacheUtil),
    del: redisCacheUtil.del.bind(redisCacheUtil),
    purgePattern: redisCacheUtil.purgePattern.bind(redisCacheUtil),
    
    // Direct Access for NotificationService (Deduplication / Velocity)
    client: cacheConnection 
};