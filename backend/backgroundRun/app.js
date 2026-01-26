// app.js
/**
 * * ROLE: Main entry point for the Unified Background Services. 
 * * This process primarily hosts shared dependencies (DB/Redis) and the general-purpose Commission Worker.
 * * CRITICAL/SCHEDULING tasks run in a separate process (financial_worker_runner.js).
 */

// Load environment variables (e.g., MONGO_URI, Redis connections)
require('dotenv').config(); 

// --- Core Service Dependencies ---
const config = require("./config");
const connectDB = require("./config/connect");
const { connectRedis } = require("./lib/redisClient"); 

// --- BullMQ Components (Only necessary imports for this process) ---
const { allQueues } = require('./worker/scheduler'); // Import allQueues for logging only
const { startReferralCommissionWorker } = require('./queue/referralCommissionWorker'); 

// --- Legacy Background Jobs ---
// const { startCleanupJob } = require("./cron/cleanupJobs"); // REMOVED: Migrated to Scheduler
const aggregateCoPurchase = require("./jobs/aggregateCoPurchase");

const APP_NAME = "Unified Background Processing Service";

/**
 * Starts all non-queue-based, recurring background tasks (Legacy Cron/Intervals).
 */
async function startBackgroundJobs() {
    // 1. Start nightly co-purchase interval (Legacy interval)
    // NOTE: This should ideally be migrated to BullMQ for resilience.
    setInterval(aggregateCoPurchase, 24 * 60 * 60 * 1000); 
    console.log("✅ Nightly Co-Purchase job scheduler initialized (via setInterval).");
}


/**
 * Main function to connect dependencies and start all local Workers.
 */
async function startService() {
    try {
        // --- STEP 1: Connect Critical Dependencies ---
        await connectDB(config.MONGO_URI);
        console.log("✅ MongoDB connected.");
        
        await connectRedis(); 
        console.log("✅ Redis connected.");

        // --- STEP 2: Start Workers running in THIS process ---
        const commissionWorker = startReferralCommissionWorker(); 
        console.log("✅ Commission Worker initialized.");
        
        // --- STEP 3: Start Legacy Jobs ---
        await startBackgroundJobs();


        // --- STEP 4: Confirmation Console Output ---
        console.log(`\n======================================================`);
        console.log(`| ${APP_NAME} Started Successfully                      |`);
        console.log(`| (Financial Scheduler/Payout Workers run separately) |`); 
        console.log(`======================================================`);
        console.log(`| Service Status:                                    |`);
        console.log(`| - Commission Worker (BullMQ): Initialized          |`); 
        console.log(`| - BullMQ Scheduler: Running in dedicated process   |`);
        console.log(`| - Total Queues Managed: ${allQueues.length}                       |`);
        console.log(`| - Legacy Interval Job: Co-Purchase Aggregation     |`); 
        console.log(`======================================================\n`);
        
    } catch (err) {
        console.error("❌ [FATAL] Unified Service failed to start:", err.message || err);
        process.exit(1); 
    }
}


// --- GRACEFUL SHUTDOWN FOR THE MANAGER ---
async function managerShutdown() {
    console.log('\n[MANAGER] Main application received shutdown signal. Initiating graceful exit.');
    // NOTE: In a production environment, logic to close 'commissionWorker' should be added here.
    console.log('[MANAGER] Coordinator process exiting.');
    process.exit(0);
}

// Listen for termination signals
process.on('SIGTERM', managerShutdown);
process.on('SIGINT', managerShutdown); 


startService();