const { Queue, QueueScheduler, RepeatOptions } = require("bullmq");
const { redisConnection } = require("./eventBus"); // Re-use the Redis connection config

// Define a dedicated queue for scheduled, heavy batch jobs
const SCHEDULED_JOBS_QUEUE = "scheduled-batch-jobs"; 

// Instantiate the Queue and the Scheduler
const scheduledQueue = new Queue(SCHEDULED_JOBS_QUEUE, { connection: redisConnection });
const scheduler = new QueueScheduler(SCHEDULED_JOBS_QUEUE, { connection: redisConnection });

/**
 * Sets up the recurring job for co-purchase aggregation.
 */
async function setupScheduledJobs() {
    const jobName = "run-copurchase-aggregation";
    
    // Check if the job already exists to prevent duplication on restart
    const existingJobs = await scheduledQueue.getRepeatableJobs();
    const jobExists = existingJobs.some(job => job.name === jobName);

    if (jobExists) {
        console.log(`Scheduled job '${jobName}' already exists. Skipping add.`);
        return;
    }

    // Cron expression for running the job daily at 2:00 AM (0 2 * * *)
    const repeatOptions = {
        cron: "0 2 * * *", 
        // Best practice: Use a dedicated jobId for repeatable jobs
        jobId: jobName
    };

    await scheduledQueue.add(jobName, 
        { description: "Nightly co-purchase recommendation calculation" },
        { repeat: repeatOptions, attempts: 3 }
    );

    console.log(`Scheduled job '${jobName}' set to run daily at 2:00 AM.`);
}

// ----------------------------------------------------------------------
// Create a separate Worker to process jobs from the scheduled queue
// ----------------------------------------------------------------------
const aggregateCoPurchase = require("./jobs/coPurchaseAggregator");
const mongoose = require('mongoose');
const config = require("./config");

const scheduledWorker = new Worker(SCHEDULED_JOBS_QUEUE, async (job) => {
    if (job.name === "run-copurchase-aggregation") {
        await aggregateCoPurchase();
    }
}, { connection: redisConnection });


scheduledWorker.on('completed', (job) => {
    console.log(`Scheduled job ${job.id} completed successfully.`);
});

scheduledWorker.on('failed', (job, err) => {
    console.error(`Scheduled job ${job.id} failed: ${err.message}`);
    // This job will retry automatically based on setup attempts
});

// Initialize Mongoose connection
mongoose.connect(config.MONGO_URI);
setupScheduledJobs();

console.log(`BullMQ Scheduler started, managing queue: ${SCHEDULED_JOBS_QUEUE}`);