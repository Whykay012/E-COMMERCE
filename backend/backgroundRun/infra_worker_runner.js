// infra_worker_runner.js
/**
 * Dedicated Runner for Infrastructure/Utility Workers (e.g., GeoIP Refresh).
 * Focused on I/O stability and low latency for utility data.
 */

require('dotenv').config(); 
const connectDB = require("./config/connect");
const config = require("./config");
const { connectRedis } = require("./lib/redisClient");
const logger = require("./config/logger");

// --- Imports: Infrastructure Components ---
// 1. GeoIP Worker and Scheduler
const { worker: geoipWorker, scheduler: geoipScheduler } = require('./services/geoip/geoIpService');

let workerResources = []; // Will be populated in startInfraWorkers

async function startInfraWorkers() {
    try {
        await connectDB(config.MONGO_URI);
        await connectRedis(); 
        logger.info("✅ Infra Worker Dependencies connected.");

        // GeoIP Worker/Scheduler are initialized on require.
        geoipWorker.on('error', (err) => logger.error("GeoIP Worker Error:", err.message));
        logger.info("✅ GeoIP Worker is active.");
        logger.info("✅ GeoIP Scheduler is active.");

        workerResources = [geoipWorker, geoipScheduler];
        
        logger.info(`\n======================================================`);
        logger.info(`| Infrastructure Worker Process Started. PID: ${process.pid}`);
        logger.info(`| Active Workers: GeoIP Refresh                        |`);
        logger.info(`======================================================\n`);
    } catch (err) {
        logger.error("❌ [FATAL] Infra Worker process failed to start.", { error: err.message });
        await shutdown(true);
        process.exit(1);
    }
}

// --- Graceful Shutdown Logic ---
async function shutdown(isFailure = false) {
    if (!isFailure) logger.info("Shutting down Infra Worker process gracefully...");
    
    const resourcesToClose = [...workerResources].reverse(); 
    
    for (const resource of resourcesToClose) {
        if (resource && typeof resource.close === 'function') {
            try {
                await resource.close();
                logger.info(`Resource closed: ${resource.name || resource.constructor.name}`);
            } catch (err) {
                logger.error(`Error closing resource: ${resource.name || resource.constructor.name}`, { err: err.message });
            }
        }
    }
    logger.info("Infra Worker shutdown complete.");
    if (!isFailure) process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startInfraWorkers();