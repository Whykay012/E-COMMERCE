require("dotenv").config();
const mongoose = require("mongoose");
const Review = require("../model/Review");
const Product = require("../model/product");
const connectDB = require("../config/connect"); // Assuming a common utility for DB connection
const config = require("../config");

/**
 * Computes and updates the rating aggregates for ALL products based on existing reviews 
 * using a single, highly efficient MongoDB aggregation pipeline with $merge.
 */
async function backfillAggregates() {
    await connectDB(config.MONGO_URI);
    console.log("Connected. Starting highly optimized backfill job...");

    try {
        // --- 1. Efficiently Update Products THAT HAVE Published Reviews (using $merge) ---
        
        console.log("Phase 1: Calculating and merging aggregates for products with reviews...");
        
        const pipeline = [
            // Only consider reviews that are currently published/approved
            { $match: { status: 'published' } }, 
            
            // Group by product ID and calculate the ground truth
            { 
                $group: { 
                    _id: "$product", 
                    ratingSum: { $sum: "$rating" }, 
                    ratingCount: { $sum: 1 } 
                } 
            },
            
            // Calculate the derived fields (average rating and reviewsCount)
            {
                $addFields: {
                    rating: {
                        $round: [
                            { $divide: ["$ratingSum", "$ratingCount"] }, // Calculate average
                            2 // Round to 2 decimal places
                        ]
                    },
                    reviewsCount: "$ratingCount" // reviewsCount must equal ratingCount
                }
            },
            
            // CRITICAL: Use $merge to atomically update the Product collection
            // The document is matched by _id (which is set to $product during $group)
            {
                $merge: {
                    into: Product.collection.name, // Target collection
                    on: "_id", // Match on Product ID
                    whenMatched: "merge", // Update existing document fields
                    whenNotMatched: "discard" // Skip if product doesn't exist (or was deleted)
                }
            }
        ];

        // Execute the entire pipeline on the Review collection
        const mergeResult = await Review.aggregate(pipeline).exec();

        // --- 2. Clean Up Products WITHOUT Published Reviews ---
        
        // This handles cases where:
        // a) A product never had reviews.
        // b) All reviews for a product were deleted or unpublished.
        
        console.log("Phase 2: Resetting aggregates for products with zero published reviews...");
        
        const resetResult = await Product.updateMany(
            // Target products that currently have non-zero counts (meaning they were skipped by $merge)
            // or products where the fields are missing (for initial backfill).
            { 
                $or: [
                    { ratingCount: { $gt: 0 } }, 
                    { ratingCount: { $exists: false } } 
                ]
            },
            {
                $set: {
                    ratingSum: 0,
                    ratingCount: 0,
                    rating: 0,
                    reviewsCount: 0
                }
            }
        );
        
        // Final Logging
        console.log("--- Backfill Complete ---");
        console.log(`Phase 1 Merge Status: Review pipeline completed.`); // $merge doesn't return count easily, but we know it ran.
        console.log(`Phase 2 Reset Count: ${resetResult.modifiedCount} products reset to zero aggregates.`);
        
        process.exit(0);
    } catch (err) {
        console.error("Backfill critical error:", err);
        // Throwing error ensures CRON system knows the job failed
        process.exit(1); 
    } finally {
        await mongoose.disconnect();
    }
}

backfillAggregates();