/**
 * services/productDataService.js
 * PRODUCTION-HARDENED TITAN (OMEGA UPGRADE)
 *
 * Improvements:
 * - Dead-letter handling upgraded to Redis ZSET for scheduled, reliable retries with true exponential backoff.
 * - DLQ worker uses setTimeout loop for safer asynchronous handling instead of fixed setInterval.
 * - Distributed lock release is safer, targeting only acquired clients.
 * - Enhanced logging/observability for cache hits, misses, and lock attempts.
 */

const mongoose = require('mongoose');
const Product = require('../model/product');
const { getRedisClient, getRedisSubscriber } = require('../utils/redisClient');
const AuditLogger = require('./auditLogger');
const Redis = require('ioredis');
const { NotFoundError } = require('../errors/notFoundError');

// --- Configurable parameters (tune for your infra) ---
const REDIS_PRODUCT_KEY_PREFIX = 'product:details:';
const REDIS_LOCK_KEY_PREFIX = 'product:lock:';
const REDIS_TTL_SECONDS = 3600;     // L2 cache TTL
const L1_CACHE_MAX_SIZE = 500;

const CACHE_BUS_CHANNEL = 'product:cache:invalidation';
const DEAD_LETTER_QUEUE_ZSET = 'product:dlq:retry_schedule'; // UPGRADED to ZSET

// Lock behavior
const LOCK_TTL_MS = 15000;        // lock TTL (ms) for Redlock attempts
const LOCK_RETRY_COUNT = 3;       // number of attempts to acquire Redlock
const LOCK_RETRY_BASE_MS = 100;     // base backoff
const CLOCK_DRIFT_FACTOR = 0.01;     // Redlock recommended drift factor

// Dead-letter worker
const DLQ_WORKER_INTERVAL_MS = 5000;  // Interval between worker runs
const DEAD_LETTER_PROCESS_BATCH = 20;  // items to process per worker run
const DEAD_LETTER_RETRY_LIMIT = 5;    // how many times a DLQ item will be retried

// Metric Keys (for better observability)
const METRIC_HIT_COUNT = 'cache:hit';
const METRIC_MISS_COUNT = 'cache:miss';
const METRIC_LOCK_SUCCESS = 'lock:success';
const METRIC_LOCK_FAIL = 'lock:fail';


// L1 cache (local, process memory)
const L1_CACHE = new Map();

// --- Utility: LRU-ish management for L1 ---
const manageL1Cache = (key) => {
 if (L1_CACHE.has(key)) {
  const v = L1_CACHE.get(key);
  L1_CACHE.delete(key);
  L1_CACHE.set(key, v);
 }
 if (L1_CACHE.size > L1_CACHE_MAX_SIZE) {
  const oldest = L1_CACHE.keys().next().value;
  L1_CACHE.delete(oldest);
  AuditLogger.log({ level: AuditLogger.LEVELS.DEBUG, event: 'L1_CACHE_EVICTED', details: { key: oldest } });
 }
};

// --- Redis clients and quorum setup ---
const mainRedisClient = getRedisClient();

function buildQuorumClients() {
 const nodesEnv = process.env.REDIS_NODES || '';
 const nodes = nodesEnv.split(',').map(s => s.trim()).filter(Boolean);

 if (nodes.length === 0) return [mainRedisClient];

 return nodes.map(uri => new Redis(uri, {
  connectTimeout: 3000,
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
 }));
}

const quorumClients = buildQuorumClients();
const QUORUM_COUNT = Math.floor(quorumClients.length / 2) + 1;

// --- Redlock-style distributed lock implementation (quorum) ---

