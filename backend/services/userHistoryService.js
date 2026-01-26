// services/userHistoryService.js (TITAN NEXUS - SWR Caching & Metrics)
const mongoose = require("mongoose");
const UserProductHistory = require("../model/UserProductHistory"); 
const logger = require("../config/logger");
const CacheService = require("./cacheService"); 
const { performance } = require('perf_hooks'); // Node.js native for high-res timing

// --- Configuration ---
const MAX_HISTORY_SIZE = 100; 
const HISTORY_WINDOW_DAYS = 7; 
const HISTORY_WINDOW_MS = HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000; 
const HISTORY_CACHE_TTL_SECONDS = 3600; // Cache TTL: 1 hour
const HISTORY_CACHE_STALE_SECONDS = 600; // Stale window: 10 minutes (for background revalidation)
const HISTORY_CACHE_KEY = (userId) => `userhistory:${userId}`;

/**
 * @desc Manages the storage and retrieval of a user's product viewing/showing history 
 * to enable personalization and freshness filters using optimized MongoDB aggregation.
 */
class UserHistoryService {

    /**
     * @desc Private utility to perform the actual database fetch and aggregation.
     * @param {string} userId - The ID of the logged-in user.
     * @returns {Promise<mongoose.Types.ObjectId[]>} Array of recent product IDs.
     */
    static async #fetchRecentProductIdsFromDB(userId) {
        const userIdObjectId = new mongoose.Types.ObjectId(userId);
        const cutoffDate = new Date(Date.now() - HISTORY_WINDOW_MS);
        const traceId = logger.getTraceId();
        const start = performance.now();

        try {
            const pipeline = [
                { $match: { userId: userIdObjectId } },
                { $unwind: "$recentProductIds" },
                { 
                    $match: { 
                        "recentProductIds.shownAt": { $gte: cutoffDate } 
                    } 
                },
                { $group: { _id: "$_id", recentIds: { $push: "$recentProductIds.productId" } } },
                { $project: { _id: 0, recentIds: 1 } }
            ];

            const result = await UserProductHistory.aggregate(pipeline).read('secondaryPreferred'); // Read preference for performance
            const recentIds = result.length > 0 ? result[0].recentIds : [];
            const duration = (performance.now() - start).toFixed(2);
            
            logger.debug(`[${traceId}] DB Read Success. IDs: ${recentIds.length}, Latency: ${duration}ms.`, { userId });
            return recentIds;

        } catch (error) {
            logger.error(`[${traceId}] CRITICAL: MongoDB Aggregation failed for user ${userId}: ${error.message}. Returning empty array.`, { duration: (performance.now() - start).toFixed(2) });
            // Enterprise Grade Fallback: Must return expected type, even on failure.
            return []; 
        }
    }

    /**
     * @desc Retrieves a list of recently shown product IDs, using SWR cache for speed.
     * @param {string | null} userId - The ID of the logged-in user or null for anonymous.
     * @returns {Promise<mongoose.Types.ObjectId[]>} Array of recent product IDs.
     */
    static async getRecentProductIds(userId) {
        if (!userId || userId === 'system' || !mongoose.Types.ObjectId.isValid(userId)) {
            return [];
        }

        const cacheKey = HISTORY_CACHE_KEY(userId);

        // SWR Cache check
        const cachedResult = await CacheService.getWithStale(cacheKey);

        if (cachedResult.data) {
            logger.debug(`Cache HIT for user history ${userId}. Stale: ${cachedResult.stale ? 'Yes' : 'No'}`);
            // Metrics: track cache hit/stale status
            // Metrics.increment('user_history_cache', { status: cachedResult.stale ? 'stale_hit' : 'fresh_hit' });
            
            const recentIds = JSON.parse(cachedResult.data); 

            if (cachedResult.stale) {
                // Use setTimeout for background task separation (non-blocking)
                setTimeout(() => {
                    this.#revalidateCache(userId, cacheKey).catch(e => {
                        logger.error(`Background SWR revalidation failed for user history ${userId}: ${e.message}`);
                    });
                }, 0).unref(); // Ensure it doesn't keep the process alive
            }
            // Map strings back to ObjectIds for use in the application layer
            return recentIds.map(id => new mongoose.Types.ObjectId(id));
        }

        // Cache MISS - Fetch data, set cache, and return
        logger.debug(`Cache MISS for user history ${userId}. Fetching from DB.`);
        // Metrics.increment('user_history_cache', { status: 'miss' });
        return this.#revalidateCache(userId, cacheKey);
    }

    /**
     * @private
     * @desc Fetches data from the database and sets it into the SWR cache.
     * @returns {Promise<mongoose.Types.ObjectId[]>} The fetched product IDs.
     */
    static async #revalidateCache(userId, cacheKey) {
        // The fetch method handles its own error and returns [] on failure
        const recentIds = await this.#fetchRecentProductIdsFromDB(userId);
        
        if (recentIds.length > 0) {
            const idsAsStrings = recentIds.map(id => id.toString()); 

            // Use a try/catch around the set operation for cache resilience
            try {
                await CacheService.setWithStale(
                    cacheKey, 
                    JSON.stringify(idsAsStrings), 
                    HISTORY_CACHE_TTL_SECONDS, 
                    HISTORY_CACHE_STALE_SECONDS
                );
            } catch (cacheError) {
                logger.warn(`Failed to set SWR cache for user ${userId}: ${cacheError.message}`);
            }
        }
        return recentIds;
    }

    /**
     * @desc Logs the products shown to the user, using $pull and $push for atomic de-duplication.
     */
    static async logProductsShown(userId, productIds) {
        if (!userId || userId === 'system' || productIds.length === 0 || !mongoose.Types.ObjectId.isValid(userId)) {
            return;
        }

        // --- Input Validation and Transformation ---
        const userIdObjectId = new mongoose.Types.ObjectId(userId);
        const validProductIds = productIds.filter(id => mongoose.Types.ObjectId.isValid(id));
        if (validProductIds.length === 0) return;
        
        const productObjectIds = validProductIds.map(id => new mongoose.Types.ObjectId(id));
        const newHistoryItems = productObjectIds.map(id => ({
            productId: id,
            shownAt: new Date(),
        }));

        try {
            // Use a transaction/bulk write in a real high-throughput system, but for simplicity, keep the two-step atomic update.
            const start = performance.now();

            // 1. ATOMIC DE-DUPLICATION (using $pull)
            await UserProductHistory.updateOne(
                { userId: userIdObjectId },
                {
                    $pull: { recentProductIds: { productId: { $in: productObjectIds } } },
                }
            );

            // 2. ATOMIC $PUSH (with $slice)
            await UserProductHistory.findOneAndUpdate(
                { userId: userIdObjectId },
                {
                    $push: { 
                        recentProductIds: { 
                            $each: newHistoryItems,
                            $slice: -MAX_HISTORY_SIZE, 
                        }
                    },
                    $set: { updatedAt: new Date() }
                },
                { 
                    upsert: true, 
                    new: true,
                    writeConcern: { w: 'majority', wtimeout: 5000 } // Enforce strong write concern
                }
            );
            
            const duration = (performance.now() - start).toFixed(2);
            logger.debug(`DB Write Success. History updated in ${duration}ms.`, { userId, productsLogged: validProductIds.length });

            // Cache Invalidation (MUST happen after the write completes)
            await CacheService.del(HISTORY_CACHE_KEY(userId));

        } catch (error) {
            logger.error(`CRITICAL: History log failed for user ${userId}: ${error.message}`);
            // Metrics.increment('user_history_write_failures');
        }
    }
}

module.exports = UserHistoryService;