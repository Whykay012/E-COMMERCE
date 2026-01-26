require("dotenv").config();

const { Worker, QueueScheduler } = require("bullmq");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const { getRedisClient } = require("../utils/redisClient");
const { getFabricStatus } = require("../services/healthService");
const { DLQ_QUEUE_NAME } = require("../utils/preventReplay");
const logger = require("../utils/logger");
const { dlqCounter, dlqProcessingTime } = require("../metrics/dlqMetrics");

// Prometheus counters for replays/bans
const { Counter } = require("prom-client");
const replayCounter = new Counter({
  name: "webhook_replay_total",
  help: "Total detected webhook replays",
  labelNames: ["provider"]
});
const banCounter = new Counter({
  name: "webhook_replay_ban_total",
  help: "Total replay-triggered bans",
  labelNames: ["provider"]
});

const redis = getRedisClient();
const REPLAY_WINDOW_SEC = 3600;
const REPLAY_BAN_THRESHOLD = 5;
const TEMP_BAN_SEC = 86400;
const HTTP_TIMEOUT_MS = 5000;

const replayLua = fs.readFileSync(
  path.join(__dirname, "../lua/replayGuard.lua"),
  "utf8"
);

new QueueScheduler(DLQ_QUEUE_NAME, { connection: redis });

const worker = new Worker(
  DLQ_QUEUE_NAME,
  async (job) => {
    const timer = dlqProcessingTime.startTimer({ provider: job.data.provider });
    const { reason, provider, providerId, fingerprint, parsedPayload, ingressRequestId, rateLimitKey } = job.data;

    if (!getFabricStatus()) throw new Error("FABRIC_UNHEALTHY");

    logger.warn("[DLQ] Processing", { jobId: job.id, reason, provider, fingerprint, ingressRequestId });

    try {
      // --- Security: replay + ban ---
      if (reason?.startsWith("replay_detected")) {
        replayCounter.inc({ provider: provider || "unknown" });
        dlqCounter.inc({ status: "security_blocked", provider: provider || "unknown" });

        const replayKey = `sec:r:{${provider || "global"}}:${fingerprint}`;
        const banKey = provider ? `ban:p:{${provider}}:${providerId || fingerprint}` : `ban:f:${fingerprint}`;

        const [replayCount, banned] = await redis.eval(
          replayLua,
          2,
          replayKey,
          banKey,
          REPLAY_WINDOW_SEC,
          REPLAY_BAN_THRESHOLD,
          TEMP_BAN_SEC
        );

        if (banned === 1) banCounter.inc({ provider: provider || "unknown" });

        timer({ status: "security_blocked", provider });
        return { status: "security_blocked", replayCount, banned: Boolean(banned), terminal: true };
      }

      // --- Recovery: Delivery Failures ---
      if (reason === "delivery_failure" && parsedPayload?.retryUrl) {
        try {
          await axios.post(parsedPayload.retryUrl, parsedPayload.body, {
            headers: parsedPayload.headers,
            timeout: HTTP_TIMEOUT_MS,
          });

          dlqCounter.inc({ status: "recovered", provider: provider || "unknown" });
          timer({ status: "recovered", provider });
          return { status: "recovered" };
        } catch (err) {
          const status = err.response?.status;
          const isRetryable = !status || status >= 500;

          if (!isRetryable) {
            dlqCounter.inc({ status: "permanent_failure", provider: provider || "unknown" });
            timer({ status: "permanent_failure", provider });
            return { status: "permanent_failure", reason: "client_error" };
          }

          throw err; // BullMQ retry
        }
      }

      dlqCounter.inc({ status: "unhandled", provider: provider || "unknown" });
      timer({ status: "unhandled", provider });
      return { status: "unhandled" };
    } catch (error) {
      timer({ status: "failed", provider });
      throw error;
    }
  },
  {
    connection: redis,
    concurrency: Number(process.env.DLQ_WORKER_CONCURRENCY || 2),
    settings: { backoff: { type: "exponential", delay: 1000 } },
  }
);

worker.on("completed", (job, result) => {
  logger.info("[DLQ] Completed", { jobId: job.id, result });
});

worker.on("failed", (job, err) => {
  logger.error("[DLQ] Failed", { jobId: job?.id, attempts: job?.attemptsMade, error: err.message });
});

module.exports = { worker, dlqCounter, dlqProcessingTime, replayCounter, banCounter };
