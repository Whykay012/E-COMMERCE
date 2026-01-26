/**
 * dependencies.js - THE ARCHITECTURAL GLUE (ZENITH OMEGA + PINO WORKER)
 */
const mongoose = require("mongoose");
const Logger = require("./utils/logger");
const Metrics = require("./utils/metricsClient");
const BreakerRegistry = require("./services/breakerRegistry");

// Infrastructure Clients
const {
  getPrimaryClient,
  connectRedis,
  disconnectRedis,
} = require("./utils/redisClient");
const { initSecurityScripts } = require("./lib/redisInitialization"); // ⭐ ADDED
const AuditLogger = require("./services/auditLogger");
const MessageBroker = require("./services/messageBrokerClient");

module.exports = {
  Logger,
  Metrics,
  AuditLogger,
  getRedisClient: getPrimaryClient,
  getDBConnection: () => mongoose.connection,
  getAllBreakers: BreakerRegistry.getAllBreakers,
  getQueueClient: () => ({ checkHealth: async () => ({ status: "OK" }) }),

  // ───────────────────────────────────────────────────────────────────────────────
  // LIFECYCLE MAPPINGS (Wrapped with Explicit Telemetry & Worker Activation)
  // ───────────────────────────────────────────────────────────────────────────────
  infra: {
    // 0. The Logger (Must be first to start the Worker Thread)
    initLogger: async () => {
      console.log("[BOOT] Activating Async Logger Worker Thread...");
      return await Logger.initialize();
    },

    // 1. Database
    connectDB: async () => {
      Logger.info("INFRA_BOOT_SEQUENCE: Initializing MongoDB Connection...");
      const connect = require("./config/connectDb");
      return await connect();
    },

    // 2. Redis
    connectRedis: async () => {
      Logger.info("INFRA_BOOT_SEQUENCE: Initializing Redis Cluster Client...");
      return await connectRedis();
    },

    // ⭐ 2.5 Security Firmware (LUA)
    initSecurityScripts: async () => {
      Logger.info("INFRA_BOOT_SEQUENCE: Loading Apex Security LUA Scripts...");
      return await initSecurityScripts();
    },

    // 3. Audit System (Facade)
    initAuditSystem: () => AuditLogger.initialize(),

    // 4. Message Broker (Kafka)
    initMessageBroker: () => MessageBroker.connectProducer(),

    // Shutdown
    shutdownAuditSystem: () => AuditLogger.shutdown(),
    shutdownMessageBroker: () => MessageBroker.disconnectProducer(),
    disconnectRedis: () => disconnectRedis(),

    // 5. Global Shutdown for Logger (Drains all buffers)
    shutdownLogger: () => Logger.shutdown(),
  },
};
