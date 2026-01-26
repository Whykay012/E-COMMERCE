const mongoose = require("mongoose");
const Outbox = require("../model/outboxModel");
const { queueJob, GENERAL_QUEUE_NAME } = require("../queues/jobQueue");
const logger = require("../config/logger");
const redis = require("../config/redisClient"); // Ensure you export your redis client

const EVENT_MAP = {
  PASSWORD_ROTATION: "auth.password_rotation_relay",
  ERASURE_REQUEST: "compliance.erasure_request",
  OTP_RESEND: "auth.email_relay", // Added to support your OTP flow
};

let retryDelay = 1000;

/**
 * TRIGGER: Notifies the cluster that a specific event is ready for immediate processing.
 * This is called after a successful DB insert.
 */
const triggerFastPath = async (traceId) => {
  try {
    await redis.publish("outbox:fast-path", JSON.stringify({ traceId }));
  } catch (err) {
    logger.error("Failed to publish to Fast Path", {
      traceId,
      error: err.message,
    });
  }
};

/**
 * SUBSCRIPTION: Listens for the "poke" from other instances.
 * This ensures that if Instance A saves the record, Instance B can process it instantly.
 */
const setupFastPathSubscriber = () => {
  const redisSubscriber = redis.duplicate(); // Subscribers need a dedicated connection
  redisSubscriber.connect().then(() => {
    redisSubscriber.subscribe("outbox:fast-path", async (message) => {
      try {
        const { traceId } = JSON.parse(message);

        // 1. Fetch the document
        const doc = await Outbox.findOne({ traceId, status: "PENDING" });
        if (!doc) return;

        // 2. Map to job
        const jobName = EVENT_MAP[doc.eventType];
        if (!jobName) return;

        // 3. Push to Reliability Queue (BullMQ)
        await queueJob(
          GENERAL_QUEUE_NAME,
          jobName,
          {
            outboxId: doc._id.toString(),
            userId: doc.userId,
            traceId: doc.traceId,
            payload: doc.payload,
          },
          {
            priority: doc.priority || 5,
            jobId: doc.idempotencyKey || `outbox-${doc._id}`,
          }
        );

        logger.debug(
          `[FAST-PATH] Event ${doc.eventType} relayed via Redis hint.`,
          { traceId }
        );
      } catch (err) {
        logger.error("[FAST-PATH] Execution error", { error: err.message });
      }
    });
  });
};

/**
 * CHANGE STREAM: The primary observer for new database entries.
 */
const watchOutbox = () => {
  logger.info("🚀 Starting Outbox Change Stream & Fast Path Subscriber...");

  // Initialize the Redis listener
  setupFastPathSubscriber();

  const changeStream = Outbox.watch(
    [{ $match: { operationType: "insert", "fullDocument.status": "PENDING" } }],
    { fullDocument: "updateLookup" }
  );

  changeStream.on("change", async (change) => {
    retryDelay = 1000;

    const doc = change.fullDocument;
    const jobName = EVENT_MAP[doc.eventType];

    if (!jobName) return;

    try {
      // Trigger the Fast Path notification across the cluster
      await triggerFastPath(doc.traceId);

      // Also perform local queuing as a secondary immediate action
      await queueJob(
        GENERAL_QUEUE_NAME,
        jobName,
        {
          outboxId: doc._id.toString(),
          userId: doc.userId,
          traceId: doc.traceId,
          payload: doc.payload,
        },
        {
          priority: doc.priority || 5,
          jobId: doc.idempotencyKey || `outbox-${doc._id}`,
        }
      );
      logger.info(`Outbox event ${doc.eventType} relayed.`, {
        outboxId: doc._id,
      });
    } catch (error) {
      logger.error("Failed to relay Outbox event", {
        error: error.message,
        outboxId: doc._id,
      });
    }
  });

  changeStream.on("error", (err) => {
    logger.error(
      `Outbox Stream Error: ${err.message}. Retrying in ${
        retryDelay / 1000
      }s...`
    );
    changeStream.close();
    setTimeout(() => {
      retryDelay = Math.min(retryDelay * 2, 30000);
      watchOutbox();
    }, retryDelay);
  });
};

module.exports = { watchOutbox, triggerFastPath };
