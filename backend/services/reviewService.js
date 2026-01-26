/**
 * services/reviewService.js
 * Comprehensive service layer for handling product reviews.
 * Includes: MongoDB transactions, Cache-Aside with Redis locks (Mutex) for Cache Stampede prevention,
 * Asynchronous job queue integration, and Gemini API integration for Content Moderation.
 */
const mongoose = require("mongoose");

// --- INTERNAL DEPENDENCIES (Assume correct paths for models and errors) ---
// NOTE: These models must be defined elsewhere for the code to run fully.
const Review = require("../model/Review"); 
const Product = require("../model/product");

// --- ERROR HANDLERS (Assume standard classes) ---
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const ForbiddenError = require("../errors/forbidddenError");
const ConflictError = require("../errors/conflictError");
const InternalServerError = require("../errors/internalServerError");

// --- EXTERNAL SERVICE INTEGRATIONS (Event Bus for Async Jobs) ---
// IMPORTANT: This is a placeholder. 'enqueueAggregateJob' must be implemented
// using a real job queue like Redis/Bull, RabbitMQ, or a cloud queue.
const { enqueueAggregateJob } = require(".."); 

// --- CACHE UTILITIES (Redis/Key Management) ---
// NOTE: These utilities must handle connection and key logic.
const {
    cacheGet,
    cacheSet,
    cacheDel,
    delPattern,
    acquireLock,
    releaseLock,
    userReviewCacheKey,
    publicProductReviewsCacheKey,
    USER_REVIEW_TTL,
} = require("../utils/reviewCache");

