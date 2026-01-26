// utils/preventReplay.js
// Enterprise-grade replay protection with:
// - Redis Lua atomic check+set
// - Signature binding
// - Dead-letter queue (BullMQ)
// - Immutable ledger (Mongo)
// - Prometheus metrics
// - Memory fallback and cross-region notes

"use strict";

const crypto = require("crypto");
const { Queue } = require("bullmq");
const { getRedisClient } = require("../lib/redisClient");
const ImmutableWebhookRecord = require("../model/ImmutableWebhookRecord");
const promClient = require("prom-client");

// ---------------------------
// CONFIG
// ---------------------------
const DEFAULT_TTL_SECONDS = Number(process.env.WEBHOOK_REPLAY_TTL || 24 * 3600);
const MEMORY_FALLBACK_LIMIT = Number(process.env.MEMORY_FALLBACK_LIMIT || 10000);
const REDIS_KEY_PREFIX = process.env.WEBHOOK_REPLAY_PREFIX || "webhook:replay";
const DLQ_QUEUE_NAME = process.env.WEBHOOK_DLQ_QUEUE || "webhook-dlq";
const DLQ_RETRY_DELAY_MS = Number(process.env.WEBHOOK_DLQ_RETRY_DELAY_MS || 60 * 1000);

// ---------------------------
// Prometheus metrics
// ---------------------------
const registry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: registry });

const metric_new_webhooks = new promClient.Counter({
  name: "webhook_replay_new_total",
  help: "New (first-seen) webhook fingerprints",
});
const metric_replayed_webhooks = new promClient.Counter({
  name: "webhook_replay_detected_total",
  help: "Detected replayed webhook attempts",
});
const metric_dlq_enqueued = new promClient.Counter({
  name: "webhook_replay_dlq_enqueued_total",
  help: "Webhook events enqueued to DLQ due to replay or failure",
});
const metric_redis_fallbacks = new promClient.Counter({
  name: "webhook_replay_redis_fallback_total",
  help: "Count of times Redis was unavailable and memory fallback used",
});

[
  metric_new_webhooks,
  metric_replayed_webhooks,
  metric_dlq_enqueued,
  metric_redis_fallbacks,
].forEach(m => registry.registerMetric(m));

// expose registry accessor
function getPromRegistry() { return registry; }

// ---------------------------
// LUA script — atomic EXISTS + SET EX
// returns 1 when key exists (replay), 0 when inserted
// ---------------------------
const LUA_CHECK_AND_SET = `
if redis.call("EXISTS", KEYS[1]) == 1 then
  return 1
else
  redis.call("SET", KEYS[1], "1", "EX", ARGV[1])
  return 0
end
`;

// ---------------------------
// in-memory fallback
// ---------------------------
const memoryStore = new Map();

function memoryReplayCheck(key, ttlSeconds) {
  if (memoryStore.has(key)) return true;
  memoryStore.set(key, Date.now());

  if (memoryStore.size > MEMORY_FALLBACK_LIMIT) {
    const first = memoryStore.keys().next().value;
    memoryStore.delete(first);
  }

  setTimeout(() => memoryStore.delete(key), ttlSeconds * 1000).unref();
  return false;
}

// ---------------------------
// fingerprint builder
// includes rawBody (or its hash), provider, providerId, and optional signature binding
// ---------------------------
function buildFingerprint(rawBody, provider = "unknown", providerId = "", signature = "") {
  // Use rawBody hash to avoid storing large buffers
  const bodyHash = rawBody && Buffer.isBuffer(rawBody)
    ? crypto.createHash("sha256").update(rawBody).digest("hex")
    : rawBody ? crypto.createHash("sha256").update(String(rawBody)).digest("hex") : "";

  const h = crypto.createHash("sha256");
  h.update(bodyHash);
  h.update("::");
  h.update(provider || "unknown");
  h.update("::");
  h.update(String(providerId || ""));
  h.update("::");
  h.update(String(signature || ""));
  return { fingerprint: h.digest("hex"), bodyHash };
}

// ---------------------------
// BullMQ DLQ queue (for replays/failures/warnings)
// You must have a Redis connection available via getRedisClient()
// ---------------------------
const redisClient = getRedisClient && getRedisClient();
let dlqQueue = null;
try {
  if (redisClient) {
    dlqQueue = new Queue(DLQ_QUEUE_NAME, { connection: redisClient });
  }
} catch (err) {
  // Non-fatal — DLQ might be unavailable in some environments. We'll still operate.
  console.warn("[preventReplay] DLQ queue init failed:", err.message);
}

