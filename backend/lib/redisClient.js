/**
 * utils/redisClient.js
 * COSMOS HYPER-FABRIC OMEGA: Streams-Based DLQ & Centralized Health Checks
 * * Includes:
 * 1. Automatic Hash-Tagging for Cluster Sharding (ReplayGuard Compatibility).
 * 2. Multi-Worker Redis Streams DLQ logic.
 * 3. Redlock Distributed Locking & Dedicated Pub/Sub Subscriber.
 */

const Redis = require("ioredis");
const Redlock = require("redlock");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const { getRedisConnectionDetails } = require("../config/redisConnection");
const { REDIS_NODES } = require("../config/redisNodes");

// --- Configuration ---
const DLQ_STREAM_KEY = "dlq:stream:jobs";
const DLQ_CONSUMER_GROUP = "dlq_processors";
const DLQ_WORKER_NAME = `dlq_worker_${Math.random()
  .toString(36)
  .substring(2, 8)}`;
const MAX_DLQ_RETRIES = 5;
const BLOCK_TIMEOUT_MS = 2000;

// ---------------------------------------------------
// 1. Core Redis Clients and Services
// ---------------------------------------------------

let redisCluster;
let redlock;
let subscriber;

/**
 * @desc Establishes connection to the Redis Cluster.
 * @returns {Redis.Cluster} The main Redis client.
 */
function connectRedis() {
  if (redisCluster) return redisCluster;

  redisCluster = new Redis.Cluster(REDIS_NODES, {
    redisOptions: {
      ...getRedisConnectionDetails(),
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      connectTimeout: 10000,
    },
  });

  redisCluster.on("ready", () => {
    logger.info("Redis Cluster READY");

    /**
     * ======================================
     * Lua Replay Guard (Atomic Security)
     * ======================================
     * Registered ONCE per process. Safe for Redis Cluster.
     */
    try {
      const replayLuaPath = path.join(__dirname, "../lua/replayGuard.lua");
      if (fs.existsSync(replayLuaPath)) {
        const replayLua = fs.readFileSync(replayLuaPath, "utf8");

        // Register custom command
        redisCluster.defineCommand("replayGuardRaw", {
          numberOfKeys: 2,
          lua: replayLua,
        });

        /**
         * 🛰️ CLUSTER SHARDING WRAPPER
         * Automatically ensures keys land on the same node using hash tags {}
         */
        redisCluster.replayGuard = async (key1, key2, ...args) => {
          // Extract an identifier (e.g., userId) to create a shared hash slot
          // If keys already contain {}, we use them; otherwise, we wrap the keys.
          const taggedKey1 = key1.includes("{") ? key1 : `{${key1}}`;
          const taggedKey2 = key2.includes("{") ? key2 : `{${key1}}:ban`;

          return redisCluster.replayGuardRaw(taggedKey1, taggedKey2, ...args);
        };

        logger.info(
          "Redis Lua command 'replayGuard' registered with Cluster-Aware wrapping"
        );
      }
    } catch (err) {
      logger.error(
        { err: err.message },
        "Failed to load replayGuard Lua script"
      );
    }
  });

  redisCluster.on("error", (err) =>
    logger.error({ err }, "Redis Cluster error")
  );

  return redisCluster;
}

/**
 * @desc Initializes Redlock for multi-node distributed locking.
 */
function initializeRedlock() {
  if (redlock) return redlock;
  const clients = [redisCluster || connectRedis()];

  redlock = new Redlock(clients, {
    driftFactor: 0.01,
    retryCount: 6,
    retryDelay: 200,
    retryJitter: 100,
  });

  redlock.on("clientError", (err) =>
    logger.error({ err }, "Redlock client error")
  );
  logger.info("Redlock initialized and attached to Cluster");
  return redlock;
}

/**
 * @desc Creates and subscribes the dedicated Pub/Sub client.
 */
function initializeCacheSubscriber() {
  if (subscriber) return subscriber;

  subscriber = new Redis.Cluster(REDIS_NODES, {
    redisOptions: getRedisConnectionDetails(),
  });

  const CACHE_CHANNEL = "cache:invalidate";

  subscriber.subscribe(CACHE_CHANNEL, (err) => {
    if (err) logger.error({ err }, `Subscription to ${CACHE_CHANNEL} failed`);
    else logger.info(`Subscribed to channel: ${CACHE_CHANNEL}`);
  });

  subscriber.on("message", async (channel, key) => {
    if (channel === CACHE_CHANNEL) {
      try {
        await redisCluster.del(key);
        logger.info({ key }, "L2 Cache invalidated via Pub/Sub");
      } catch (err) {
        logger.error({ err, key }, "Failed to process cache invalidation");
      }
    }
  });

  return subscriber;
}

