// utils/localToggleCache.js (HYPER-CONSISTENT DEDICATED STORE: Asynchronous Persistence & Degradation, TRACED)

// --- Core Dependencies ---
const NodeCache = require('node-cache');
const RedisClient = require('./redisConnection'); 
const Logger = require('./logger'); // <-- Uses ULTIMATE PINO LOGGER
const Metrics = require('./metricsClient');
const CircuitBreaker = require('./circuitBreaker');
const Tracing = require('./tracingClient'); // CRITICAL: Import TracingClient

// --- Configuration ---
const CACHE_BREAKER_CONFIG = { name: 'DistributedCacheBreaker', failureThreshold: 10, timeout: 500 };
const CACHE_BREAKER = new CircuitBreaker(CACHE_BREAKER_CONFIG);
const CRITICAL_CACHE_KEYS = ['GLOBAL_KILL_SWITCH', 'CRITICAL_POLICY_DEFAULTS']; 

// --- Cache Instances ---
const localMemoryCache = new NodeCache({ stdTTL: 300, checkperiod: 120 });
let isRedisReady = false; 

// =================================================================================
// 🛡️ INTERNAL RESILIENCE & CACHING LOGIC
// =================================================================================

/**
 * @desc Graceful degradation set operation: Tries Redis first, falls back to Memory.
 */
const set = async (key, value, ttlSeconds) => {
    // 🚀 UPGRADE: Wrap the entire set operation in a span.
    return Tracing.withSpan(`ToggleCache.set:${key}`, async (span) => {
        span.setAttribute('cache.key', key);
        span.setAttribute('cache.ttl', ttlSeconds);
        span.setAttribute('cache.tier', 'L1_L2');
        
        const serializedValue = JSON.stringify(value);
        localMemoryCache.set(key, serializedValue, ttlSeconds);
        Metrics.increment('cache.set.memory_success');
        
        if (isRedisReady) {
            try {
                // 💡 TRACING: Explicitly trace the execution inside the Circuit Breaker.
                await Tracing.withSpan('ToggleCache.setRedis', async () => {
                    await CACHE_BREAKER.execute(() => RedisClient.set(key, serializedValue, 'EX', ttlSeconds));
                });
                
                // Asynchronously persist critical keys if Redis is running and policy demands it
                if (CRITICAL_CACHE_KEYS.includes(key)) {
                    // Note: We don't trace the fire-and-forget persist call to avoid bloating the trace.
                    RedisClient.persistToDisk(key).catch(err => 
                        Logger.alert('CACHE_PERSISTENCE_FAIL', { key, err: err }) 
                    );
                }
                Metrics.increment('cache.set.redis_success');
                span.setAttribute('cache.set.redis_status', 'SUCCESS');
            } catch (error) {
                Metrics.increment('cache.set.redis_fail');
                // 💡 TRACING: Record the failure
                span.recordException(error);
                span.setAttribute('cache.set.redis_status', 'FAILED_FALLBACK');
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Redis Write Failed (Circuit Breaker/Network)' });
                
                Logger.warn('REDIS_WRITE_FALLBACK', { key, err: error }); 
                isRedisReady = false; // Trigger degradation
            }
        } else {
            Metrics.increment('cache.set.memory_only');
            span.setAttribute('cache.tier', 'L1_ONLY_DEGRADED');
        }
    }); // End Tracing.withSpan
};

/**
 * @desc Graceful degradation get operation: Tries Memory first, then Redis.
 */
const get = async (key) => {
    // 🚀 UPGRADE: Wrap the entire get operation in a span.
    return Tracing.withSpan(`ToggleCache.get:${key}`, async (span) => {
        span.setAttribute('cache.key', key);

        // 1. Synchronous Hit Check (Fastest Path)
        const localValue = localMemoryCache.get(key);
        if (localValue) {
            Metrics.increment('cache.get.local_hit');
            span.setAttribute('cache.hit.level', 'L1_LOCAL');
            return JSON.parse(localValue);
        }
        
        // 2. Asynchronous Distributed Check 
        if (isRedisReady) {
            try {
                // 💡 TRACING: Trace the execution inside the Circuit Breaker.
                const distributedValue = await Tracing.withSpan('ToggleCache.getRedis', async () => {
                    return CACHE_BREAKER.execute(() => RedisClient.get(key));
                });

                if (distributedValue) {
                    Metrics.increment('cache.get.distributed_hit');
                    span.setAttribute('cache.hit.level', 'L2_DISTRIBUTED');
                    localMemoryCache.set(key, distributedValue); 
                    return JSON.parse(distributedValue);
                }
            } catch (error) {
                Metrics.increment('cache.get.distributed_fail');
                // 💡 TRACING: Record the read failure
                span.recordException(error);
                span.setAttribute('cache.read.redis_status', 'FAILED_FALLBACK');
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Redis Read Failed (Circuit Breaker/Network)' });

                Logger.warn('REDIS_READ_FAIL', { key, err: error, circuitStatus: CACHE_BREAKER.status() }); 
                isRedisReady = false; // Trigger degradation
            }
        }
        
        Metrics.increment('cache.get.miss');
        span.setAttribute('cache.hit.level', 'MISS');
        return null;
    }); // End Tracing.withSpan
};

// =================================================================================
// 💡 MODULE LIFECYCLE MANAGEMENT
// =================================================================================

const initialize = async () => {
    // 🚀 UPGRADE: Wrap initialization in a span to trace startup time and success.
    return Tracing.withSpan('ToggleCache.initialize', async (span) => {
        try {
            await RedisClient.connect();
            isRedisReady = true;
            
            // 💡 TRACING: Trace the bulk data loading
            await Tracing.withSpan('ToggleCache.loadCriticalKeys', async () => {
                const criticalKeysData = await RedisClient.getMany(CRITICAL_CACHE_KEYS.map(k => k));
                criticalKeysData.forEach((data, index) => {
                    if (data) localMemoryCache.set(CRITICAL_CACHE_KEYS[index], data);
                });
                span.setAttribute('cache.keys.loaded', criticalKeysData.filter(d => d).length);
            });
            
            Logger.info('LOCAL_CACHE_INITIALIZED', { store: 'Redis+Memory' });
            span.setAttribute('cache.init.status', 'SUCCESS');
        } catch (e) {
            // 🛑 CRITICAL TRACING: Record startup failure
            span.recordException(e);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Redis Connection Failed' });
            
            Logger.critical('REDIS_INIT_FAILED', { err: e, action: 'Fallback to Memory Only' }); 
            isRedisReady = false;
        }
    }); // End Tracing.withSpan
};

const shutdown = async () => {
    // 🚀 UPGRADE: Wrap shutdown for graceful exit tracing
    return Tracing.withSpan('ToggleCache.shutdown', async () => {
        if (isRedisReady) await RedisClient.disconnect();
        localMemoryCache.close();
        Logger.info('LOCAL_CACHE_SHUTDOWN');
    });
};

module.exports = {
    initialize,
    shutdown,
    set,
    get,
    getSync: (key) => {
        const value = localMemoryCache.get(key);
        // Note: We avoid wrapping this sync method in a span to keep it hyper-fast
        return value ? JSON.parse(value) : null;
    },
    // Wrap setMany to trace the bulk operation
    setMany: async (flags) => {
        return Tracing.withSpan('ToggleCache.setMany', async (span) => {
            span.setAttribute('cache.keys.count', Object.keys(flags).length);
            const ops = Object.entries(flags).map(([key, value]) => set(key, value, 300));
            await Promise.all(ops);
        });
    },
    isConnected: () => isRedisReady
};