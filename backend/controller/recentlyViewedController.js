const { StatusCodes } = require("http-status-codes");
const mongoose = require("mongoose");
const RecentlyViewed = require("../model/recentlyViewed"); 
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const { logActivity, getActivitiesByUser } = require("../utils/activityLogger"); 
const yup = require("yup");
const AuditLogger = require("../services/auditLogger"); 
const { getRedisClient } = require("../event/lib/redisClient"); 

// Import the new product data service (which contains L1/L2/Redlock logic)
const { getProductDetailsByIds } = require("../services/productDataService"); 

// --- CONSTANTS & UTILITIES ---
const MAX_RECENTLY_VIEWED_LIMIT = 50; 
const DEFAULT_LIST_LIMIT = 10;
const REDIS_KEY_PREFIX = 'rv:user:';
const REDIS_TTL_SECONDS = 3600 * 24 * 7; // 7 days TTL
const READ_PREFERENCE_POLICY = 'secondaryPreferred'; 
const REDIS_PRODUCT_KEY_PREFIX = 'prod:'; // Constant from productDataService for consistency


/**
 * @desc Utility to run an async function in the background, decoupled from the response.
 * @param {Function} asyncFn - The async function to execute.
 * @param {string} eventName - Audit event name for logging failure.
 */
const fireAndForget = (asyncFn, eventName) => {
    process.nextTick(() => {
        asyncFn().catch(err => AuditLogger.log({
            level: AuditLogger.LEVELS.CRITICAL,
            event: `${eventName}_FAILED`,
            details: { error: err.message, stack: err.stack }
        }));
    });
};

// -------------------- VALIDATION --------------------
const addViewedSchema = yup.object().shape({
    productId: yup
        .string()
        .required("productId is required")
        .test('is-mongo-id', 'Invalid productId format', val => mongoose.Types.ObjectId.isValid(val)),
});

// --------------------------------------------------------------------------------------------------
// CORE FUNCTION 1: ADD RECENTLY VIEWED (ZENITH 6.0 WRITE-THROUGH)
// --------------------------------------------------------------------------------------------------
const addRecentlyViewed = async (req, res, next) => {
    try {
        const { productId } = await addViewedSchema.validate(req.body, { abortEarly: false });
        const userId = req.user.userID;
        const productIdObjectId = new mongoose.Types.ObjectId(productId);
        const redisKey = `${REDIS_KEY_PREFIX}${userId}`;
        const nowScore = Date.now(); 

        const redisClient = getRedisClient();

        // 1. Write-Through to Redis (Primary Update Path)
        // ZADD ensures product is added/score updated (moving it to the top)
        await redisClient.zAdd(redisKey, [{ score: nowScore, value: productId }]);
        // Remove oldest items to respect the limit
        await redisClient.zRemRangeByRank(redisKey, 0, -(MAX_RECENTLY_VIEWED_LIMIT + 1)); 
        // Ensure TTL is refreshed
        await redisClient.expire(redisKey, REDIS_TTL_SECONDS); 

        // 2. Decoupled Persistor (Non-Blocking MongoDB Write and Activity Log)
        fireAndForget(async () => {
            await RecentlyViewed.updateOne(
                { user: userId },
                [ // Ultimate atomic deduplication pipeline
                    // Remove existing product reference
                    { $set: { views: { $filter: { input: "$views", as: "v", cond: { $ne: ["$$v.product", productIdObjectId] } } } } },
                    // Prepend new/updated product reference
                    { $set: { views: { $concatArrays: [[{ product: productIdObjectId, updatedAt: new Date() }], "$views"] } } },
                    // Slice to enforce the max limit
                    { $set: { views: { $slice: ["$views", MAX_RECENTLY_VIEWED_LIMIT] } } }
                ],
                { upsert: true, writeConcern: { w: 1 } }
            );
            
            // Log the individual event
            logActivity({ user: userId, type: "RECENTLY_VIEWED", description: "Viewed product", meta: { productId }, ipAddress: req.ip });
        }, 'DECOUPLED_MONGO_PERSIST');

        res.status(StatusCodes.OK).json({ message: "Recent view recorded in cache and queued for persistence." });

    } catch (err) {
        if (err instanceof yup.ValidationError) {
            return next(new BadRequestError(err.errors.join(", ")));
        }
        AuditLogger.log({ level: AuditLogger.LEVELS.CRITICAL, event: 'ADD_VIEWED_FAILURE', userId: req.user.userID, details: { error: err.message } });
        next(err); 
    }
};

