const { Counter, Histogram } = require("prom-client");

/**
 * DLQ Counters
 * Tracks the number of processed DLQ jobs and types of outcomes
 */

// Total DLQ jobs processed
const dlqCounter = new Counter({
  name: "dlq_jobs_total",
  help: "Total number of DLQ jobs processed",
  labelNames: ["status", "provider"], // e.g., status: recovered, failed, blocked
});

// DLQ processing duration
const dlqProcessingTime = new Histogram({
  name: "dlq_processing_duration_seconds",
  help: "Time taken to process a DLQ job",
  labelNames: ["status", "provider"],
  buckets: [0.05, 0.1, 0.3, 0.5, 1, 3, 5, 10],
});

module.exports = {
  dlqCounter,
  dlqProcessingTime,
};
