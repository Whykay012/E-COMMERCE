// BullMQ requires modules to be installed separately, but we use the provided globals.
const { Worker } = require('bullmq');
// Import the Firestore functions needed for initialization
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";


// --- Payout Processing Logic Import ---
// NOTE: Ensure './payoutProcessor' is a separate file exporting an async function(job)
const { payoutProcessor } = require('./payoutProcessor'); 

// --- Configuration and Global Variables ---
const PAYOUT_QUEUE_NAME = 'Payouts';
const MAX_CONCURRENCY = 5; 
// Assume this file provides the Redis connection options for BullMQ
const bullMqConnection = require("../lib/redisBullMQClient"); 

// CRITICAL Firebase Initialization
const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
if (!firebaseConfig.apiKey) {
    console.error("FATAL: __firebase_config is missing. Worker cannot run without database access.");
    process.exit(1);
}

const app = initializeApp(firebaseConfig);
// Make the DB instance available globally for the processor to use (as __firestore_db)
const firestoreDb = getFirestore(app);
globalThis.__firestore_db = firestoreDb; 
globalThis.__app_id = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';


let workerInstance = null;

/**
 * Initializes and starts the BullMQ Worker instance.
 */
const startWorker = () => {
    if (workerInstance) {
        console.warn("Worker is already running.");
        return;
    }

    console.log(`Starting BullMQ Worker for queue: ${PAYOUT_QUEUE_NAME}...`);

    // 2. BullMQ Worker Setup
    workerInstance = new Worker(PAYOUT_QUEUE_NAME, payoutProcessor, { 
        connection: bullMqConnection,
        concurrency: MAX_CONCURRENCY,
        defaultJobOptions: {
            attempts: 5, // 5 attempts per job
            backoff: {
                type: 'exponential',
                delay: 1000, 
            },
            removeOnComplete: true,
            removeOnFail: false 
        },
    });

    workerInstance.on('completed', (job) => {
        console.log(`Job ${job.id} of type ${job.name} completed successfully. Result:`, job.returnvalue);
    });

    workerInstance.on('failed', (job, err) => {
        const attemptsMade = job.attemptsMade || 1;
        const maxAttempts = job.opts.attempts || 1;
         
        // Log status based on retry possibility
        if (attemptsMade < maxAttempts) {
            console.error(`Job ${job.id} failed (Attempt ${attemptsMade} of ${maxAttempts}). Will retry. Error:`, err.message);
        } else {
            console.error(`Job ${job.id} failed permanently after ${maxAttempts} attempts. Error:`, err.message);
        }
    });

    workerInstance.on('error', (err) => {
        // This handles connection errors or errors outside of job processing
        console.error('Worker error:', err.message);
    });

    console.log(`Worker running with concurrency: ${MAX_CONCURRENCY}`);
};


/**
 * Worker Lifecycle Management: Gracefully shuts down the BullMQ worker.
 */
const shutdownWorker = async () => {
    if (workerInstance) {
        console.log("\n[Worker] Shutting down BullMQ worker gracefully...");
        await workerInstance.close(); 
        workerInstance = null;
        console.log("[Worker] BullMQ worker shut down. Process ready to exit.");
    }
};

/**
 * Handles process termination signals (SIGTERM/SIGINT) for the worker process.
 */
const handleWorkerShutdown = async (signal) => {
    console.log(`\n[Worker] Received signal: ${signal}. Initiating shutdown...`);
    
    try {
        await shutdownWorker(); 
        
        console.log('[Worker] Graceful exit complete.');
        process.exit(0); // Exit cleanly
    } catch (error) {
        console.error('[Worker] Error during shutdown:', error.message);
        process.exit(1); // Exit with error code
    }
};

// --- Execution and Signal Setup ---

// 1. Start the worker immediately upon execution
startWorker();

// 2. Attach handlers to OS Signals
process.on('SIGINT', () => handleWorkerShutdown('SIGINT')); // Ctrl+C
process.on('SIGTERM', () => handleWorkerShutdown('SIGTERM')); // Process manager signal

console.log("Payout Worker initialized and listening for jobs and termination signals.");