// --------------------------------------------------------------------------------------------------
// CORE FUNCTION 2: LIST RECENTLY VIEWED (CACHE-AS-PRIMARY + FALLBACK)
// --------------------------------------------------------------------------------------------------
const listRecentlyViewed = async (req, res, next) => {
    const userId = req.user.userID;
    const redisKey = `${REDIS_KEY_PREFIX}${userId}`;
    let limit = parseInt(req.query.limit) || DEFAULT_LIST_LIMIT;
    limit = Math.min(limit, MAX_RECENTLY_VIEWED_LIMIT); 

    try {
        const redisClient = getRedisClient();
        // 1. Fetch Product IDs from Redis ZSET (Most Recent First)
        const productIds = await redisClient.zRevRange(redisKey, 0, limit - 1);
        
        if (productIds.length === 0) {
            // Initiate Cache-Aside strategy for empty cache/cold start
            fireAndForget(async () => {
                const mongoDoc = await RecentlyViewed.findOne({ user: userId }).select('views').lean();
                if (mongoDoc && mongoDoc.views.length > 0) {
                    // Rehydrate Redis cache from MongoDB data
                    const redisOps = mongoDoc.views.map(v => ({ score: v.updatedAt.getTime(), value: v.product.toString() }));
                    await redisClient.zAdd(redisKey, redisOps);
                    await redisClient.expire(redisKey, REDIS_TTL_SECONDS);
                }
            }, 'CACHE_REHYDRATION');
            
            return res.status(StatusCodes.OK).json({ count: 0, limit, items: [] });
        }

        // 2. Fetch Product Details using the robust multi-layer caching service (TITAN)
        // This function handles L1/L2 lookup, leader election (Redlock), and cache rebuilding.
        const itemsWithDetails = await getProductDetailsByIds(productIds); 
        
        // Final Security Check: Filter out any items that failed to load (e.g., product deleted)
        const validItems = itemsWithDetails.filter(item => item !== null); 

        res.status(StatusCodes.OK).json({
            count: validItems.length,
            limit: limit,
            source: 'RedisCache',
            items: validItems,
        });
        
    } catch (err) {
        // Fallback to MongoDB if Redis fails entirely 
        AuditLogger.log({ level: AuditLogger.LEVELS.ERROR, event: 'REDIS_READ_FAILED_FALLBACK_TO_MONGO', userId, details: { error: err.message } });
        
        try {
            // Fallback: Query MongoDB directly (less performant, but high reliability)
            const mongoItems = await RecentlyViewed.findOne({ user: userId })
                .select(`views product -_id`)
                .populate({ path: 'views.product', select: 'name price images slug isAvailable' })
                .setOptions({ readPreference: READ_PREFERENCE_POLICY })
                .lean();
                
            const items = mongoItems?.views
                ?.filter(view => view.product)
                .slice(0, limit) || [];

            res.status(StatusCodes.OK).json({ count: items.length, limit: limit, source: 'MongoDBFallback', items: items });
        } catch (mongoErr) {
            // If Mongo also fails, propagate the error
            next(mongoErr); 
        }
    }
};

// --------------------------------------------------------------------------------------------------
// CORE FUNCTION 3: REMOVE RECENTLY VIEWED
// --------------------------------------------------------------------------------------------------
const removeRecentlyViewed = async (req, res, next) => {
    try {
        const { productId } = req.params; 
        const userId = req.user.userID;
        const redisKey = `${REDIS_KEY_PREFIX}${userId}`;
        
        if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
            throw new BadRequestError("Invalid product ID format provided for removal.");
        }

        const redisClient = getRedisClient();

        // 1. Atomic removal from Redis
        const redisResult = await redisClient.zRem(redisKey, productId);
        
        // 2. Decoupled MongoDB Cleanup
        fireAndForget(async () => {
            await RecentlyViewed.updateOne(
                { user: userId },
                { $pull: { views: { product: new mongoose.Types.ObjectId(productId) } } }
            );
        }, 'DECOUPLED_REMOVE_MONGO');

        if (redisResult === 0) {
            return res.status(StatusCodes.NOT_FOUND).json({ message: "Product not found in user's recently viewed list.", productId });
        }

        res.status(StatusCodes.OK).json({ message: "Product successfully removed from viewed list.", productId });
            
    } catch (err) {
        next(err);
    }
};


