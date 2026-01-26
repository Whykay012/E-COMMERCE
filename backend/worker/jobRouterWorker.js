/*
 * workers/jobRouterWorker.js
 * ------------------------------------------------------------------
 * OMEGA Worker Cluster - Centralized Job Router & Lifecycle Manager
 * ------------------------------------------------------------------
 */

require("dotenv").config();
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// --- Configuration & Logging ---
const config = require("../config");
const logger = require("../config/logger");
const connectDB = require("../config/connect");

// --- Infrastructure & Unified Queue Client ---
const queueClient = require('../services/queueClient');
const routerProcessor = require('./routerProcessor'); 
const { startCacheConsumer, stopCacheConsumer } = require('./cacheConsumer'); // Updated for lifecycle

const { 
    connectRedis, 
    disconnectRedis, 
    initializeRedlock, 
    startDeadLetterWorker 
} = require("../utils/redisClient");

// =================================================================================
// 🚀 LIFECYCLE MANAGEMENT (Startup & Shutdown)
// =================================================================================

/**
 * Boots the worker infrastructure and initializes isolated worker pools
 */
async function boot() {
    try {
        logger.info("INITIATING_OMEGA_BOOT_SEQUENCE...");

        // 1. Establish Core Connections
        await connectDB(config.MONGO_URI);
        await connectRedis();
        await queueClient.connect(); // Initializes BullMQ or SQS adapter

        // 2. Initialize Resilience Tools
        initializeRedlock();
        startDeadLetterWorker(); 

        // 3. 🚀 START KAFKA CACHE CONSUMER (Event Streaming)
        // Listens for high-priority invalidation events from the Notification Service
        await startCacheConsumer();

        // 4. 🛠️ WORKER 1: MAIN JOB ROUTER (High Throughput)
        queueClient.process('jobs', async (job) => {
            const jobName = job.name || job.payload?.name;
            const jobData = job.data || job.payload?.data;

            return await routerProcessor(jobName, jobData, job);
        }, { 
            concurrency: Number(process.env.WORKER_CONCURRENCY || 20) 
        });

        // 5. 💡 WORKER 2: MAINTENANCE WORKER (Resource Isolation)
        queueClient.process('paymentMaintenance', async (job) => {
            const jobName = job.name || job.payload?.name || "payment.checkExpiry";
            const jobData = job.data || job.payload?.data;

            return await routerProcessor(jobName, jobData, job);
        }, { 
            concurrency: Number(process.env.MAINTENANCE_WORKER_CONCURRENCY || 5) 
        });

        logger.info(`🚀 OMEGA Worker Cluster Online [Kafka + ${queueClient.getProviderName()}]`);
        logger.info(`📊 Isolation Active: 'jobs' (c:${process.env.WORKER_CONCURRENCY || 20}) | 'paymentMaintenance' (c:5)`);
        
    } catch (err) {
        logger.error("💀 Fatal Startup Error:", err);
        process.exit(1);
    }
}

/**
 * Executes a graceful shutdown of all connections and workers
 */
async function shutdown() {
    logger.info("Graceful shutdown initiated...");
    
    try {
        // Stop Kafka Consumer first to stop taking new messages
        await stopCacheConsumer();
        
        // Close BullMQ/SQS workers
        await queueClient.close();
        
        // Clean up remaining infrastructure
        await disconnectRedis();
        await mongoose.disconnect();
        
        logger.info("Shutdown complete. All workers and connections closed.");
    } catch (error) {
        logger.error("Error during shutdown sequence:", error);
    } finally {
        process.exit(0);
    }
}

// OS Signal Listeners
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Launch!
boot();

module.exports = { boot, shutdown };