/**
 * @desc Graceful disconnection.
 */
async function disconnectRedis() {
  logger.info("Disconnecting Redis clients...");
  const closures = [];
  if (redisCluster) closures.push(redisCluster.quit());
  if (subscriber) closures.push(subscriber.quit());

  await Promise.allSettled(closures);
  redisCluster = null;
  subscriber = null;
  redlock = null;
  logger.info("Redis clients disconnected.");
}

// ---------------------------------------------------
// 2. Dead Letter Queue (DLQ) Worker (Redis Streams)
// ---------------------------------------------------

async function setupDLQConsumerGroup() {
  try {
    await redisCluster.xgroup(
      "CREATE",
      DLQ_STREAM_KEY,
      DLQ_CONSUMER_GROUP,
      "$",
      "MKSTREAM"
    );
    logger.info(`DLQ Consumer Group '${DLQ_CONSUMER_GROUP}' created`);
  } catch (err) {
    if (!err.message.includes("BUSYGROUP")) {
      logger.error({ err }, "Failed to setup DLQ Consumer Group");
    }
  }
}

async function startDeadLetterWorker() {
  if (!redisCluster) connectRedis();
  await setupDLQConsumerGroup();

  async function pollStream() {
    try {
      await processPendingStreamEntries();

      const response = await redisCluster.xreadgroup(
        "GROUP",
        DLQ_CONSUMER_GROUP,
        DLQ_WORKER_NAME,
        "BLOCK",
        BLOCK_TIMEOUT_MS,
        "COUNT",
        10,
        "STREAMS",
        DLQ_STREAM_KEY,
        ">"
      );

      if (response) {
        const [, messages] = response[0];
        for (const [id, fields] of messages) {
          const job = parseStreamMessage(fields);
          processDlqJob(id, job);
        }
      }
    } catch (err) {
      logger.error({ err }, "DLQ Stream Worker read failure");
    }
    setImmediate(pollStream);
  }

  pollStream();
  logger.info(`Dead Letter Stream Worker '${DLQ_WORKER_NAME}' active`);
}

async function processDlqJob(id, payload) {
  const attempt = (payload.attempt || 0) + 1;
  payload.attempt = attempt;

  if (attempt > MAX_DLQ_RETRIES) {
    logger.error({ payload }, "DLQ exceeded max retries");
    await redisCluster.rpush("dlq:permanent", JSON.stringify(payload));
    await redisCluster.xack(DLQ_STREAM_KEY, DLQ_CONSUMER_GROUP, id);
    return;
  }

  const backoff = Math.pow(2, attempt) * 1000;
  setTimeout(async () => {
    try {
      // Logic for job execution would go here
      await redisCluster.xack(DLQ_STREAM_KEY, DLQ_CONSUMER_GROUP, id);
      logger.info({ payload }, `DLQ retry succeeded (Attempt ${attempt})`);
    } catch (err) {
      logger.error({ err, payload }, "DLQ retry failed");
    }
  }, backoff);
}

async function processPendingStreamEntries() {
  const result = await redisCluster.xautoclaim(
    DLQ_STREAM_KEY,
    DLQ_CONSUMER_GROUP,
    DLQ_WORKER_NAME,
    300000,
    "0-0",
    "COUNT",
    10
  );

  if (result && result[1] && result[1].length > 0) {
    const messages = result[1];
    for (const [id, fields] of messages) {
      const job = parseStreamMessage(fields);
      processDlqJob(id, job);
    }
  }
}

// ---------------------------------------------------
// 3. Helpers & Exported Interfaces
// ---------------------------------------------------

function parseStreamMessage(fields) {
  const job = {};
  for (let i = 0; i < fields.length; i += 2) {
    try {
      job[fields[i]] = JSON.parse(fields[i + 1]);
    } catch (e) {
      job[fields[i]] = fields[i + 1];
    }
  }
  return job.payload || job;
}

async function checkHealth() {
  try {
    if (!redisCluster) return false;
    const response = await redisCluster.ping();
    return response === "PONG";
  } catch (e) {
    logger.error({ error: e.message }, "Redis Health Check Failed");
    return false;
  }
}

function getRedisClient() {
  if (!redisCluster) throw new Error("Redis Cluster not connected.");
  return redisCluster;
}

function getRedlock() {
  if (!redlock) throw new Error("Redlock not initialized.");
  return redlock;
}

function getRedisSubscriber() {
  if (!subscriber) throw new Error("Redis Subscriber not initialized.");
  return subscriber;
}

module.exports = {
  connectRedis,
  disconnectRedis,
  initializeRedlock,
  initializeCacheSubscriber,
  startDeadLetterWorker,
  getRedisClient,
  getRedlock,
  getRedisSubscriber,
  checkHealth,
  Redis,
};
