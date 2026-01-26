const { Queue } = require("bullmq");
require("dotenv").config();
const config = require("../config"); 

/**
 * Queue for processing product review aggregates asynchronously.
 * Queue Name: REVIEW_AGGREGATES_QUEUE
 */
const REVIEW_AGGREGATES_QUEUE = "review-aggregates";

// Redis connection configuration
const redisConnection = require("../redisConnection")

const reviewQueue = new Queue(REVIEW_AGGREGATES_QUEUE, {
    // BullMQ uses ioredis connection options
    connection: redisConnection,
    // Optional: Global default job options
    defaultJobOptions: {
        removeOnComplete: true, // Clean up successful jobs immediately
        removeOnFail: 1000,     // Keep 1000 failed jobs for debugging
    }
});

/**
 * Enqueues a job to update product aggregate statistics.
 * * CRITICAL OPTIMIZATION: Sets the jobId to the productId for automatic debouncing 
 * and deduplication. This prevents the queue from being flooded under high load.
 * * @param {object} payload - The job data.
 * @param {string} payload.productId - ID of the product being updated.
 * @param {number} payload.ratingDelta - The change in rating sum.
 * @param {number} payload.countDelta - The change in review count (+1, -1, or 0).
 * @param {boolean} [payload.recalc=false] - If true, triggers a full recomputation.
 */
async function enqueueAggregateJob(payload) {
    const { productId, recalc = false } = payload;
    
    // 1. Consistent Job Naming for Worker Filtering
    const jobName = recalc ? "full-recalculation" : "incremental-update"; 

    // 2. Production-ready retry and backoff strategy
    const jobOptions = {
        // ESSENTIAL FOR SCALABILITY: Use productId as jobId for debouncing.
        // If a job for this productId is already waiting, it will not be added again.
        // We let the worker handle the consolidated state.
        jobId: productId, 

        attempts: 5, // Increased attempts for high-scale resilience
        backoff: { 
            type: "exponential", 
            delay: 5000 // Start at 5s, 10s, 20s...
        },
    };

    // Edge case: If a full recalculation is requested, we MUST make the job unique 
    // to ensure it runs even if an incremental update job is already waiting.
    if (recalc) {
        jobOptions.jobId = `${productId}-recalc-${Date.now()}`;
    }

    await reviewQueue.add(jobName, payload, jobOptions);

    console.log(`Enqueued job '${jobName}' for Product ID: ${productId}`);
}

module.exports = { 
    reviewQueue, 
    enqueueAggregateJob, 
    REVIEW_AGGREGATES_QUEUE,
    redisConnection // Exporting for use in the worker definition
};