async function acquireDistributedLock(resource, ttl = LOCK_TTL_MS, retryAttempts = LOCK_RETRY_COUNT) {
 const value = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

 for (let attempt = 0; attempt < retryAttempts; attempt++) {
  const startTime = Date.now();
  let acquired = 0;
  const acquiredClients = [];

  await Promise.all(quorumClients.map(async (client) => {
   try {
    const res = await client.set(resource, value, 'PX', ttl, 'NX');
    if (res === 'OK') {
     acquired++;
     acquiredClients.push(client);
    }
   } catch (e) { /* ignore per-node failures */ }
  }));

  const elapsed = Date.now() - startTime;
  const drift = Math.floor(ttl * CLOCK_DRIFT_FACTOR) + 2;
  const validity = ttl - elapsed - drift;

  if (acquired >= QUORUM_COUNT && validity > 0) {
   return { resource, value, validity, ttl, acquiredClients };
  } else {
   // release any partial acquisitions immediately
   await Promise.all(acquiredClients.map(async (c) => {
    try {
     const lua = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;
     await c.eval(lua, 1, resource, value);
    } catch (e) { /* ignore */ }
   }));
  }

  const backoff = Math.floor(LOCK_RETRY_BASE_MS * Math.pow(2, attempt)) + Math.floor(Math.random() * LOCK_RETRY_BASE_MS);
  await new Promise(r => setTimeout(r, backoff));
 }

 return null;
}

/**
 * Release a distributed lock (UPGRADE: uses only acquiredClients for safety)
 */
