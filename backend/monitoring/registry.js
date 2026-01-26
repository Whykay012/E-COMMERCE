"use strict";
const client = require("prom-client");
const register = new client.Registry();

client.collectDefaultMetrics({ register, prefix: "auth_service_" });

// --- NEW: Health Status Gauge ---
const healthStatusGauge = new client.Gauge({
  name: "service_health_status",
  help: "Overall health status (1 = OK, 0 = UNAVAILABLE/DEGRADED)",
  labelNames: ["type"], // 'liveness' or 'readiness'
  registers: [register],
});

module.exports = { client, register, healthStatusGauge };
