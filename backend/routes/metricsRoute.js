const express = require("express");
const router = express.Router();
const { register, healthStatusGauge } = require("../monitoring/registry");
const { initHealthMonitor } = require("../utils/healthMonitorFactory");
const { AggregatorRegistry } = require("prom-client");

const aggregatorRegistry = new AggregatorRegistry();

router.get("/metrics", async (req, res) => {
  try {
    // 1. Get current health reports from your Apex Monitor
    const monitor = initHealthMonitor(/* inject your deps here */);
    const liveness = await monitor.getLivenessReport();
    const readiness = await monitor.getReadinessReport();

    // 2. Update Prometheus Gauges based on the reports
    healthStatusGauge.set(
      { type: "liveness" },
      liveness.overallStatus === "OK" ? 1 : 0
    );
    healthStatusGauge.set(
      { type: "readiness" },
      readiness.overallStatus === "OK" ? 1 : 0
    );

    // 3. Handle Cluster Mode vs Single Mode
    const isCluster = process.env.NODE_APP_INSTANCE !== undefined;
    if (isCluster) {
      const metrics = await aggregatorRegistry.clusterMetrics();
      res.set("Content-Type", aggregatorRegistry.contentType);
      return res.send(metrics);
    }

    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (ex) {
    res.status(500).send(ex.message);
  }
});

module.exports = router;
