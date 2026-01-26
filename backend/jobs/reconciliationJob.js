require("dotenv").config();
const mongoose = require("mongoose");
const Review = require("../model/Review");
const Product = require("../model/Product");
const connectDB = require("../config/connect"); // Assuming a common utility for DB connection
const config = require("../config");

/**
 * Periodically validates the rating aggregates on the Product collection 
 * against the source Review collection and fixes any discrepancies (data drift).
 * * This is the ultimate source of truth, performing a full recalculation.
 */
async function reconcileAggregates() {
    // 1. Establish connection
    await connectDB(config.MONGO_URI);
    console.log("Starting reconciliation job...");

    try {
        // Iterate over ALL products efficiently using a lean cursor
        // Select all aggregate fields to check for drift against the ground truth
        const cursor = Product.find().select("_id ratingSum ratingCount reviewsCount").lean().cursor();
        let processed = 0;
        let fixed = 0;

        for await (const doc of cursor) {
            const productId = doc._id;

            // 2. Re-calculate the ground truth from Review collection (ONLY PUBLISHED reviews)
            const stats = await Review.aggregate([
                { $match: { product: new mongoose.Types.ObjectId(productId), status: 'published' } },
                { $group: { _id: "$product", ratingSum: { $sum: "$rating" }, ratingCount: { $sum: 1 } } }
            ]);

            const s = stats[0] || { ratingSum: 0, ratingCount: 0 };
            
            // 3. Check for drift (using || 0 for robustness against missing fields on existing documents)
            const currentSum = doc.ratingSum || 0;
            const currentCount = doc.ratingCount || 0;
            const currentReviewsCount = doc.reviewsCount || 0;

            const isRatingSumMismatched = currentSum !== s.ratingSum;
            const isRatingCountMismatched = currentCount !== s.ratingCount;
            // CRITICAL: reviewsCount should always match ratingCount (since both track published reviews)
            const isReviewsCountMismatched = currentReviewsCount !== s.ratingCount;

            if (isRatingSumMismatched || isRatingCountMismatched || isReviewsCountMismatched) {
                const newRating = s.ratingCount > 0 
                    ? Math.round((s.ratingSum / s.ratingCount) * 100) / 100 // Round to 2 decimals
                    : 0;
                
                console.log(`[Drift Detected] Product: ${productId}`);
                console.log(`  Expected Sum/Count/ReviewsCount: ${s.ratingSum}/${s.ratingCount}/${s.ratingCount}`);
                console.log(`  Actual Sum/Count/ReviewsCount: ${currentSum}/${currentCount}/${currentReviewsCount}`);
                
                // 4. Fix the drift by overwriting with the ground truth
                await Product.findByIdAndUpdate(productId, {
                    ratingSum: s.ratingSum,
                    ratingCount: s.ratingCount,
                    rating: newRating,
                    reviewsCount: s.ratingCount // Fix all three counters
                }, { new: true, upsert: false });

                fixed++;
            }

            processed++;
            // Log progress for long-running jobs
            if (processed % 1000 === 0) {
                console.log(`Checked ${processed} products. ${fixed} fixes applied so far.`);
            }
        }
        
        console.log("--- Reconciliation Done ---");
        console.log(`Total Products Checked: ${processed}`);
        console.log(`Total Mismatches Fixed: ${fixed}`);
        
    } catch (err) {
        console.error("Reconciliation critical error:", err);
        throw err; // Propagate error for CRON job scheduling system to handle retries/alerts
    } finally {
        await mongoose.disconnect();
    }
}

// Execute the reconciliation job
reconcileAggregates()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("Job failed to run or exit gracefully.", err);
        process.exit(1);
    });