"use strict";

const { client, register } = require("../../monitoring/registry");

// ============================
// 🗺️ GEOIP METRICS
// ============================
const geoLookups = new client.Counter({
  name: "geoip_lookups_total",
  help: "Total GeoIP lookup attempts",
  registers: [register],
});

const geoSuccess = new client.Counter({
  name: "geoip_lookup_success_total",
  help: "Successful GeoIP lookups",
  registers: [register],
});

const geoMiss = new client.Counter({
  name: "geoip_lookup_miss_total",
  help: "GeoIP lookup misses (not found)",
  registers: [register],
});

const geoFail = new client.Counter({
  name: "geoip_lookup_fail_total",
  help: "Failed GeoIP lookups (errors)",
  registers: [register],
});

const geoSkippedLocal = new client.Counter({
  name: "geoip_lookup_skipped_local_total",
  help: "GeoIP lookup skipped for local/private IPs",
  registers: [register],
});

const geoByCountry = new client.Counter({
  name: "geoip_lookups_by_country_total",
  help: "GeoIP lookups grouped by country ISO code",
  labelNames: ["country"],
  registers: [register],
});

const geoLatency = new client.Histogram({
  name: "geoip_lookup_latency_ms",
  help: "GeoIP lookup latency in milliseconds",
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000],
  registers: [register],
});

// ============================
// 🛡️ RISK ENGINE & MFA METRICS
// ============================
const riskScoreHistogram = new client.Histogram({
  name: "risk_engine_score_distribution",
  help: "Unified risk engine score distribution",
  buckets: [0, 20, 40, 60, 80, 100],
  registers: [register],
});

const riskActionCounter = new client.Counter({
  name: "risk_engine_action_total",
  help: "Actions decided by unified risk engine",
  labelNames: ["action", "mode"], // action: initiated, failure, success, block
  registers: [register],
});

// ============================
// 🚀 EVENTMESH & OUTBOX WORKER
// ============================
const eventmeshQueued = new client.Counter({
  name: "eventmesh_publish_queued_total",
  help: "Total events saved to Outbox and queued for delivery",
  registers: [register],
});

const eventmeshNetworkSuccess = new client.Counter({
  name: "eventmesh_network_send_success_total",
  help: "Total successful network deliveries (SMS/Kafka)",
  labelNames: ["topic"],
  registers: [register],
});

const eventmeshNetworkFail = new client.Counter({
  name: "eventmesh_network_send_fail_total",
  help: "Total network delivery failures",
  labelNames: ["topic"],
  registers: [register],
});

// ============================
// 🪝 WEBHOOK SECURITY METRICS
// ============================
const webhookReplayCounter = new client.Counter({
  name: "webhook_replay_detected_total",
  help: "Total webhook replays blocked",
  labelNames: ["provider"],
  registers: [register],
});

const webhookAcceptedCounter = new client.Counter({
  name: "webhook_accepted_total",
  help: "Total accepted webhooks",
  labelNames: ["provider"],
  registers: [register],
});

const webhookFailureCounter = new client.Counter({
  name: "webhook_processing_failures_total",
  help: "Webhook processing failures",
  labelNames: ["provider", "stage"],
  registers: [register],
});

// ============================
// 🔥 UNIFIED EXPORTS
// ============================
module.exports = {
  // Helpers
  incrementCounter: (name, labels = {}) => {
    // Legacy switch for backward compatibility with GeoIP code
    switch (name) {
      case "geoip_lookups_total": return geoLookups.inc();
      case "geoip_lookup_success_total": return geoSuccess.inc();
      case "geoip_lookup_fail_total": return geoFail.inc();
      default: return;
    }
  },
  
  // Risk & MFA
  riskScoreHistogram,
  riskActionCounter,

  // EventMesh & Delivery
  eventmeshQueued,
  eventmeshNetworkSuccess,
  eventmeshNetworkFail,

  // Webhook
  webhookReplayCounter,
  webhookAcceptedCounter,
  webhookFailureCounter,
  
  // Latency
  geoLatency
};