// ==================================================================================================
// 💡 ADMINISTRATIVE & RELIABILITY FUNCTIONS (Zenith 6.0/7.0)
// ==================================================================================================

// -------------------- ADMIN 1: GET TOP VIEWED PRODUCTS (ANALYTICS) --------------------
const getAdminTopViewedProducts = async (req, res, next) => {
    try {
        const { limit = 10, startDate, endDate } = req.query;
        const limitInt = parseInt(limit);

        const dateFilter = {};
        if (startDate) dateFilter.updatedAt = { ...dateFilter.updatedAt, $gte: new Date(startDate) };
        if (endDate) dateFilter.updatedAt = { ...dateFilter.updatedAt, $lte: new Date(endDate) };

        // MongoDB Aggregation Pipeline for Analytics
        const topProducts = await RecentlyViewed.aggregate([
            { $unwind: "$views" }, 
            { $match: { "views.updatedAt": dateFilter.updatedAt || { $exists: true } } },
            { $group: { _id: "$views.product", count: { $sum: 1 } } }, 
            { $sort: { count: -1 } }, 
            { $limit: limitInt },
            { 
                $lookup: { 
                    from: 'products', 
                    localField: '_id',
                    foreignField: '_id',
                    as: 'productDetails'
                }
            },
            { $unwind: "$productDetails" },
            { $project: { _id: 0, productId: "$_id", viewCount: "$count", name: "$productDetails.name", slug: "$productDetails.slug" }}
        ]);

        res.status(StatusCodes.OK).json({
            count: topProducts.length,
            limit: limitInt,
            reportSource: 'MongoDB',
            data: topProducts,
        });

    } catch (err) {
        next(err);
    }
};

// -------------------- ADMIN 2: GET PRODUCT VIEWS BY USER (EVENT SOURCING/AUDIT) --------------------
const getProductViewsByUser = async (req, res, next) => {
    try {
        const { targetUserId } = req.params;
        const { limit = 20 } = req.query;

        if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
            throw new BadRequestError('Invalid or missing targetUserId.');
        }

        // 💡 Feature: Query the Event Source (Activity Logger) for full history
        const auditLog = await getActivitiesByUser(targetUserId, 'RECENTLY_VIEWED', limit);
        
        if (auditLog.length === 0) {
            throw new NotFoundError(`No viewing history found for user ID ${targetUserId}.`);
        }

        res.status(StatusCodes.OK).json({
            message: `Retrieved ${auditLog.length} view events from the audit log.`,
            targetUserId,
            data: auditLog,
        });
    } catch (err) {
        next(err);
    }
};

// -------------------- USER 1: CLEAR ALL RECENTLY VIEWED HISTORY --------------------
const clearAllRecentlyViewed = async (req, res, next) => {
    try {
        const userId = req.user.userID;
        const redisKey = `${REDIS_KEY_PREFIX}${userId}`;
        const redisClient = getRedisClient();

        const mongoResult = await RecentlyViewed.deleteOne({ user: userId });
        const redisResult = await redisClient.del(redisKey);
        
        fireAndForget(() => AuditLogger.log({
            level: AuditLogger.LEVELS.SECURITY,
            event: 'USER_HISTORY_CLEARED',
            userId: userId,
            details: { mongoDeleted: mongoResult.deletedCount, redisDeleted: redisResult }
        }), 'DECOUPLED_HISTORY_WIPE_LOG');

        if (mongoResult.deletedCount === 0 && redisResult === 0) {
            return res.status(StatusCodes.OK).json({ message: "History already empty.", cleared: 0 });
        }

        res.status(StatusCodes.OK).json({ message: "All recently viewed history has been permanently cleared." });

    } catch (err) {
        next(err);
    }
};

