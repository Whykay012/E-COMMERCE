/**
 * services/productDataService.js
 * ZENITH ENTERPRISE EDITION + CIRCUIT BREAKER
 */

const mongoose = require('mongoose');
const Product = require('../model/product');
const { getRedisSubscriber } = require('../event/lib/redisClient');
const AuditLogger = require('./auditLogger');
const CacheUtil = require('./redisCacheUtil');

// --- Configuration ---
const REDIS_PRODUCT_KEY_PREFIX = 'product:details:';
const REDIS_TTL_SECONDS = 3600;
const STALE_TTL_SECONDS = 86400;
const L1_CACHE_MAX_SIZE = 1000;
const CACHE_BUS_CHANNEL = 'product:cache:invalidation';
const DEAD_LETTER_QUEUE_ZSET = 'product:dlq:retry_schedule';

// --- Circuit Breaker State ---
const CB_CONFIG = {
    FAILURE_THRESHOLD: 5,     // Trip after 5 consecutive failures
    RECOVERY_TIMEOUT_MS: 30000, // Stay "Open" for 30 seconds
    state: 'CLOSED',          // CLOSED, OPEN, HALF_OPEN
    failureCount: 0,
    nextAttempt: 0
};

const L1_CACHE = new Map();

/**
 * CORE: getProductDetailsByIds
 */
async function getProductDetailsByIds(productIds = []) {
    if (!productIds || productIds.length === 0) return [];

    const results = new Array(productIds.length).fill(null);
    const missingAfterL1 = [];

    productIds.forEach((id, idx) => {
        if (L1_CACHE.has(id)) {
            results[idx] = L1_CACHE.get(id);
            manageL1Cache(id);
        } else {
            missingAfterL1.push({ id, idx });
        }
    });

    if (missingAfterL1.length === 0) return results;

    await Promise.all(missingAfterL1.map(async (item) => {
        const cacheKey = `${REDIS_PRODUCT_KEY_PREFIX}${item.id}`;

        try {
            const { value, stale } = await CacheUtil.cached(
                cacheKey,
                REDIS_TTL_SECONDS,
                async () => {
                    // Check Circuit Breaker before calling DB
                    if (CB_CONFIG.state === 'OPEN') {
                        if (Date.now() > CB_CONFIG.nextAttempt) {
                            CB_CONFIG.state = 'HALF_OPEN';
                        } else {
                            throw new Error('CIRCUIT_BREAKER_OPEN');
                        }
                    }
                    return await fetchAndNormalizeFromDB(item.id);
                },
                STALE_TTL_SECONDS
            );

            if (value) {
                results[item.idx] = value;
                L1_CACHE.set(item.id, value);
                manageL1Cache(item.id);
            }
        } catch (e) {
            handleCBFailure(e);
            AuditLogger.log({ level: AuditLogger.LEVELS.ERROR, event: 'FETCH_FAIL', details: { id: item.id, error: e.message } });
            await pushToDeadLetter(item.id, `engine-error:${e.message}`);
        }
    }));

    return results;
}

/**
 * DB Fetcher with Circuit Breaker tracking
 */
async function fetchAndNormalizeFromDB(productId) {
    try {
        const doc = await Product.findById(productId)
            .select('name price images slug isAvailable updatedAt category')
            .lean();

        // Success: Reset Circuit Breaker
        if (CB_CONFIG.state === 'HALF_OPEN' || CB_CONFIG.failureCount > 0) {
            AuditLogger.log({ level: AuditLogger.LEVELS.INFO, event: 'CIRCUIT_BREAKER_RESET' });
            CB_CONFIG.state = 'CLOSED';
            CB_CONFIG.failureCount = 0;
        }

        if (!doc) {
            await CacheUtil.client.publish(CACHE_BUS_CHANNEL, productId);
            return null;
        }

        const normalized = {
            _id: doc._id.toString(),
            name: doc.name,
            price: doc.price,
            slug: doc.slug,
            isAvailable: doc.isAvailable,
            images: doc.images ? doc.images.slice(0, 1) : [],
            category: doc.category,
            updatedAt: doc.updatedAt,
        };

        await CacheUtil.client.publish(CACHE_BUS_CHANNEL, productId);
        return normalized;
    } catch (dbError) {
        throw dbError; // Caught by CacheUtil and passed to handleCBFailure
    }
}

/**
 * Circuit Breaker Logic
 */
function handleCBFailure(error) {
    if (error.message === 'CIRCUIT_BREAKER_OPEN') return;

    CB_CONFIG.failureCount++;
    if (CB_CONFIG.failureCount >= CB_CONFIG.FAILURE_THRESHOLD) {
        CB_CONFIG.state = 'OPEN';
        CB_CONFIG.nextAttempt = Date.now() + CB_CONFIG.RECOVERY_TIMEOUT_MS;
        AuditLogger.log({ level: AuditLogger.LEVELS.CRITICAL, event: 'CIRCUIT_BREAKER_TRIPPED' });
    }
}

// --- LRU, DLQ, and Subscriber remain the same as previous Zenith Version ---
const manageL1Cache = (key) => {
    if (L1_CACHE.has(key)) {
        const v = L1_CACHE.get(key);
        L1_CACHE.delete(key);
        L1_CACHE.set(key, v);
    }
    if (L1_CACHE.size > L1_CACHE_MAX_SIZE) {
        const oldest = L1_CACHE.keys().next().value;
        L1_CACHE.delete(oldest);
    }
};

async function pushToDeadLetter(productId, reason, currentAttempts = 0) {
    if (currentAttempts >= 5) return;
    const nextAttemptAt = Date.now() + (Math.pow(2, currentAttempts) * 5000);
    const payload = { productId, reason, attempts: currentAttempts + 1, nextAttemptAt };
    await CacheUtil.client.zadd(DEAD_LETTER_QUEUE_ZSET, nextAttemptAt.toString(), JSON.stringify(payload));
}

async function rebuildProductCacheAndNotify(productId) {
    const data = await fetchAndNormalizeFromDB(productId);
    if (data) {
        const cacheKey = `${REDIS_PRODUCT_KEY_PREFIX}${productId}`;
        await CacheUtil.set(cacheKey, data, REDIS_TTL_SECONDS);
    }
}

function initializeCacheSubscriber() {
    const subscriber = getRedisSubscriber();
    subscriber.subscribe(CACHE_BUS_CHANNEL);
    subscriber.on('message', (channel, productId) => {
        if (channel === CACHE_BUS_CHANNEL && L1_CACHE.has(productId)) {
            L1_CACHE.delete(productId);
        }
    });
}

function startDeadLetterWorker() {
    setInterval(async () => {
        const rawItems = await CacheUtil.client.zrangebyscore(DEAD_LETTER_QUEUE_ZSET, '-inf', Date.now(), 'LIMIT', 0, 20);
        if (rawItems.length === 0) return;
        await CacheUtil.client.zrem(DEAD_LETTER_QUEUE_ZSET, ...rawItems);
        await Promise.allSettled(rawItems.map(async (raw) => {
            const item = JSON.parse(raw);
            try { await rebuildProductCacheAndNotify(item.productId); }
            catch (e) { await pushToDeadLetter(item.productId, e.message, item.attempts); }
        }));
    }, 10000);
}

module.exports = {
    getProductDetailsByIds,
    initializeCacheSubscriber,
    startDeadLetterWorker,
    pushToDeadLetter,
    rebuildProductCacheAndNotify
};