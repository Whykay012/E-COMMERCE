// --- reviewAggregatorWorker.js ---
// BullMQ worker that processes review aggregation jobs, ensuring atomic updates.

require("dotenv").config(); // Ensure env variables are loaded

const { Worker } = require("bullmq");
const mongoose = require("mongoose");
// Assuming standard model paths
const Product = require("../model/product"); 
const Review = require("../model/Review"); 
const connectDB = require("../config/connect"); 
const config = require("../config");

// Assuming the connection details and queue name are in a shared configuration/service file
const { REVIEW_AGGREGATES_QUEUE, redisConnection } = require("../jobs/queueProducerService"); 

/**
* Executes a full recalculation of a product's aggregate statistics by querying 
* the ground truth (all published reviews) in the database.
* This is used for reconciliation and fixing data drift.
* @param {object} job BullMQ job object
*/
async function handleFullRecalculation(job) {
  const { productId } = job.data;
  const productObjectId = new mongoose.Types.ObjectId(productId);

  console.log(`[Job ${job.id}] Running FULL RECALCULATION for Product ID: ${productId}`);

  // 1. Query the ground truth using MongoDB Aggregation
  const stats = await Review.aggregate([
    // Only count published/approved reviews (using 'published' as per original)
    { $match: { product: productObjectId, status: 'published' } }, 
    { $group: { 
      _id: "$product", 
      ratingSum: { $sum: "$rating" }, 
      ratingCount: { $sum: 1 } 
    } }
  ]);

  const s = stats[0] || { ratingSum: 0, ratingCount: 0 };
  const totalCount = s.ratingCount;
  // Calculate average, rounding to two decimal places
  const newRating = totalCount > 0 ? (s.ratingSum / totalCount) : 0;
  const roundedRating = Math.round(newRating * 100) / 100;
  
  // 2. Update product aggregates to match the ground truth
  await Product.findByIdAndUpdate(productId, {
    ratingSum: s.ratingSum,
    ratingCount: totalCount, 
    rating: roundedRating, // 'rating' field stores the average
    reviewsCount: totalCount, // Total reviews (of status 'published')
  }, { new: true, upsert: false });

  console.log(`[Job ${job.id}] Full recalculation complete. New Avg: ${roundedRating.toFixed(2)}`);
}

/**
* Executes an atomic incremental update of a product's aggregate statistics.
* Uses a MongoDB aggregation pipeline for a single, atomic update operation,
* guaranteeing data integrity for derived fields like 'rating'.
* @param {object} job BullMQ job object
*/
async function handleIncrementalUpdate(job) {
  const { productId, ratingDelta = 0, countDelta = 0 } = job.data; 

  if (countDelta === 0 && ratingDelta === 0) {
    console.log(`[Job ${job.id}] Skipping incremental update for ${productId}. Deltas are zero.`);
    return;
  }

  // Aggregation Pipeline for atomic update of derived field (rating)
  const updatePipeline = [
    // 1. Atomically update the base fields ($ratingSum, $ratingCount, $reviewsCount)
    { 
      $set: {
        ratingSum: { $add: [{ $ifNull: ["$ratingSum", 0] }, ratingDelta] },
        ratingCount: { $add: [{ $ifNull: ["$ratingCount", 0] }, countDelta] },
        reviewsCount: { $add: [{ $ifNull: ["$reviewsCount", 0] }, countDelta] },
      } 
    },
    // 2. Recalculate the derived field (rating) based on the new values
    { 
      $set: {
        rating: {
          $cond: {
            // Protect against division by zero 
            if: { $gt: ["$ratingCount", 0] }, 
            // Use $round inside Mongo for atomicity, rounding to 2 decimals
            then: { $round: [{ $divide: ["$ratingSum", "$ratingCount"] }, 2] }, 
            else: 0
          }
        }
      } 
    }
  ];
  
  // Perform the atomic update using the pipeline
  const result = await Product.findByIdAndUpdate(
    productId, 
    updatePipeline,
    { new: true, upsert: false }
  );

  if (!result) {
    // This could happen if the product was deleted after the job was enqueued
    console.warn(`[Job ${job.id}] Product ${productId} not found during delta update. Skipping aggregation.`);
  } else {
    console.log(`[Job ${job.id}] Incremental update for Product ${productId} complete. New Avg: ${result.rating.toFixed(2)}`);
  }
}


// --- BullMQ Worker Definition ---
const worker = new Worker(REVIEW_AGGREGATES_QUEUE, async (job) => {
  // 1. Ensure DB connection is active for this job
  await connectDB(config.MONGO_URI);

  try {
    if (job.name === 'full-recalculation') {
      await handleFullRecalculation(job);
    } else if (job.name === 'incremental-update') {
      await handleIncrementalUpdate(job);
    } else {
      console.warn(`[Job ${job.id}] Unknown job type: ${job.name}. Discarding.`);
    }
  } catch (error) {
    // IMPORTANT: Throw the error so BullMQ knows to retry the job
    console.error(`[Job ${job.id}] Failed to process job for product ${job.data.productId}:`, error.message);
    throw error;
  }

}, {
  connection: redisConnection,
  concurrency: 8, // High concurrency is safe due to atomic MongoDB updates
});

// --- Worker Lifecycle & Error Logging ---
worker.on("completed", (job) => {
  console.log(`Bull job ${job.id} completed successfully for Product ID: ${job.data.productId}`);
});

worker.on("failed", (job, err) => {
  console.error(`Bull job ${job.id} failed after all retries. Attempts: ${job.attemptsMade}. Error:`, err.message);
});

worker.on("error", (err) => {
  console.error("BullMQ Worker Unhandled Error:", err);
});

// Initial connection check on startup
connectDB(config.MONGO_URI).then(() => {
  console.log(`BullMQ Worker started, listening on queue: ${REVIEW_AGGREGATES_QUEUE}`);
}).catch(err => {
  console.error("Worker failed to connect to DB at startup:", err);
  process.exit(1); 
});

module.exports = worker;