"use strict";

const { client, register } = require("./registry");

/**
 * DLQ & Worker Metrics
 */
const dlqCounter = new client.Counter({
    name: "dlq_events_total",
    help: "Total count of DLQ processed items",
    labelNames: ["status", "provider"],
    registers: [register],
});

const dlqProcessingTime = new client.Histogram({
    name: "dlq_processing_duration_seconds",
    help: "Duration of DLQ job processing",
    labelNames: ["status", "provider"],
    buckets: [0.05, 0.1, 0.5, 1, 3, 5],
    registers: [register],
});

/**
 * Security Metrics
 */
const replayCounter = new client.Counter({
    name: "webhook_replay_total",
    help: "Total detected webhook replays",
    labelNames: ["provider"],
    registers: [register],
});

const banCounter = new client.Counter({
    name: "webhook_replay_ban_total",
    help: "Total security bans triggered by replays",
    labelNames: ["provider"],
    registers: [register],
});

/**
 * Legacy Job Metrics
 */
const cleanupJobDuration = new client.Histogram({
    name: "product_cleanup_duration_seconds",
    help: "Duration of product cleanup jobs",
    buckets: [1, 5, 10, 30, 60],
    registers: [register],
});

module.exports = {
    register,
    dlqCounter,
    dlqProcessingTime,
    replayCounter,
    banCounter,
    cleanupJobDuration
};