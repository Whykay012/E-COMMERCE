/*
 * utils/lifecycle.js - OMEGA-LEVEL ORCHESTRATOR
 */
const { initHealthMonitor } = require("./healthMonitorFactory");
const Outbox = require("./transactionalOutbox");
const { seedThresholds } = require("../seeders/thresholdSeeder");
const {
  initializeRedlock,
  initializeCacheSubscriber,
} = require("../lib/redisClient");
const { scheduleDailyCleanup } = require("../services/idempotencyService");
const mongoose = require("mongoose");

class LifecycleManager {
  constructor(deps) {
    this.deps = deps;
    this.monitor = initHealthMonitor(deps);
    this.startupTime = Date.now();
  }

  async boot(unifiedPublisher) {
    const { infra, Logger } = this.deps;
    try {
      // Step 0: Warm up the Logger Worker Thread FIRST
      await infra.initLogger();

      Logger.info("LIFECYCLE_BOOT_STARTED");
      this.monitor.updateStartupPhase("BOOTING", false);

      // Step 1: Parallel Infra Initialization
      await Promise.all([
        infra.connectDB(),
        infra.connectRedis(),
        infra.initAuditSystem(),
        infra.initMessageBroker(),
      ]);

      // ⭐ Step 1.5: Load Apex Security Scripts (Must follow Redis connection)
      await infra.initSecurityScripts();

      this.monitor.updateStartupPhase("CONFIG_LOADED", false);

      // Step 2: Logic & Feature Seeding
      await seedThresholds();
      initializeRedlock();
      initializeCacheSubscriber();

      // Step 3: Reliability Workers
      const outboxStarted = Outbox.startWorker(unifiedPublisher, 5000);
      if (!outboxStarted) throw new Error("Outbox worker failure");

      await scheduleDailyCleanup();

      Logger.info("LIFECYCLE_BOOT_COMPLETE", {
        duration: `${(Date.now() - this.startupTime) / 1000}s`,
      });
    } catch (err) {
      console.error("LIFECYCLE_BOOT_FATAL_ERROR", err);
      process.exit(1);
    }
  }

  async shutdown(server, signal) {
    const { Logger, infra } = this.deps;
    Logger.warn(`LIFECYCLE_SHUTDOWN_TRIGGERED: ${signal}`);

    this.monitor.setShuttingDown(true);

    if (server) {
      await new Promise((resolve) => {
        server.close(() => {
          Logger.info("HTTP_SERVER_DRAINED_AND_CLOSED");
          resolve();
        });
      });
    }

    const reaper = setTimeout(() => {
      console.error("SHUTDOWN_TIMEOUT_EXCEEDED_FORCING_EXIT");
      process.exit(1);
    }, 15000);

    try {
      Outbox.stopWorker();

      await Promise.all([
        infra.shutdownAuditSystem(),
        infra.shutdownMessageBroker(),
        infra.disconnectRedis(),
        mongoose.disconnect(),
      ]);

      await infra.shutdownLogger();

      clearTimeout(reaper);
      process.exit(0);
    } catch (err) {
      console.error("SHUTDOWN_CLEANUP_FAILED", err);
      process.exit(1);
    }
  }
}

module.exports = LifecycleManager;