// ---------------------------
// enqueue to DLQ
// ---------------------------
async function enqueueToDLQ({ reason, provider, providerId, fingerprint, bodyHash, rawBody, headers, parsedPayload }) {
  metric_dlq_enqueued.inc();
  if (!dlqQueue) {
    // best-effort fallback: log and return
    console.warn("[preventReplay] DLQ queue not initialized — skipping enqueue", reason, fingerprint);
    return;
  }
  try {
    const payload = {
      reason,
      provider,
      providerId,
      fingerprint,
      bodyHash,
      headers,
      parsedPayload,
      enqueuedAt: new Date().toISOString(),
    };
    await dlqQueue.add("dlq-webhook", payload, {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 5,
      backoff: { type: "exponential", delay: DLQ_RETRY_DELAY_MS },
    });
  } catch (err) {
    console.error("[preventReplay] Failed to enqueue to DLQ:", err.message);
  }
}

// ---------------------------
// Write immutable ledger (first-time append-only)
// ---------------------------
async function writeImmutableRecord({ provider, providerId, fingerprint, signature, rawBodyHash, parsedPayload, metadata = {} }) {
  try {
    // Upsert style: only create if not exists (avoid race)
    const created = await ImmutableWebhookRecord.findOneAndUpdate(
      { fingerprint },
      {
        $setOnInsert: {
          provider,
          providerId: providerId || null,
          fingerprint,
          signature: signature || null,
          receivedAt: new Date(),
          payload: parsedPayload || null,
          rawBodyHash,
          metadata: metadata || null,
        }
      },
      { upsert: true, new: false } // new:false returns existing doc, ensuring we only write once
    );
    // If created is null => it was inserted; metric increment
    if (!created) metric_new_webhooks.inc();
  } catch (err) {
    console.error("[preventReplay] immutable ledger write failed:", err.message);
    // non-fatal — do not block webhook processing
  }
}

// ---------------------------
// main function: preventReplay()
// returns true = replay detected, false = new
// options: { rawBody, provider, providerId, signature, parsedPayload, ttlSeconds, headers, metadata }
// ---------------------------
async function preventReplay({
  rawBody,
  provider = "unknown",
  providerId = "",
  signature = "",
  parsedPayload = null,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  headers = {},
  metadata = {},
} = {}) {
  if (!rawBody) throw new Error("preventReplay requires rawBody (Buffer or string)");

  const { fingerprint, bodyHash } = buildFingerprint(rawBody, provider, providerId, signature);
  const redisKey = `${REDIS_KEY_PREFIX}:${provider}:${fingerprint}`;

  const redis = getRedisClient && getRedisClient();

  // primary path: Redis + atomic Lua
  if (redis && redis.status === "ready") {
    try {
      const res = await redis.eval(LUA_CHECK_AND_SET, 1, redisKey, ttlSeconds);
      if (res === 1) {
        // replay detected
        metric_replayed_webhooks.inc();
        // enqueue to DLQ for investigation
        await enqueueToDLQ({ reason: "replay_detected", provider, providerId, fingerprint, bodyHash, rawBody: null, headers, parsedPayload });
        return true;
      } else {
        // first-seen — write immutable ledger
        try {
          await writeImmutableRecord({ provider, providerId, fingerprint, signature, rawBodyHash: bodyHash, parsedPayload, metadata });
        } catch (err) {
          // ledger failure should not block processing
          console.warn("[preventReplay] ledger write failed (non-fatal)", err.message);
        }
        return false;
      }
    } catch (err) {
      // Redis hiccup: fallback to memory
      metric_redis_fallbacks.inc();
      console.warn("[preventReplay] Redis eval failed; falling back to memory:", err.message);
      const memReplay = memoryReplayCheck(redisKey, ttlSeconds);
      if (memReplay) {
        metric_replayed_webhooks.inc();
        // optionally send to DLQ to track degraded state
        await enqueueToDLQ({ reason: "replay_detected_memory_fallback", provider, providerId, fingerprint, bodyHash, rawBody: null, headers, parsedPayload });
        return true;
      } else {
        await writeImmutableRecord({ provider, providerId, fingerprint, signature, rawBodyHash: bodyHash, parsedPayload, metadata });
        return false;
      }
    }
  }

  // no redis available: memory fallback
  metric_redis_fallbacks.inc();
  const memReplay = memoryReplayCheck(redisKey, ttlSeconds);
  if (memReplay) {
    metric_replayed_webhooks.inc();
    await enqueueToDLQ({ reason: "replay_detected_memory_fallback", provider, providerId, fingerprint, bodyHash, rawBody: null, headers, parsedPayload });
    return true;
  } else {
    await writeImmutableRecord({ provider, providerId, fingerprint, signature, rawBodyHash: bodyHash, parsedPayload, metadata });
    return false;
  }
}

// ---------------------------
// small helper to expose metrics & DLQ queue for other modules
// ---------------------------
module.exports = {
  preventReplay,
  buildFingerprint,
  enqueueToDLQ, // useful for other flows
  getPromRegistry,
  DLQ_QUEUE_NAME,
};
