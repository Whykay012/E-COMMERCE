const Product = require('../model/Product');
// Assume a robust caching wrapper that handles cache-miss computation and stale data serving
const cached = require('../services/cacheWrapper'); 
const {getRedisClient} = require('../lib/redisClient');
const mongoose = require('mongoose');

// Cache TTLs in seconds
const FOR_YOU_TTL = 5 * 60; // 5 minutes cache for the user-specific 'For You' list
const ALSO_BOUGHT_TTL = 60 * 60; // 1 hour cache for the product-level 'Also Bought' list

/**
 * CORE: Simple Baseline Recommendation Algorithm ("For You")
 * Ranks products based on a simple score: Recent Popularity + High Rating.
 * This function is designed to be fast and should only hit MongoDB.
 * * @param {string} userId - The user ID (currently used for logging/future personalization).
 * @param {number} limit - Max number of recommendations to return.
 * @returns {Promise<Array<Object>>} List of recommended products.
 */
async function forYouRecommendations(userId, limit = 8) {
    try {
        // In a scaled system, true personalization would be loaded from a pre-calculated cache
        // (e.g., 'recs:user:1234:content') to maintain high speed.
        
        // Use a simple, scalable baseline: highly-rated, recently purchased, and available products.
        const products = await Product.find({ 
            isAvailable: true,
            // Optimization: Filter out already purchased items if user history is easily accessible
            // _id: { $nin: user.recentPurchasedIds } 
        })
        .sort({ rating: -1, purchaseCount: -1, createdAt: -1 }) // Sort by quality and recency
        .limit(limit)
        .select('name price rating categories') // Select only necessary fields for API response
        .lean();

        console.log(`[Recs] Generated ${products.length} baseline 'For You' recommendations for user ${userId}.`);
        return products;
    } catch (error) {
        console.error("Error generating 'For You' baseline recommendations:", error);
        // Fail gracefully to an empty array if the database is struggling
        return [];
    }
}

/**
 * CORE: Item-Based Collaborative Filtering (CF) for "Customers also bought"
 * Fetches pre-calculated similar items from Redis and retrieves product details from MongoDB.
 * * @param {string} productId - The ID of the current product being viewed.
 * @param {number} limit - Max number of recommendations to return.
 * @returns {Promise<Array<Object>>} List of recommended products, sorted by co-purchase score.
 */
async function getAlsoBought(productId, limit = 8) {
    const cfKey = `copurchase:${productId}`;
    
    // Check Redis health early, as CF data is mission-critical for this type of recommendation
    if (!getRedisClient || getRedisClient.status !== 'ready') {
        console.warn("Redis is not available. Falling back to a popularity list.");
        // --- BEST PRACTICE: FALLBACK ---
        // If the core CF data store is down, serve a simple, fast popularity list
        return Product.find({ _id: { $ne: productId }, isAvailable: true })
            .sort({ purchaseCount: -1 })
            .limit(limit)
            .select('name price rating categories')
            .lean();
    }

    try {
        const cachedCoPurchase = await getRedisClient.get(cfKey);
        
        if (!cachedCoPurchase) {
            console.log(`[CF Miss] No co-purchase data for product ${productId}. Serving popularity fallback.`);
            // --- BEST PRACTICE: FALLBACK ON MISS ---
            // If the key is missing (e.g., product is new, job hasn't run), serve a popularity list
            return Product.find({ _id: { $ne: productId }, isAvailable: true })
                .sort({ purchaseCount: -1 })
                .limit(limit)
                .select('name price rating categories')
                .lean();
        }

        const coPurchaseList = JSON.parse(cachedCoPurchase); // [{ id: 'pid', score: 10 }, ...]
        
        // Get slightly more IDs than needed to account for unavailable products
        const productIds = coPurchaseList.slice(0, limit * 2).map(item => item.id); 

        // 1. Fetch product details from MongoDB for the recommended IDs
        const recommendedProducts = await Product.find({
            _id: { $in: productIds, $ne: productId },
            isAvailable: true 
        })
        .select('name price rating categories')
        .lean();

        // 2. Map fetched products for quick lookup
        const idToProductMap = recommendedProducts.reduce((map, product) => {
            map[product._id.toString()] = product;
            return map;
        }, {});

        // 3. --- BEST PRACTICE: EXPLICIT RE-SORTING ---
        // Iterate through the original, score-sorted list from Redis and push the corresponding
        // product object, ensuring the final list order matches the CF score.
        const sortedRecs = [];
        for (const item of coPurchaseList) {
            const product = idToProductMap[item.id];
            if (product) {
                sortedRecs.push(product);
            }
            if (sortedRecs.length >= limit) break; // Stop when the limit is reached
        }

        console.log(`[CF Hit] Found ${sortedRecs.length} 'Also Bought' recommendations for ${productId}.`);
        return sortedRecs;

    } catch (error) {
        console.error(`Error processing 'Also Bought' for ${productId}:`, error.message);
        return [];
    }
}


// --- CACHED PUBLIC API FUNCTIONS (External Request-Level Cache Layer) ---

/**
 * Public API: Get personalized recommendations with robust request-level caching.
 */
async function getCachedForYou(userId, limit = 8) {
    // Versioning the key (v1) is crucial for A/B testing and model updates
    const key = `recs:user:${userId}:forYou:v1`; 
    
    // Use the cache wrapper with the defined TTL
    return cached(key, FOR_YOU_TTL, () => forYouRecommendations(userId, limit));
}

/**
 * Public API: Get Item-based recommendations with request-level caching.
 */
async function getCachedAlsoBought(productId, limit = 8) {
    // This adds a short request-level cache on top of the long-running CF job cache.
    const key = `recs:product:${productId}:alsoBought:v1`;
    return cached(key, ALSO_BOUGHT_TTL, () => getAlsoBought(productId, limit));
}


module.exports = {
    getCachedForYou,
    getCachedAlsoBought,
    // Export core functions for job processing/testing purposes
    forYouRecommendations,
    getAlsoBought
};