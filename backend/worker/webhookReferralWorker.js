/**
 * worker/webhookProcessor.js
 * * This file defines and starts the BullMQ Worker process for handling
 * referral webhooks. This worker should run as a separate, long-lived process 
 * from the main e-commerce application server.
 * * Best Practices:
 * 1. Dedicated process for consuming background jobs.
 * 2. Uses the smart error handling from webhookQueueManager.js.
 * 3. Configuration for concurrency and graceful shutdown.
 */
const { Worker } = require("bullmq");
const { connection } = require("../utils/queue"); 
const { sendWebhook, NonRetryableError } = require("../utils/webhookReferralSender");

// --- Worker Configuration ---

// Concurrency: How many jobs this single worker process can handle simultaneously.
// For I/O heavy tasks like webhooks, a higher number is often acceptable (e.g., 5-20).
const CONCURRENCY = parseInt(process.env.WEBHOOK_WORKER_CONCURRENCY || "10", 10);

// Queue Name: Must match the name used in utils/queue.js
const QUEUE_NAME = "referral:webhook"; 

/**
 * The main job processing function for the 'send-webhook' job type.
 * @param {object} job - The BullMQ Job object containing job data.
 */
async function processWebhookJob(job) {
    const { keyId, url } = job.data;
    const attempt = job.attemptsMade + 1;

    console.log(`[Worker][${keyId}] Starting job: ${job.id}. Attempt: ${attempt}`);

    try {
        // Call the core sending function (which handles internal p-retry logic)
        const response = await sendWebhook(job.data);
        
        console.log(`[Worker][${keyId}] Job ${job.id} completed successfully. External response received.`);
        return response; // Result stored in completed job data
        
    } catch (error) {
        // Handle failure: BullMQ will automatically retry if the job fails (up to defaultJobOptions.attempts)
        
        const errorMessage = error.message || "Unknown worker error.";
        
        if (error instanceof NonRetryableError) {
            // Log permanent failure and re-throw to allow BullMQ to mark it as failed (Non-Retryable)
            console.error(`[Worker][${keyId}] PERMANENT FAILURE for job ${job.id}: ${errorMessage}. Stopping retries.`);
            // When a worker throws an error, BullMQ retries based on the queue's configuration.
            // By throwing a specific error here, we signal to BullMQ why the job failed permanently.
            // Since NonRetryableError signals the internal p-retry to stop,
            // this worker failure will be the final attempt if BullMQ is configured for 1 attempt.
            // To ensure the job is fully marked as failed, we re-throw.
            throw error; 
        }

        // For all other errors (transient network issues, 5xx codes), let BullMQ retry.
        console.warn(`[Worker][${keyId}] TRANSIENT FAILURE for job ${job.id}: ${errorMessage}. BullMQ will retry.`);
        throw error;
    }
}

// --- Worker Instantiation and Event Handling ---

const webhookWorker = new Worker(
    QUEUE_NAME, 
    processWebhookJob, 
    { 
        connection, 
        concurrency: CONCURRENCY 
    }
);

webhookWorker.on('ready', () => {
    console.log(`[Worker] Webhook worker is READY. Listening for jobs on ${QUEUE_NAME} with concurrency: ${CONCURRENCY}.`);
});

webhookWorker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} finished.`);
});

webhookWorker.on('failed', (job, err) => {
    // This logs the final failure after all retry attempts by BullMQ have been exhausted.
    const message = err.message || 'Worker final failure.';
    console.error(`[Worker] FINAL FAILURE for Job ${job.id} after all attempts: ${message}`);
    // Here you would typically send an alert (e.g., to Sentry, PagerDuty).
});

webhookWorker.on('error', (err) => {
    console.error(`[Worker] UNEXPECTED Worker error: ${err.message}`);
});

// --- Graceful Shutdown ---
async function shutdown() {
    console.log('[Worker] Shutting down worker...');
    await webhookWorker.close();
    await connection.quit();
    console.log('[Worker] Worker shutdown complete.');
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[Worker] Starting up BullMQ Webhook Processor...');

// Export the worker instance for potential management in a parent process (optional)
module.exports = { 
    webhookWorker,
    QUEUE_NAME 
};