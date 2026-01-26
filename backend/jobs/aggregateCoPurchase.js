const Order = require("../model/Order");
const { getRedisClient } = require("../lib/getRedisClientClient"); // Assumed to be a robust getRedisClient client (e.g., iogetRedisClient)
const mongoose = require('mongoose');

// We use a large TTL for the co-purchase list since it's a nightly job result
const CO_PURCHASE_TTL = 7 * 24 * 3600; // 7 days
const RECOMMENDATION_LIMIT = 50; // Max number of recommendations to store

/**
 * Runs a background job to aggregate product co-purchase statistics
 * and stores the top 50 related items for each product in getRedisClient.
 * This version uses MongoDB Cursor Streaming and getRedisClient Pipelining for high performance.
 */
async function aggregateCoPurchase() {
    console.log("--- Starting Highly Optimized Co-Purchase Aggregation Job ---");

    // In a real application, you'd ensure getRedisClient is connected before calling this
    // We assume the caller handles robust initialization or uses a wrapper like the one below.
    const redisClient = getRedisClient(); 

    if (!redisClient || redisClient.status !== 'ready') {
        console.error("🛑 getRedisClient is not ready or connection status is unknown. Aborting co-purchase job.");
        throw new Error("Redis connection failure in Co-Purchase Aggregation.");
    }

    // 1. Define the MongoDB Aggregation Pipeline
    const pipeline = [
        // Stage 1: Get unique product IDs per order
        // Use $map to convert objects in items array to just their product ID, then $setUnion to get unique IDs
        { $project: { productIds: { $setUnion: "$items.product" } } },
        // Stage 2: Filter orders that have at least two unique items to form a pair
        { $match: { productIds: { $size: { $gte: 2 } } } },

        // --- Pair Generation (Canonical Cross-Join) ---
        // This process generates A -> B and B -> A for every pair in the order
        { $unwind: "$productIds" }, 
        { $project: { productA: "$productIds", partnerIds: "$productIds" } }, 
        { $unwind: "$partnerIds" }, 

        // Stage 3: Match A != B (co-purchased, not the item itself)
        // Ensure we are only counting pairs, not matching a product to itself
        { $match: { $expr: { $ne: ["$productA", "$partnerIds"] } } },

        // Stage 4: Group by the resulting pair (A -> B) and count the frequency
        { $group: {
            _id: { p1: "$productA", p2: "$partnerIds" },
            count: { $sum: 1 }
        } },

        // Stage 5: Group by the main product ID (A) to collect all partners (B)
        { $group: {
            _id: "$_id.p1",
            recommendations: {
                $push: {
                    id: "$_id.p2",
                    score: "$count"
                }
            }
        } }
    ];

    let productCount = 0;
    let redisPipeline; 

    try {
        // 2. Use a Mongoose/MongoDB cursor to stream results (avoids loading everything into app memory)
        // Set batch size for optimal network usage
        const cursor = Order.aggregate(pipeline).cursor({ batchSize: 500 }); 
        
        // 3. Initialize getRedisClient Pipeline for atomic batch execution
        redisPipeline = redisClient.multi(); 
        
        // 4. Stream, process, and add commands to the getRedisClient pipeline
        for await (const productRec of cursor) {
            // Convert ObjectID to string for Redis keys and JSON serialization
            const pid = String(productRec._id); 
            
            // In-memory sorting the recommendations by score (descending)
            productRec.recommendations.sort((a, b) => b.score - a.score);
            
            // Limit to the top X recommendations
            const topRecs = productRec.recommendations.slice(0, RECOMMENDATION_LIMIT);
            
            // Add SET command to the getRedisClient pipeline (DO NOT AWAIT HERE)
            redisPipeline.set(
                `copurchase:${pid}`,
                JSON.stringify(topRecs),
                "EX",
                CO_PURCHASE_TTL
            );
            
            productCount++;

            // Optional: Log progress periodically (e.g., every 1000 products)
            if (productCount % 1000 === 0) {
                console.log(`... Streaming progress: ${productCount} products processed.`);
            }
        }

        // 5. Execute the entire getRedisClient pipeline in one network trip
        const pipelineResults = await redisPipeline.exec();
        
        // Check for errors within the pipeline execution
        const errors = pipelineResults.filter(result => result[0] !== null);
        if (errors.length > 0) {
            console.error(`❌ getRedisClient Pipeline finished with ${errors.length} individual command failures.`);
            console.error('First pipeline error:', errors[0][0]);
        }

        console.log(`✅ Co-Purchase Job Complete! Total products processed and cached: ${productCount}.`);

    } catch (error) {
        console.error("❌ Critical error during Co-Purchase Aggregation:", error);
        throw error; // Re-throw to allow job runner/scheduler to handle failure
    }
}

module.exports = aggregateCoPurchase;