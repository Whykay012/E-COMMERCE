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
// 💡 ALIGNED: Use the superior worker file name and function name
const { startCacheInvalidator } = require('./cacheInvalidator'); 
const broker = require('../services/messageBrokerClient');
const { 
    connectRedis, 
    disconnectRedis, 
    initializeRedlock, 
    startDeadLetterWorker 
} = require("../event/lib/redisClient");

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
        await queueClient.connect();

        // 2. Initialize Resilience Tools
        initializeRedlock();
        startDeadLetterWorker(); 

        // 3. 🚀 START KAFKA CACHE INVALIDATOR
        // Aligned with the function name in cacheInvalidator.js
        await startCacheInvalidator();
        // 3.5 🌍 SCHEDULE GEO-IP MAINTENANCE
        // This adds a repeatable job to the 'paymentMaintenance' queue
        await queueClient.send('paymentMaintenance', { 
            name: "infra.update_geoip_db", 
            data: { timestamp: Date.now() } 
        }, {
            repeat: { pattern: '0 0 * * 0' }, // Every Sunday at Midnight
            jobId: 'infra_geoip_update_singleton' // Prevents duplicates across nodes
        });

        // 4. 🛠️ WORKER 1: MAIN JOB ROUTER
        queueClient.process('jobs', async (job) => {
            const jobName = job.name || job.payload?.name;
            const jobData = job.data || job.payload?.data;
            return await routerProcessor(jobName, jobData, job);
        }, { 
            concurrency: Number(process.env.WORKER_CONCURRENCY || 20) 
        });

        // 5. 💡 WORKER 2: MAINTENANCE WORKER
        queueClient.process('paymentMaintenance', async (job) => {
            const jobName = job.name || job.payload?.name || "payment.checkExpiry";
            const jobData = job.data || job.payload?.data;
            return await routerProcessor(jobName, jobData, job);
        }, { 
            concurrency: Number(process.env.MAINTENANCE_WORKER_CONCURRENCY || 5) 
        });

        logger.info(`🚀 OMEGA Worker Cluster Online [Kafka + ${queueClient.getProviderName()}]`);
        
    } catch (err) {
        logger.error("💀 Fatal Startup Error:", err);
        process.exit(1);
    }
}

async function shutdown() {
    logger.info("Graceful shutdown initiated...");
    
    try {
        // 💡 ZENITH UPGRADE: Disconnect the broker to stop Kafka heartbeats
        // This is cleaner than calling a specific worker's stop function
        await broker.disconnectProducer(); 
        
        await queueClient.close();
        await disconnectRedis();
        await mongoose.disconnect();
        
        logger.info("Shutdown complete.");
    } catch (error) {
        logger.error("Error during shutdown:", error);
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