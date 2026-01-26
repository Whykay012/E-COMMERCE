/*
 * utils/loggerWorker.js - ZENITH OMEGA HIGH-PERFORMANCE LOG TRANSPORT
 * Dedicated Worker Thread for asynchronous log batching and Datadog transport.
 */
const { parentPort } = require("worker_threads");
const http = require("http");
const https = require("https");
const { URL } = require("url");

// --- Transport Configuration ---
const BATCH_SIZE = 100; // Number of logs before a forced flush
const BATCH_INTERVAL_MS = 1000; // Maximum time logs sit in buffer

// Environment Variables
const LMS_ENDPOINT = process.env.LOG_AGGREGATOR_URL || null;
const DD_API_KEY = process.env.LOG_AGGREGATOR_TOKEN || null;
const SERVICE_NAME = process.env.SERVICE_NAME || "omega-auth-service";

let logBuffer = [];
let flushTimer = null;
let isShuttingDown = false;

/**
 * @desc Native HTTP/HTTPS POST implementation for Datadog API v2
 * Sends logs as a JSON array.
 */
async function postToLMS(payload) {
  return new Promise((resolve, reject) => {
    if (!LMS_ENDPOINT || !DD_API_KEY) return resolve();

    const url = new URL(LMS_ENDPOINT);
    const protocol = url.protocol === "https:" ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "DD-API-KEY": DD_API_KEY,
        "Content-Length": Buffer.byteLength(payload),
        "X-Service-Name": SERVICE_NAME,
      },
      timeout: 5000, // 5-second timeout for transport
    };

    const req = protocol.request(options, (res) => {
      res.on("data", () => {}); // Consume stream
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`DATADOG_REJECTED_STATUS_${res.statusCode}`));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("DATADOG_TIMEOUT"));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * @desc Transmits a batch of logs to the external LMS and falls back to STDOUT.
 */
const transmitBatch = async (batch, isEmergency = false) => {
  const count = batch.length;
  if (count === 0) return;

  // 1. Format for Datadog (JSON Array format)
  const payload = `[${batch.join(",")}]`;

  // 2. PRIMARY SAFETY: Always write to STDOUT for local visibility/Docker logs
  process.stdout.write(batch.join("\n") + "\n");

  // 3. EXTERNAL TRANSPORT: Send to Datadog
  if (LMS_ENDPOINT && DD_API_KEY) {
    try {
      await postToLMS(payload);
    } catch (err) {
      // We don't crash the worker; logs are already safe in STDOUT.
      console.error(`[LOGGER_WORKER_ERROR] Transport Failed: ${err.message}`);
    }
  }

  // 4. SIGNAL Main Thread that flush is complete
  if (parentPort) {
    parentPort.postMessage({ type: "flushed", count });
  }
};

/**
 * @desc Orchestrates the buffering and flushing logic.
 */
const flushBatch = (isEmergency = false) => {
  if (logBuffer.length === 0) {
    if (isEmergency && parentPort) {
      parentPort.postMessage({ type: "flushed", count: 0 });
    }
    return;
  }

  const currentBatch = [...logBuffer];
  logBuffer = []; // Reset immediately

  if (isEmergency) {
    transmitBatch(currentBatch, true);
  } else {
    setImmediate(() => transmitBatch(currentBatch));
  }
};

// =================================================================================
// 👑 WORKER EVENT LISTENERS
// =================================================================================

parentPort.on("message", (message) => {
  // Shutdown Signal from LifecycleManager.infra.shutdownLogger()
  if (message === "FLUSH_REQUEST") {
    isShuttingDown = true;
    clearTimeout(flushTimer);
    flushBatch(true); // Forced synchronous flush
    return;
  }

  // Ingest Log line (Pino sends a JSON string)
  logBuffer.push(message);

  // Scenario A: Batch Threshold Reached
  if (logBuffer.length >= BATCH_SIZE) {
    clearTimeout(flushTimer);
    flushTimer = null;
    flushBatch();
  }
  // Scenario B: Periodic Flush Timer
  else if (!flushTimer && !isShuttingDown) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushBatch();
    }, BATCH_INTERVAL_MS);
  }
});

// Emergency cleanup handler
parentPort.on("close", () => {
  if (logBuffer.length > 0) {
    flushBatch(true);
  }
});
