/*
 * generic_worker_runner.js
 * ------------------------------------------------------------------
 * Entry point for scaling the OMEGA Worker Cluster
 * ------------------------------------------------------------------
 */

require('dotenv').config(); 
const logger = require("./config/logger");

// Import the cluster (This automatically triggers its internal boot() logic)
const workerCluster = require("./worker/jobRouterWorker"); 

async function startGenericWorkers() {
    try {
        // We don't need connectDB or connectRedis here 
        // because jobRouterWorker.js calls boot() on load.

        // Setup listeners for the main worker in the cluster
        workerCluster.mainWorker.on('error', (err) => {
            logger.error("❌ [MAIN_WORKER] Error:", { message: err.message });
        });

        workerCluster.maintenanceWorker.on('error', (err) => {
            logger.error("❌ [MAINT_WORKER] Error:", { message: err.message });
        });

        logger.info(`\n======================================================`);
        logger.info(`| 🚀 OMEGA Worker Process Started. PID: ${process.pid}`);
        logger.info(`| Active Nodes: Main Router, Maintenance Runner      |`);
        logger.info(`| Status: Validating via Central Schema Registry     |`);
        logger.info(`======================================================\n`);

    } catch (err) {
        logger.error("❌ [FATAL] Worker process failed to start.", { error: err.message });
        process.exit(1);
    }
}

// OS Signal Listeners are already handled inside jobRouterWorker.js (SIGINT/SIGTERM),
// so we don't necessarily need them here unless we have runner-specific cleanup.

startGenericWorkers();