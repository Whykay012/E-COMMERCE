"use strict";

const crypto = require("crypto");
const { getRedisClient } = require("../lib/redisClient"); 
const ImmutableWebhookRecord = require("../model/ImmutableWebhookRecord");
const promClient = require("prom-client");

// ---------------------------
// CONFIG
// ---------------------------
const DEFAULT_TTL_SECONDS = Number(process.env.WEBHOOK_REPLAY_TTL || 24 * 3600);
const MEMORY_FALLBACK_LIMIT = Number(process.env.MEMORY_FALLBACK_LIMIT || 10000);
const REDIS_KEY_PREFIX = process.env.WEBHOOK_REPLAY_PREFIX || "webhook:replay";
const REPLAY_BAN_THRESHOLD = Number(process.env.REPLAY_BAN_THRESHOLD || 5);
const REPLAY_BAN_TTL = Number(process.env.REPLAY_BAN_TTL || 3600);

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
const metric_redis_fallbacks = new promClient.Counter({
  name: "webhook_replay_redis_fallback_total",
  help: "Count of times Redis was unavailable and memory fallback used",
});

[metric_new_webhooks, metric_replayed_webhooks, metric_redis_fallbacks].forEach(m => registry.registerMetric(m));

// ---------------------------
// MEMORY UPGRADE: LRU Strategy
// ---------------------------
const memoryStore = new Map();
const memoryExpiries = new Map();

function memoryReplayCheck(key, ttlSeconds) {
  const now = Date.now();
  if (memoryExpiries.has(key) && now > memoryExpiries.get(key)) {
    memoryStore.delete(key);
    memoryExpiries.delete(key);
  }
  if (memoryStore.has(key)) return true;
  if (memoryStore.size >= MEMORY_FALLBACK_LIMIT) {
    const oldestKey = memoryStore.keys().next().value;
    memoryStore.delete(oldestKey);
    memoryExpiries.delete(oldestKey);
  }
  memoryStore.set(key, true);
  memoryExpiries.set(key, now + (ttlSeconds * 1000));
  return false;
}

// ---------------------------
// Fingerprint builder
// ---------------------------
function buildFingerprint(rawBody, provider = "unknown", providerId = "", signature = "") {
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
// Write immutable ledger
// ---------------------------
async function writeImmutableRecord({ provider, providerId, fingerprint, signature, rawBodyHash, parsedPayload, metadata = {} }) {
  try {
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
      { upsert: true, new: false }
    );
    if (!created) metric_new_webhooks.inc();
  } catch (err) {
    console.error("[preventReplay] immutable ledger write failed:", err.message);
  }
}

// ---------------------------
// Main: preventReplay()
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
  if (!rawBody) throw new Error("preventReplay requires rawBody");

  const { fingerprint, bodyHash } = buildFingerprint(rawBody, provider, providerId, signature);
  const redisKey = `${REDIS_KEY_PREFIX}:${provider}:${fingerprint}`;
  const banKey = `${redisKey}:ban`; 

  let redis;
  try {
    redis = getRedisClient();
  } catch (e) {
    redis = null;
  }

  // --- Path 1: Redis Cluster with replayGuard ---
  if (redis && redis.status === "ready") {
    try {
      const res = await redis.replayGuard(
        redisKey,       // KEYS[1]
        banKey,         // KEYS[2]
        ttlSeconds,     // ARGV[1]
        REPLAY_BAN_THRESHOLD, // ARGV[2]
        REPLAY_BAN_TTL        // ARGV[3]
      );

      /**
       * 💡 THE "PERFECT" LOGIC:
       * res[0] is the current count.
       * If count > 1, it's a replay.
       * If res[1] is 1, it's a "Banned" replay.
       */
      if (res && res[0] > 1) {
        metric_replayed_webhooks.inc();

        // If it triggered a ban, send high-priority alert to OMEGA Stream
        if (res[1] === 1) {
          await redis.xadd("dlq:stream:jobs", "*", "payload", JSON.stringify({
             reason: "replay_ban_triggered",
             fingerprint,
             provider,
             finalCount: res[0]
          }));
        }
        return true; // BLOCK THE WEBHOOK
      }

      // If we are here, count is 1 (first time seeing it)
      await writeImmutableRecord({ provider, providerId, fingerprint, signature, rawBodyHash: bodyHash, parsedPayload, metadata });
      return false;

    } catch (err) {
      metric_redis_fallbacks.inc();
      console.warn("[preventReplay] Redis Cluster command failed:", err.message);
    }
  }

  // --- Path 2: Memory Fallback ---
  metric_redis_fallbacks.inc();
  if (memoryReplayCheck(redisKey, ttlSeconds)) {
    metric_replayed_webhooks.inc();
    return true;
  }

  await writeImmutableRecord({ provider, providerId, fingerprint, signature, rawBodyHash: bodyHash, parsedPayload, metadata });
  return false;
}

module.exports = {
  preventReplay,
  buildFingerprint,
  getPromRegistry: () => registry,
};