// -------------------- SYSTEM 1: SYNCHRONIZE CACHE FROM MONGO (INCIDENT RESPONSE) --------------------
const synchronizeCacheFromMongo = async (req, res, next) => {
    try {
        const { targetUserId } = req.params; // Admin targets a specific user

        if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
            throw new BadRequestError('Invalid or missing targetUserId.');
        }
        
        const redisKey = `${REDIS_KEY_PREFIX}${targetUserId}`;
        const redisClient = getRedisClient();

        // 1. Fetch source of truth
        const mongoDoc = await RecentlyViewed.findOne({ user: targetUserId })
            .select('views')
            .lean();
            
        if (!mongoDoc || mongoDoc.views.length === 0) {
            // If Mongo is empty, ensure Redis is also empty
            await redisClient.del(redisKey);
            return res.status(StatusCodes.OK).json({ message: `Cache reset successful. No data found in MongoDB for user ${targetUserId}.` });
        }
        
        // 2. Rebuild Redis ZSET
        const redisOps = mongoDoc.views.map(v => ({
            score: v.updatedAt.getTime(),
            value: v.product.toString()
        }));
        
        // Use ZADD to atomically replace the list
        await redisClient.del(redisKey); // Clear existing data first
        await redisClient.zAdd(redisKey, redisOps);
        await redisClient.expire(redisKey, REDIS_TTL_SECONDS);

        AuditLogger.log({ 
            level: AuditLogger.LEVELS.SECURITY,
            event: 'CACHE_MANUAL_SYNCHRONIZATION',
            userId: req.user.userID, // The admin user
            details: { targetUserId, itemsSynced: redisOps.length } 
        });

        res.status(StatusCodes.OK).json({
            message: `Cache for user ${targetUserId} successfully synchronized from MongoDB.`,
            itemsSynced: redisOps.length
        });
    } catch (err) {
        next(err);
    }
};

// -------------------- SYSTEM 2: CACHE INTEGRITY CHECK --------------------
const runCachePersistenceCheck = async (req, res, next) => {
    try {
        const { sampleSize = 100 } = req.query; 
        const redisClient = getRedisClient();
        
        let cursor = 0;
        const keysToCheck = [];
        do {
            const result = await redisClient.scan(cursor, 'MATCH', `${REDIS_KEY_PREFIX}*`, 'COUNT', 100);
            cursor = result[0];
            keysToCheck.push(...result[1]);
        } while (cursor !== '0' && keysToCheck.length < sampleSize);
        
        const sampledKeys = keysToCheck.slice(0, sampleSize);
        const inconsistencies = [];

        // Loop and Compare (Simplified for fast response)
        for (const redisKey of sampledKeys) {
            const userId = redisKey.replace(REDIS_KEY_PREFIX, '');
            const redisCount = await redisClient.zCard(redisKey); // Get count without fetching all data
            
            const mongoDoc = await RecentlyViewed.findOne({ user: userId }).select('views').lean();
            const mongoCount = mongoDoc?.views?.length || 0;
            
            if (mongoCount !== redisCount) {
                 inconsistencies.push({ 
                     userId, 
                     type: 'COUNT_MISMATCH', 
                     mongoCount, 
                     redisCount
                 });
            }
        }
        
        AuditLogger.log({ 
            level: inconsistencies.length > 0 ? AuditLogger.LEVELS.WARN : AuditLogger.LEVELS.INFO, event: 'CACHE_INTEGRITY_CHECK_COMPLETE',
            details: { keysChecked: sampledKeys.length, inconsistenciesFound: inconsistencies.length }
        });

        res.status(StatusCodes.OK).json({
            message: "Cache integrity check complete. Discrepancies may require manual synchronization.",
            keysChecked: sampledKeys.length,
            inconsistenciesFound: inconsistencies.length,
            inconsistencies,
        });

    } catch (err) {
        next(err);
    }
};


module.exports = {
    addRecentlyViewed,
    listRecentlyViewed,
    removeRecentlyViewed,
    
    // Administrative & Reliability Functions
    getAdminTopViewedProducts,
    getProductViewsByUser,
    clearAllRecentlyViewed,
    synchronizeCacheFromMongo,
    runCachePersistenceCheck,
};