// --- GEMINI API CONSTANTS AND UTILITY ---
const API_KEY = ""; // Placeholder. Canvas runtime provides key.
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${API_KEY}`;

// Harm threshold: Block content rated as medium or high risk.
const HARM_THRESHOLD = "BLOCK_MEDIUM_AND_ABOVE"; 

/**
 * Utility function to make an API call with exponential backoff.
 * @param {object} payload - The request body for the Gemini API.
 * @param {number} maxRetries - Maximum number of retries.
 * @returns {Promise<object>} The parsed API response.
 */
async function callGeminiApiWithBackoff(payload, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        const delay = Math.pow(2, i) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay)); // Initial delay and backoff

        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                return await response.json();
            } else if (response.status === 429 && i < maxRetries - 1) {
                // Rate limit hit (429), continue loop for retry
                console.warn(`API Rate Limit hit. Retrying in ${delay / 1000}s...`);
            } else {
                throw new Error(`Gemini API request failed with status: ${response.status}`);
            }
        } catch (error) {
            if (i === maxRetries - 1) {
                console.error("Gemini API call failed after max retries.", error);
                throw error;
            }
            // Other network/fetch errors, retry
            console.error(`Attempt ${i + 1} failed. Retrying...`, error.message);
        }
    }
}

/**
 * PRODUCTION INTEGRATION: Content Moderation using Gemini's Safety Ratings.
 * We rely on the model's built-in safety classifier to determine if content is safe.
 * @param {string} text - The content (title + text) to check.
 * @returns {Promise<{ safe: boolean, reason?: string }>}
 */
async function runContentModeration(text) {
    const payload = {
        contents: [{ parts: [{ text: `Check this user review content for safety violations: ${text}` }] }],
        // Request safety information without expecting generated text content
        config: {
            // Setting temperature to 0 for a deterministic safety classification
            temperature: 0,
        },
    };

    try {
        const result = await callGeminiApiWithBackoff(payload);

        const candidate = result.candidates?.[0];
        const safetyRatings = candidate?.safetyRatings || [];

        // Check if any harm category meets or exceeds the defined blocking threshold
        const isUnsafe = safetyRatings.some(rating => {
            const blocked = rating.probability === HARM_THRESHOLD || rating.probability === 'BLOCK_HIGH';
            if (blocked) {
                console.warn(`Content blocked: Category ${rating.category}, Probability: ${rating.probability}`);
            }
            return blocked;
        });

        if (isUnsafe) {
            const reasons = safetyRatings
                .filter(r => r.probability === HARM_THRESHOLD || r.probability === 'BLOCK_HIGH')
                .map(r => r.category.replace('HARM_CATEGORY_', '').toLowerCase())
                .join(', ');
            return { safe: false, reason: `Violates policy in categories: ${reasons}.` };
        }

        return { safe: true };
    } catch (err) {
        console.error("Content Moderation Service Error (Gemini API):", err);

        // PRODUCTION RULE: BLOCK when moderation service is unavailable or consistently fails.
        // This is a critical security measure.
        throw new InternalServerError(
            "Content moderation service is unavailable due to an external error. Please try again shortly."
        );
    }
}
// --- END CONTENT MODERATION ---

// --- User Post Time Restriction Constant ---
const POST_EDIT_DELETE_WINDOW_MINUTES = 30;

// --- Cache Invalidation Helpers ---

/**
 * Function to invalidate the public review cache for a single product.
 * Called when a published review is created, updated, or deleted.
 */
async function invalidateProductReviewsCache(productId) {
    // Matches: ecom:public:reviews:product:PRODUCT_ID:*
    const pattern = publicProductReviewsCacheKey(productId, { wildcard: true });
    // Fire-and-forget background task
    delPattern(pattern).catch(e => console.error(`Failed to invalidate public cache for ${productId}:`, e));
}

/**
 * Function to invalidate the specific user review cache key.
 * Called when a user's review is created, updated, or deleted.
 */
async function invalidateUserReviewCache(userId, productId) {
    const key = userReviewCacheKey(userId, productId);
    cacheDel(key).catch(e => console.error(`Failed to invalidate user review cache for ${key}:`, e));
}

/**
 * Utility: ensure rating is integer/number and within bounds (1-5)
 */
function normalizeRating(rating) {
    if (rating === undefined || rating === null) return null;
    const val = Number(rating);
    if (Number.isNaN(val) || !isFinite(val)) {
        throw new BadRequestError("Invalid rating value.");
    }
    const normalizedVal = Math.round(val);
    if (normalizedVal < 1 || normalizedVal > 5) {
        throw new BadRequestError("Rating must be between 1 and 5.");
    }
    return normalizedVal;
}

/**
 * Recompute and set product average rating (safe fallback/consistency check).
 * NOTE: This function is primarily for the async worker but kept here for potential
 * synchronous use cases (e.g., immediate consistency check during deployment).
 */
async function recalcProductRating(productId, session = null) {
    const id = new mongoose.Types.ObjectId(productId);

    const pipeline = [
        // Match only published reviews for this product
        { $match: { product: id, status: 'published' } },
        {
            $group: {
                _id: "$product",
                ratingSum: { $sum: "$rating" },
                ratingCount: { $sum: 1 },
            },
        },
    ];

    const opts = {};
    if (session) opts.session = session;

    const result = await Review.aggregate(pipeline).option(opts);
    const stats = result[0] || { ratingSum: 0, ratingCount: 0 };

    // Calculate the final rating average
    const averageRating = stats.ratingCount > 0 ? stats.ratingSum / stats.ratingCount : 0;

    // Update the Product document using $set
    await Product.updateOne(
        { _id: id },
        {
            $set: {
                rating: Math.round(averageRating * 100) / 100, // Round to 2 decimal places
                ratingSum: stats.ratingSum,
                ratingCount: stats.ratingCount,
                reviewsCount: stats.ratingCount, // reviewsCount tracks published count
            },
        },
        opts
    );
}

/**
 * Service: submitReview
 * - Includes Content Moderation Check.
 * - Invalidates User Review Cache.
 * - Transactions ensure atomicity for review creation and potential product checks.
 */
async function submitReview({ userId, productId, rating, title = "", text = "", sessionProvided = null }) {
    rating = normalizeRating(rating);
    const fullText = `${title || ''} ${text || ''}`;

    // --- 1. Content Moderation Check ---
    const moderationResult = await runContentModeration(fullText);
    if (!moderationResult.safe) {
        // Throws BadRequestError if content is flagged (user input issue)
        throw new BadRequestError(`Content failed moderation check. Reason: ${moderationResult.reason}`);
    }

    // New reviews default to 'pending'
    const initialStatus = 'pending';

    const session = sessionProvided || (await mongoose.startSession());
    let shouldEndSession = false;

    try {
        if (!sessionProvided) {
            shouldEndSession = true;
            session.startTransaction();
        }

        // 2. Ensure product exists and is available
        const product = await Product.findById(productId).session(session).lean();
        if (!product) throw new NotFoundError("Product not found.");
        if (product.isAvailable === false || product.status !== "active") {
            throw new BadRequestError("Cannot review an unavailable or inactive product.");
        }

        // 3. Create review
        let review;
        try {
            review = await Review.create(
                {
                    user: userId,
                    product: productId,
                    rating,
                    title,
                    text,
                    status: initialStatus,
                    isVerifiedPurchase: false,
                },
                { session }
            );
        } catch (err) {
            // Check for MongoDB duplicate key error (user:product index)
            if (err.code === 11000 || (err.name === 'MongoError' && err.message.includes('duplicate key'))) {
                throw new ConflictError("User has already submitted a review for this product.");
            }
            throw new InternalServerError("Failed to create review.", err);
        }

        // 4. Commit the transaction
        if (shouldEndSession) await session.commitTransaction();

        // 5. Post-Commit Cache Invalidation
        await invalidateUserReviewCache(userId, productId);


        return review.toObject ? review.toObject() : review;
    } catch (err) {
        if (shouldEndSession) {
            try { await session.abortTransaction(); } catch (e) { console.error("Session abort failed:", e); }
        }
        throw err;
    } finally {
        if (shouldEndSession) session.endSession();
    }
}

/**
 * Service: updateReview (User-only functionality)
 * - Implements 30-minute time window for edits.
 * - Includes Content Moderation Check.
 * - Enqueues an async job for aggregate updates if the rating changes on a published review.
 */
async function updateReview({ reviewId, userId, rating, title, text, sessionProvided = null }) {
    if (rating !== undefined && rating !== null) rating = normalizeRating(rating);

    // Find the review without a session initially to check time window and user ownership
    const review = await Review.findById(reviewId);
    if (!review) throw new NotFoundError("Review not found.");

    // Authorization: Must be the owner.
    if (review.user.toString() !== userId.toString()) {
        throw new ForbiddenError("You are not allowed to edit this review.");
    }

    // --- Time Window Check ---
    const timeElapsedMinutes = (Date.now() - review.createdAt.getTime()) / 60000;
    if (timeElapsedMinutes > POST_EDIT_DELETE_WINDOW_MINUTES) {
        throw new ForbiddenError(`Reviews can only be modified within ${POST_EDIT_DELETE_WINDOW_MINUTES} minutes of posting.`);
    }

    const session = sessionProvided || (await mongoose.startSession());
    let shouldEndSession = false;

    try {
        if (!sessionProvided) {
            shouldEndSession = true;
            session.startTransaction();
        }

        const oldRating = review.rating;
        const oldStatus = review.status; // Current status
        const productId = review.product.toString(); // Store ID for queuing

        // 1. Update review document fields in memory
        if (rating !== null && rating !== undefined) review.rating = rating;
        if (typeof title === "string") review.title = title;
        if (typeof text === "string") review.text = text;

        const newText = review.text;
        const newTitle = review.title;

        // --- Content Moderation Check on new content ---
        const moderationResult = await runContentModeration(`${newTitle} ${newText}`);
        if (!moderationResult.safe) {
            throw new BadRequestError(`Content failed moderation check. Reason: ${moderationResult.reason}`);
        }

        // Save the updated review within the transaction
        await review.save({ session });

        const newStatus = review.status; // Status should be unchanged here unless business logic dictates otherwise
        const newRating = review.rating;

        // --- 2. Aggregation Delta Logic (Only for rating change on published reviews) ---
        let deltaRating = 0;
        let deltaCount = 0;
        let requiresUpdate = false;

        // Rating Change Logic: Only affects aggregates if it *was* and *remains* published.
        if (newRating !== oldRating && newStatus === 'published') {
            deltaRating = newRating - (oldRating || 0);
            deltaCount = 0; // The review still exists, so count delta is zero
            requiresUpdate = true;
        }

        // 3. Commit the review update transaction
        if (shouldEndSession) await session.commitTransaction();

        // 4. ENQUEUE the asynchronous aggregate job (OFFLOADED)
        if (requiresUpdate) {
            // Note: This relies on an external job queue being configured correctly.
            await enqueueAggregateJob({
                type: "update",
                productId: productId,
                ratingDelta: deltaRating,
                countDelta: deltaCount
            });

            // Invalidate public cache if aggregation changes occurred
            await invalidateProductReviewsCache(productId);
        }

        // 5. Post-Commit Cache Invalidation
        await invalidateUserReviewCache(userId, productId);


        return review.toObject ? review.toObject() : review;
    } catch (err) {
        if (shouldEndSession) {
            try { await session.abortTransaction(); } catch (e) { console.error("Session abort failed:", e); }
        }
        throw err;
    } finally {
        if (shouldEndSession) session.endSession();
    }
}

/**
 * Service: deleteReview (User-only functionality)
 * - Implements 30-minute time window for deletion.
 * - Enqueues a job for aggregate updates if the review was published.
 */
async function deleteReview({ reviewId, userId = null, sessionProvided = null }) {
    const review = await Review.findById(reviewId);
    if (!review) throw new NotFoundError("Review not found.");

    // Authorization: must be owner
    if (!userId || review.user.toString() !== userId.toString()) {
        throw new ForbiddenError("You are not allowed to delete this review.");
    }

    // --- Time Window Check ---
    const timeElapsedMinutes = (Date.now() - review.createdAt.getTime()) / 60000;
    if (timeElapsedMinutes > POST_EDIT_DELETE_WINDOW_MINUTES) {
        throw new ForbiddenError(`Reviews can only be deleted within ${POST_EDIT_DELETE_WINDOW_MINUTES} minutes of posting.`);
    }

    const session = sessionProvided || (await mongoose.startSession());
    let shouldEndSession = false;

    try {
        if (!sessionProvided) {
            shouldEndSession = true;
            session.startTransaction();
        }

        const rating = review.rating || 0;
        const productId = review.product.toString();
        // CRITICAL: Check if it was published to determine if aggregates need updating
        const wasPublished = review.status === 'published';

        // 1. Delete the review within the transaction
        await Review.findByIdAndDelete(reviewId, { session });

        // 2. Commit the transaction
        if (shouldEndSession) await session.commitTransaction();

        // 3. ENQUEUE the asynchronous aggregate job (OFFLOADED)
        if (wasPublished) {
            // Delta: rating decrement and count decrement
            // Note: This relies on an external job queue being configured correctly.
            await enqueueAggregateJob({
                type: "delete",
                productId: productId,
                ratingDelta: -rating,
                countDelta: -1
            });

            // Invalidate public cache if aggregation was changed
            await invalidateProductReviewsCache(productId);
        }

        // 4. Post-Commit Cache Invalidation
        await invalidateUserReviewCache(userId, productId);

        return { success: true, message: "Review deleted successfully." };
    } catch (err) {
        if (shouldEndSession) {
            try { await session.abortTransaction(); } catch (e) { console.error("Session abort failed:", e); }
        }
        throw err;
    } finally {
        if (shouldEndSession) session.endSession();
    }
}

/**
 * Service: getReviewsForProduct
 * CRITICAL: Only retrieves reviews where status: 'published'.
 * - Implements Cache-Aside pattern with Mutex Lock to prevent Cache Stampede.
 */
async function getReviewsForProduct(productId, { page = 1, limit = 20, sort = "-createdAt" } = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // --- Caching Logic (Public/User-facing) ---
    const cacheKey = publicProductReviewsCacheKey(productId, { page: pageNum, limit: limitNum, sort });
    const lockKey = `${cacheKey}:lock`;

    // 1. Try Cache Hit
    const cachedData = await cacheGet(cacheKey);
    if (cachedData) {
        return cachedData;
    }
    // ------------------------------------------------

    let acquiredLockValue = null;
    let finalResponse = null;

    try {
        // 2. Cache Miss - Attempt to acquire lock to prevent cache stampede
        acquiredLockValue = await acquireLock(lockKey);

        // 3. If lock acquired, proceed with expensive DB query
        if (acquiredLockValue) {
            // Build sort object
            const sortObj = {};
            if (typeof sort === "string") {
                const dir = sort.startsWith("-") ? -1 : 1;
                const key = sort.replace(/^-/, "");
                sortObj[key] = dir;
            } else if (typeof sort === "object") {
                Object.assign(sortObj, sort);
            } else {
                sortObj.createdAt = -1;
            }

            // Use aggregation with $facet to get docs + total simultaneously
            const pipeline = [
                // CRITICAL: Only retrieve reviews that are published AND belong to the product
                { $match: { product: new mongoose.Types.ObjectId(productId), status: 'published' } },
                {
                    $sort: sortObj,
                },
                {
                    $facet: {
                        docs: [
                            { $skip: skip },
                            { $limit: limitNum },
                            {
                                // Join to fetch limited user details
                                $lookup: {
                                    from: "users", // Assuming 'users' is the collection name
                                    localField: "user",
                                    foreignField: "_id",
                                    as: "user",
                                },
                            },
                            { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
                            {
                                $project: {
                                    // Project only necessary fields for public view
                                    rating: 1,
                                    title: 1,
                                    text: 1,
                                    createdAt: 1,
                                    updatedAt: 1,
                                    "user._id": 1,
                                    "user.name": 1,
                                    "user.avatar": 1,
                                    isVerifiedPurchase: 1,
                                    helpful: 1,
                                    status: 1,
                                },
                            },
                        ],
                        totalCount: [{ $count: "count" }],
                    },
                },
            ];

            const result = await Review.aggregate(pipeline);
            const docs = (result[0] && result[0].docs) || [];
            const total = (result[0] && result[0].totalCount[0] && result[0].totalCount[0].count) || 0;

            finalResponse = {
                docs,
                total,
                page: pageNum,
                pages: Math.ceil(total / limitNum),
                limit: limitNum,
            };

            // 4. Write to Cache (if data was successfully generated)
            await cacheSet(cacheKey, finalResponse);

            return finalResponse;
        } else {
            // 5. Lock Not Acquired - Another process is building the cache. Wait a moment and check cache again.
            return (await cacheGet(cacheKey)) || { docs: [], total: 0, page: pageNum, pages: 0, limit: limitNum };
        }
    } catch (e) {
        console.error("Error generating public reviews and caching:", e);
        throw new InternalServerError("Failed to retrieve product reviews.", e);
    } finally {
        // 6. Release lock if held
        if (acquiredLockValue) {
            await releaseLock(lockKey, acquiredLockValue);
        }
    }
}

/**
 * Service: getUserReview
 * - Implements Cache-Aside pattern for user's personal review (including pending/draft).
 */
async function getUserReview(userId, productId) {
    const cacheKey = userReviewCacheKey(userId, productId);

    // 1. Try Cache Hit
    const cachedReview = await cacheGet(cacheKey);
    if (cachedReview) {
        return cachedReview;
    }

    // 2. Cache Miss - Fetch from DB
    // Populating product name/slug for context is useful for the user's "My Reviews" page.
    const review = await Review.findOne({ user: userId, product: productId }).populate("product", "name slug").lean();

    // 3. Set to Cache
    if (review) {
        // Use the defined TTL for user-specific cache
        await cacheSet(cacheKey, review, USER_REVIEW_TTL);
    }

    return review;
}


module.exports = {
    submitReview,
    updateReview,
    deleteReview,
    getReviewsForProduct,
    getUserReview,
    recalcProductRating,
};