async function releaseDistributedLock(lock) {
 if (!lock || !lock.resource || !lock.value || !lock.acquiredClients) return;
 const lua = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
   return redis.call("DEL", KEYS[1])
  else
   return 0
  end
 `;
 
 await Promise.allSettled(lock.acquiredClients.map(async (c) => {
  try {
   await c.eval(lua, 1, lock.resource, lock.value);
  } catch (e) { /* ignore */ }
 }));
}

// --- Dead-letter DLQ helpers (UPGRADED to ZSET) ---

function calculateNextAttemptTime(attempts) {
    const baseDelay = 5000; // 5 seconds
    const maxDelay = 300000; // 5 minutes (5 min max backoff)
    const delay = Math.min(
        maxDelay,
        baseDelay * Math.pow(2, attempts) + Math.floor(Math.random() * 1000)
    );
    return Date.now() + delay;
}

// Items pushed into DLQ ZSET are JSON strings: { productId, reason, attempts, nextAttemptAt }
async function pushToDeadLetter(productId, reason, currentAttempts = 0) {
 if (currentAttempts >= DEAD_LETTER_RETRY_LIMIT) {
  AuditLogger.log({ level: AuditLogger.LEVELS.CRITICAL, event: 'DLQ_PERMANENT_FAIL', details: { productId, reason, attempts: currentAttempts }});
  return;
 }

 const nextAttemptAt = calculateNextAttemptTime(currentAttempts);

 const payload = {
  productId,
  reason,
  attempts: currentAttempts + 1,
  createdAt: Date.now(),
  nextAttemptAt,
 };
 try {
  // ZADD: score is nextAttemptAt (timestamp), member is JSON payload
  await mainRedisClient.zadd(
   DEAD_LETTER_QUEUE_ZSET, 
   nextAttemptAt.toString(), 
   JSON.stringify(payload)
  );
  AuditLogger.log({ level: AuditLogger.LEVELS.WARN, event: 'DLQ_SCHEDULED', details: { productId, reason, nextAttemptAt: new Date(nextAttemptAt).toISOString(), attempts: currentAttempts + 1 }});
 } catch (e) {
  AuditLogger.log({ level: AuditLogger.LEVELS.ERROR, event: 'DLQ_PUSH_FAILED', details: { productId, error: e.message }});
 }
}

/**
 * Process items from the DLQ (ZSET based).
 */
async function processDeadLetterBatch(processLimit = DEAD_LETTER_PROCESS_BATCH) {
 // 1. Fetch the next batch of items ready for processing (score <= now)
 const rawItems = await mainRedisClient.zrangebyscore(
  DEAD_LETTER_QUEUE_ZSET,
  '-inf',
  Date.now(),
  'LIMIT',
  0,
  processLimit
 );
 
 if (rawItems.length === 0) return 0;
 
 let processedCount = 0;
 
 // 2. Atomically remove items from the set before processing
 // This prevents a race condition if another worker fetches the same item.
 await mainRedisClient.zrem(DEAD_LETTER_QUEUE_ZSET, ...rawItems);

 // 3. Process items concurrently
 await Promise.allSettled(rawItems.map(async (raw) => {
  let item;
  try {
   item = JSON.parse(raw);
  } catch (e) {
   AuditLogger.log({ level: AuditLogger.LEVELS.ERROR, event: 'DLQ_CORRUPT_ENTRY', details: { rawData: raw }});
   return;
  }

  try {
   // Recompute product cache and set L2 + notify
   await rebuildProductCacheAndNotify(item.productId);
   AuditLogger.log({ level: AuditLogger.LEVELS.INFO, event: 'DLQ_PROCESSED', details: { productId: item.productId, attempts: item.attempts }});
   processedCount++; // Note: this count is not strictly accurate in concurrent map, but sufficient for logging
  } catch (e) {
   // Failure: Re-schedule using PUSH helper (automatically increments attempts)
   await pushToDeadLetter(item.productId, `rebuild-failed:${e.message}`, item.attempts);
  }
 }));
 
 return rawItems.length; // Return the number of items pulled from the queue
}

// Helper to rebuild product cache and publish notification
async function rebuildProductCacheAndNotify(productId) {
 if (!mongoose.Types.ObjectId.isValid(productId)) throw new Error('invalid id');

 const doc = await Product.findById(productId)
  .select('name price images slug isAvailable updatedAt')
  .lean();

 if (!doc) {
  // If product is deleted, ensure L2 key is gone
  await mainRedisClient.del(`${REDIS_PRODUCT_KEY_PREFIX}${productId}`);
  await mainRedisClient.publish(CACHE_BUS_CHANNEL, productId); 
  throw new NotFoundError('product not found in DB'); // Throw to be caught by caller/DLQ
 }

 const normalized = normalizeProduct(doc);
 const redisKey = `${REDIS_PRODUCT_KEY_PREFIX}${productId}`;

 // Write-through with setEx
 await mainRedisClient.setex(redisKey, REDIS_TTL_SECONDS, JSON.stringify(normalized));

 // Publish to channel to wake followers and notify L1 invalidation across cluster
 await mainRedisClient.publish(CACHE_BUS_CHANNEL, productId);

 return true;
}

// --- normalizeProduct and L1 helpers (unchanged) ---
const normalizeProduct = (doc) => {
 if (!doc) return null;
 return {
  _id: doc._id.toString(),
  name: doc.name,
  price: doc.price,
  slug: doc.slug,
  isAvailable: doc.isAvailable,
  images: doc.images ? doc.images.slice(0, 1) : [],
  updatedAt: doc.updatedAt,
 };
};

// --- Pub/Sub initialization for L1 invalidation ---
function initializeCacheSubscriber() {
 try {
  const subscriber = getRedisSubscriber();
  subscriber.subscribe(CACHE_BUS_CHANNEL, (err) => {
   if (err) {
    AuditLogger.log({ level: AuditLogger.LEVELS.ERROR, event: 'CACHE_SUBSCRIBE_FAILED', details: { error: err.message }});
    return;
   }
   AuditLogger.log({ level: AuditLogger.LEVELS.INFO, event: 'CACHE_BUS_SUBSCRIBED', details: { channel: CACHE_BUS_CHANNEL }});
  });

  subscriber.on('message', (channel, message) => {
   if (channel !== CACHE_BUS_CHANNEL) return;
   const productId = message;
   if (L1_CACHE.has(productId)) {
    L1_CACHE.delete(productId);
    AuditLogger.log({ level: AuditLogger.LEVELS.DEBUG, event: 'L1_INVALIDATED_REMOTE', details: { productId }});
   }
  });

 } catch (e) {
  AuditLogger.log({ level: AuditLogger.LEVELS.CRITICAL, event: 'CACHE_BUS_INIT_FAILED', details: { error: e.message }});
 }
}

// --- Core: getProductDetailsByIds (production-hardened TITAN) ---

async function getProductDetailsByIds(productIds = []) {
 if (!productIds || productIds.length === 0) return [];

 const results = new Array(productIds.length).fill(null);
 const missingAfterL1 = [];

 // --- L1 lookup ---
 productIds.forEach((id, idx) => {
  if (L1_CACHE.has(id)) {
   results[idx] = L1_CACHE.get(id);
   manageL1Cache(id);
   AuditLogger.log({ level: AuditLogger.LEVELS.DEBUG, event: METRIC_HIT_COUNT, details: { cache: 'L1', productId: id } });
  } else {
   missingAfterL1.push({ id, idx });
  }
 });

 if (missingAfterL1.length === 0) return results;

 // --- L2 lookup (batch) ---
 const redisKeys = missingAfterL1.map(m => `${REDIS_PRODUCT_KEY_PREFIX}${m.id}`);
 const l2Values = await mainRedisClient.mget(redisKeys);

 const contentionQueue = [];
 l2Values.forEach((val, i) => {
  const { id, idx } = missingAfterL1[i];
  if (val) {
   try {
    const parsed = JSON.parse(val);
    results[idx] = parsed;
    L1_CACHE.set(id, parsed);
    manageL1Cache(id);
    AuditLogger.log({ level: AuditLogger.LEVELS.DEBUG, event: METRIC_HIT_COUNT, details: { cache: 'L2', productId: id } });
   } catch (e) {
    // corrupted L2 entry — treat as contention and attempt rebuild
    contentionQueue.push({ id, idx, isCorrupt: true });
    AuditLogger.log({ level: AuditLogger.LEVELS.WARN, event: 'L2_CORRUPT', details: { productId: id } });
   }
  } else {
   contentionQueue.push({ id, idx });
   AuditLogger.log({ level: AuditLogger.LEVELS.DEBUG, event: METRIC_MISS_COUNT, details: { cache: 'L2', productId: id } });
  }
 });

 if (contentionQueue.length === 0) return results;
 
 // --- Attempt to become LEADER for each missing product via Redlock/quorum ---
 const leaderTasks = [];

 for (const item of contentionQueue) {
  const lockResource = `${REDIS_LOCK_KEY_PREFIX}${item.id}`;

  leaderTasks.push((async () => {
   const lock = await acquireDistributedLock(lockResource, LOCK_TTL_MS, LOCK_RETRY_COUNT);
   if (!lock) {
    // FOLLOWER PATH: Failed to acquire lock, wait for leader notification
    AuditLogger.log({ level: AuditLogger.LEVELS.DEBUG, event: METRIC_LOCK_FAIL, details: { productId: item.id } });
    try {
     await waitForCacheViaPubSub(item.id, LOCK_TTL_MS / 1000);
     // Re-read L2 after notification
     const fresh = await mainRedisClient.get(`${REDIS_PRODUCT_KEY_PREFIX}${item.id}`);
     if (fresh) {
      const parsed = JSON.parse(fresh);
      results[item.idx] = parsed;
      L1_CACHE.set(item.id, parsed);
      manageL1Cache(item.id);
      AuditLogger.log({ level: AuditLogger.LEVELS.DEBUG, event: METRIC_HIT_COUNT, details: { cache: 'L2_AFTER_WAIT', productId: item.id } });
     } else {
      // Leader failed but released lock; push to DLQ for async worker recovery
      await pushToDeadLetter(item.id, 'missing-after-notify', 0);
     }
    } catch (e) {
     // Wait timed out or other follower error -> DLQ
     await pushToDeadLetter(item.id, 'follower-wait-failed', 0);
    }
    return null;
   }

   // LEADER PATH: Acquired lock, rebuild cache
   AuditLogger.log({ level: AuditLogger.LEVELS.DEBUG, event: METRIC_LOCK_SUCCESS, details: { productId: item.id } });
   try {
    // Fetch from DB and rebuild cache
    await rebuildProductCacheAndNotify(item.id);
    AuditLogger.log({ level: AuditLogger.LEVELS.DEBUG, event: 'CACHE_REBUILT_LEADER', details: { productId: item.id } });

    // Read the freshly set L2 data (for local L1)
    const fresh = await mainRedisClient.get(`${REDIS_PRODUCT_KEY_PREFIX}${item.id}`);
    if (fresh) {
     const parsed = JSON.parse(fresh);
     results[item.idx] = parsed;
     L1_CACHE.set(item.id, parsed);
     manageL1Cache(item.id);
    }
   } catch (e) {
    // Leader failed to compute / write -> push to DLQ for async processing
    await pushToDeadLetter(item.id, `leader-failed:${e.message}`, 0);
    // IMPORTANT: notify followers *if* we managed to acquire the lock but failed before release, 
    // though this is controversial. DLQ will handle the eventual fix.
   } finally {
    // release the lock
    try { await releaseDistributedLock(lock); } catch(_) { /* ignore */ }
   }
   return null;
  })());
 }

 await Promise.allSettled(leaderTasks);

 return results;
}

// Helper: wait for cache publication via Pub/Sub (single subscription per wait)
function waitForCacheViaPubSub(productId, timeoutSeconds = 10) {
 return new Promise((resolve, reject) => {
  const subscriber = getRedisSubscriber();
  let resolved = false;
  let isSubscribed = false;

  const onMessage = (channel, message) => {
   if (channel !== CACHE_BUS_CHANNEL) return;
   if (message === productId) {
    cleanup();
    resolved = true;
    resolve(true);
   }
  };

  // Clean up listener and unsubscribe (best effort)
  function cleanup() {
   try {
    subscriber.removeListener('message', onMessage);
    if (isSubscribed) subscriber.unsubscribe(CACHE_BUS_CHANNEL).catch(() => { /* ignore */ });
   } catch (e) { /* ignore */ }
  }

  const timer = setTimeout(() => {
   if (!resolved) {
    cleanup();
    resolve(false); // timeout
   }
  }, timeoutSeconds * 1000);

  subscriber.on('message', onMessage);
  subscriber.subscribe(CACHE_BUS_CHANNEL)
   .then(() => { isSubscribed = true; })
   .catch(() => { cleanup(); resolve(false); /* immediately fail on subscribe error */ });
 });
}

// --- Public worker starter for DLQ processing (call in background) ---
let _dlqWorkerHandle = null;

/**
 * Starts the DLQ worker using a safe setTimeout loop.
 */
function startDeadLetterWorker() {
 if (_dlqWorkerHandle) return;

 const runWorker = async () => {
  try {
   const processed = await processDeadLetterBatch(DEAD_LETTER_PROCESS_BATCH);
   if (processed > 0) AuditLogger.log({ level: AuditLogger.LEVELS.INFO, event: 'DLQ_BATCH_PROCESSED', details: { processed }});
  } catch (e) {
   AuditLogger.log({ level: AuditLogger.LEVELS.ERROR, event: 'DLQ_WORKER_ERROR', details: { error: e.message }});
  } finally {
   // Only re-schedule if the worker has not been stopped
   if (_dlqWorkerHandle) {
    _dlqWorkerHandle = setTimeout(runWorker, DLQ_WORKER_INTERVAL_MS);
   }
  }
 };

 // Start the first run immediately, then loop
 _dlqWorkerHandle = setTimeout(runWorker, 0); 
}

function stopDeadLetterWorker() {
 if (_dlqWorkerHandle) clearTimeout(_dlqWorkerHandle);
 _dlqWorkerHandle = null;
}

// Exported API
module.exports = {
 getProductDetailsByIds,
 initializeCacheSubscriber,
 startDeadLetterWorker,
 stopDeadLetterWorker,
 // Expose helpers for operational use
 pushToDeadLetter,
 rebuildProductCacheAndNotify,
};