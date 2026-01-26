// utils/highSpeedCacheClient.js (HighSpeedCacheClient: SWR, PEE, Distributed Locking, TRACED)

// --- External Dependencies ---
const RedisClient = require('./redisClient'); // Assumed Redis Client wrapper
const Logger = require('./logger'); // Upgraded Logger
const Metrics = require('./metricsClient'); 
const NodeCache = require('node-cache'); 
const DistributedLock = require('./distributedLockClient'); 
const Tracing = require('./tracingClient'); // CRITICAL: Import TracingClient
const { InternalServerError } = require('../errors/custom-errors'); 

// --- Configuration ---
const IN_MEMORY_TTL = 10; 
const SWR_GRACE_PERIOD = 60; 
const LOCK_TIMEOUT_MS = 10000;

// Local Tier 1 Cache
const localCache = new NodeCache({ 
    stdTTL: IN_MEMORY_TTL, 
    maxKeys: 5000,
    checkperiod: 120 
});

const CacheClient = {
    VERSION: '1.2.1', // Bumped version for tracing implementation

    _applyPEE(ttl) {
        // Reduced expiration time by up to 10% randomly
        const randomReduction = Math.floor(Math.random() * (ttl * 0.1)); 
        return ttl - randomReduction;
    },

    /**
     * @desc Retrieves an item with Stale-While-Revalidate support.
     */
    async getOrRevalidate(key, revalidationFunction, baseTtlSeconds) {
        // 🚀 UPGRADE: Wrap the entire complex retrieval process in a high-level span.
        return Tracing.withSpan(`CacheClient.getOrRevalidate:${key}`, async (span) => {
            span.setAttribute('cache.key', key);
            
            const localValue = localCache.get(key);
            
            if (localValue) {
                Metrics.increment('cache.hit.local');
                span.setAttribute('cache.hit.level', 'L1_LOCAL');
                return localValue;
            }

            // 💡 TRACING: Start span for L2 (Redis) read attempt
            const rawRedisData = await Tracing.withSpan('CacheClient.getL2', async () => RedisClient.get(key));

            if (rawRedisData) {
                const data = JSON.parse(rawRedisData);
                const isStale = Date.now() > data.expiryTime; 
                
                localCache.set(key, data.value, IN_MEMORY_TTL);
                Metrics.increment(isStale ? 'cache.hit.stale' : 'cache.hit.redis');
                span.setAttribute('cache.hit.level', isStale ? 'L2_STALE' : 'L2_HIT');
                
                if (isStale) {
                    // Start revalidation asynchronously (fire-and-forget)
                    this._revalidateKey(key, revalidationFunction, baseTtlSeconds).catch(err => {
                         // The revalidation failure is logged inside _revalidateKey, 
                         // but we log the async failure path here too if necessary.
                         Logger.error('CACHE_ASYNC_REVALIDATION_FAIL_ROOT', { key, error: err.message });
                    });
                }
                
                return data.value;
            }
            
            // Full Miss: Fetch and set synchronously (blocking)
            Metrics.increment('cache.miss.full');
            span.setAttribute('cache.hit.level', 'MISS_BLOCKING');
            return this._fetchAndSet(key, revalidationFunction, baseTtlSeconds, true);
        });
    },

    async _revalidateKey(key, revalidationFunction, baseTtlSeconds) {
        // 🚀 UPGRADE: Wrap revalidation to track its duration and potential stampede skips.
        return Tracing.withSpan(`CacheClient.revalidate:${key}`, async (span) => {
            const lockKey = `lock:${key}`;
            
            const lock = await Tracing.withSpan('CacheClient.acquireLock', async () => DistributedLock.acquire(lockKey, LOCK_TIMEOUT_MS));

            if (lock) {
                try {
                    Metrics.increment('cache.revalidate.started');
                    span.setAttribute('cache.revalidate.acquired_lock', true);
                    
                    await CacheClient._fetchAndSet(key, revalidationFunction, baseTtlSeconds, false);
                    span.setStatus({ code: Tracing.SpanStatusCode.OK });

                } catch (err) {
                    Logger.error('CACHE_REVALIDATE_FAIL', { key, error: err.message });
                    span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: err.message });
                    span.recordException(err);
                } finally {
                    await Tracing.withSpan('CacheClient.releaseLock', async () => DistributedLock.release(lock));
                }
            } else {
                Metrics.increment('cache.revalidate.skipped');
                span.setAttribute('cache.revalidate.acquired_lock', false);
                span.setAttribute('cache.revalidate.status', 'skipped_stamped');
            }
        });
    },

    async _fetchAndSet(key, revalidationFunction, baseTtlSeconds, isBlocking) {
        // 🚀 UPGRADE: Wrap the actual data fetching and setting process.
        return Tracing.withSpan('CacheClient.fetchAndSet', async (span) => {
            if (isBlocking) Metrics.increment('cache.miss.blocking_fetch');
            span.setAttribute('cache.set.is_blocking', isBlocking);
            
            // 💡 TRACING: Trace the call to the original data source
            const freshValue = await Tracing.withSpan('DataSource.fetch', revalidationFunction);
            
            const adjustedTtl = CacheClient._applyPEE(baseTtlSeconds);
            const expiryTime = Date.now() + (adjustedTtl * 1000);
            const redisPayload = JSON.stringify({ value: freshValue, expiryTime });

            // 💡 TRACING: Trace the write-through operation
            await Tracing.withSpan('CacheClient.setL2', async () => {
                await RedisClient.set(key, redisPayload, 'EX', adjustedTtl + SWR_GRACE_PERIOD);
            });
            
            // Write to local cache with fast TTL
            localCache.set(key, freshValue, IN_MEMORY_TTL);
            
            Metrics.increment('cache.set.fresh');
            span.setAttribute('cache.set.ttl', adjustedTtl);
            return freshValue;
        });
    },
    
    // Public set method (used by JobClient for deduping)
    async set(key, value, ttlSeconds) {
        // 🚀 UPGRADE: Wrap the simple set operation for tracing cache writes
        return Tracing.withSpan(`CacheClient.set:${key}`, async () => {
            const adjustedTtl = CacheClient._applyPEE(ttlSeconds);
            const expiryTime = Date.now() + (adjustedTtl * 1000);
            const redisPayload = JSON.stringify({ value: value, expiryTime });
            
            localCache.set(key, value, IN_MEMORY_TTL);
            await RedisClient.set(key, redisPayload, 'EX', adjustedTtl + SWR_GRACE_PERIOD);
            
            Metrics.increment('cache.set.public');
        });
    },
    
    // Public get method (simple, non-revalidate access)
    async get(key) {
        // Wrap simple public get in a span for full flow tracking
        return Tracing.withSpan(`CacheClient.get:${key}`, async (span) => {
            span.setAttribute('cache.key', key);
            
            const localValue = localCache.get(key);
            if (localValue) {
                Metrics.increment('cache.hit.local');
                span.setAttribute('cache.hit.level', 'L1_LOCAL');
                return localValue;
            }

            const rawRedisData = await RedisClient.get(key);
            
            if (rawRedisData) {
                Metrics.increment('cache.hit.redis');
                span.setAttribute('cache.hit.level', 'L2_HIT');
                const data = JSON.parse(rawRedisData);
                localCache.set(key, data.value, IN_MEMORY_TTL);
                return data.value;
            }
            
            Metrics.increment('cache.miss.simple');
            span.setAttribute('cache.hit.level', 'MISS_SIMPLE');
            return null;
        });
    },

    initialize: async () => {
        await RedisClient.connect();
        await DistributedLock.connect();
        Logger.info('CACHING_CLIENT_INITIALIZED', { version: CacheClient.VERSION });
        global.CacheClient = CacheClient; 
    }
};

module.exports = CacheClient;