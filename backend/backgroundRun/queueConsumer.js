// security_worker_runner.js (DEDICATED SECURITY WORKER)

/**
 * Dedicated Runner for Authentication, Session Management, and Security Events.
 * This process is isolated from critical financial flows for stability.
 */

require('dotenv').config(); 
// --- Shared Dependencies ---
const connectDB = require("./config/connect");
const config = require("./config");
const { connectRedis } = require("./lib/redisClient");
const logger = require("./config/logger"); 

// --- Imports: Security Components ---
const queueClient = require('./services/queueClient'); 
const { 
    revokeSessionAndCleanup // The worker function from the service layer
} = require('./services/authService'); 

// --- Configuration ---
const LOGOUT_QUEUE_NAME = 'SECURITY_LOGOUT_EVENT';
const SECURITY_WORKER_CONCURRENCY = 5; 

let securityLogoutWorker;
let workerResources = []; 

async function startSecurityWorkers() {
    try {
        // --- STEP 1: Connect Shared Dependencies ---
        await connectDB(config.MONGO_URI);
        await connectRedis(); 
        await queueClient.connect(); 
        logger.info("✅ Security Worker Dependencies (DB, Redis, Queue Client) connected.");

        // --- STEP 2: Start the Security Logout Worker ---
        logger.info(`Starting consumer on queue: ${LOGOUT_QUEUE_NAME} with concurrency: ${SECURITY_WORKER_CONCURRENCY}`);
        
        securityLogoutWorker = queueClient.process(
            LOGOUT_QUEUE_NAME, 
            async (job) => {
                const payload = job.payload || job.data; 
                logger.debug(`Processing SECURITY Logout Job ID: ${job.id}`);
                
                // Call the core revocation logic
                await revokeSessionAndCleanup(payload);
            },
            {
                concurrency: SECURITY_WORKER_CONCURRENCY,
            }
        );

        securityLogoutWorker.on('error', (err) => logger.error("CRITICAL Security Worker Error:", err.message));
        workerResources = [securityLogoutWorker];
        
        // --- STEP 3: Confirmation ---
        logger.info(`\n======================================================`);
        logger.info(`| Security Worker Process Started. PID: ${process.pid}`);
        logger.info(`| Active Workers: Session Revocation/Cleanup`);
        logger.info(`======================================================\n`);
    } catch (err) {
        logger.error("❌ [FATAL] Security Worker process failed to start.", { error: err.message });
        await shutdown(true);
        process.exit(1); 
    }
}

// --- Graceful Shutdown Logic (Specific to this process) ---
async function shutdown(isFailure = false) {
    if (!isFailure) logger.info("Shutting down Security Worker process gracefully...");
    
    // Close workers/resources
    await Promise.all(workerResources.map(res => res.close()));
    
    // Close the global queue client connection
    await queueClient.close(); 
    
    logger.info("Security Worker shutdown complete.");
    if (!isFailure) process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
startSecurityWorkers();