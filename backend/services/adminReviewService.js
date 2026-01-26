// --- reviewService.js (Fully Instrumented with Tracing, Logging, and Metrics) ---

const mongoose = require('mongoose');
const Review = require('../model/Review'); 
const { NotFoundError } = require("../errors/notFoundError"); 
const { 
    cacheGet, 
    cacheSet, 
    acquireLock, 
    releaseLock, 
    delPattern, 
    adminReviewsCacheKey, 
    ADMIN_CACHE_TTL,
    CACHE_PREFIX 
} = require("../utils/reviewCache"); 

// 💡 ADDED IMPORTS for Observability
const Tracing = require('../utils/tracingClient'); 
const Logger = require('../utils/logger'); 
const Metrics = require('../utils/metricsClient'); // The newly integrated client

class ReviewService {

    // ========================================================
    // ADMIN/MODERATION METHODS
    // ========================================================

    /**
     * Executes the MongoDB Aggregation pipeline for Admin Reviews.
     * Separated for tracing and timing metrics granularity.
     */
    async #executeAdminReviewAggregation(matchConditions, sortObj, skip, limit) {
        // 🚀 TRACING & METRICS: Start a sub-span and timing for the DB call
        return Tracing.withSpan('ReviewService:DB:ReviewAggregation', async (span) => {
            
            const dbTimer = Date.now(); // Start timing the DB query

            span.setAttributes({ 
                'db.collection': 'reviews', 
                'db.operation': 'aggregate', 
                'db.skip': skip, 
                'db.limit': limit 
            });

            const pipeline = [
                // ... (aggregation pipeline remains the same)
                { $match: matchConditions }, 
                { $sort: sortObj },
                { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'user' } },
                { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
                { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'product' } },
                { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
                { $project: {
                    _id: 1, rating: 1, title: 1, text: 1, status: 1, isVerifiedPurchase: 1,
                    createdAt: 1, updatedAt: 1, helpful: 1,
                    user: { _id: '$user._id', name: '$user.name', email: '$user.email' }, 
                    product: { _id: '$product._id', name: '$product.name' }, 
                }},
                { $facet: {
                        docs: [{ $skip: skip }, { $limit: limit }],
                        totalCount: [{ $count: "count" }],
                }},
            ];

            const aggregationResult = await Review.aggregate(pipeline);
            const duration = Date.now() - dbTimer;
            
            Metrics.timing('db.review_admin_aggregation_ms', duration, { // 🚀 METRIC: DB Latency
                collection: 'reviews', 
                status: 'success' 
            }); 
            
            const data = aggregationResult[0];
            const totalDocuments = data.totalCount?.[0]?.count || 0;
            
            span.setAttribute('db.total_documents', totalDocuments);
            
            return { reviews: data.docs || [], totalDocuments: totalDocuments };
        });
    }

    /**
     * Retrieves a paginated list of reviews for the admin panel.
     */
    async getAdminReviewsByFilter({ page = 1, limit = 25, status = "all", product = "", sort = "-createdAt" }) {
        // 🚀 TRACING: Start the main request span
        return Tracing.withSpan('ReviewService:getAdminReviewsByFilter', async (span) => {

            page = Math.max(1, parseInt(page, 10) || 1);
            limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25)); 
            const skip = (page - 1) * limit;

            const cacheKey = adminReviewsCacheKey({ page, limit, status, product, sort });
            const lockKey = `${cacheKey}:lock`;
            const metricTags = { product_id: product || 'all', status: status };

            span.setAttributes({ 
                'cache.key': cacheKey,
                'query.page': page,
                'query.limit': limit
            });

            // 2. Try Cache Hit
            let cachedResult = await cacheGet(cacheKey);
            if (cachedResult) {
                Metrics.cacheHit('admin_reviews_list', metricTags); // 🚀 METRIC: Cache Hit
                Logger.info('CACHE_HIT', { key: cacheKey });
                span.setAttribute('cache.status', 'HIT');
                return cachedResult;
            }
            
            // 3. Cache Miss - Try to acquire lock
            Metrics.cacheMiss('admin_reviews_list', metricTags); // 🚀 METRIC: Cache Miss
            span.setAttribute('cache.status', 'MISS');
            let isLocked = false;
            let finalResult = null;
            let dbReadPerformed = false;
            
            try {
                isLocked = await acquireLock(lockKey); 
                
                if (!isLocked) {
                    // Lock contention check
                    Logger.warn('CACHE_LOCK_FAIL_WAIT', { key: cacheKey, action: 'Waiting for 500ms' });
                    await new Promise(resolve => setTimeout(resolve, 500)); 
                    cachedResult = await cacheGet(cacheKey);
                    
                    if (cachedResult) {
                        Metrics.increment('cache.delayed_hit_total', 1, metricTags); // 🚀 METRIC: Delayed Hit
                        Logger.info('CACHE_DELAYED_HIT', { key: cacheKey, reason: 'Lock contention resolved' });
                        span.setAttribute('cache.status', 'DELAYED_HIT');
                        return cachedResult;
                    }
                    
                    Metrics.increment('cache.stampede_risk_total', 1, metricTags); // 🚀 METRIC: Stampede Risk
                    Logger.warn('CACHE_STAMPEDE_RISK', { key: cacheKey, action: 'Proceeding to DB read without lock' });
                    span.setAttribute('cache.status', 'STAMPEDE_RISK');
                } else {
                    span.setAttribute('cache.status', 'LOCK_ACQUIRED');
                    Logger.info('CACHE_LOCK_ACQUIRED', { key: lockKey });
                }

                // 4. Build and Execute DB Query
                // ... (matchConditions and sortObj setup) ...
                const matchConditions = {};
                if (product) {
                    if (!mongoose.Types.ObjectId.isValid(product)) {
                        throw new Error("Invalid product ID format for filtering.");
                    }
                    matchConditions.product = new mongoose.Types.ObjectId(product);
                }
                if (status && status !== 'all') {
                    matchConditions.status = status.toLowerCase(); 
                }

                const sortObj = {};
                if (sort.startsWith("-")) {
                    sortObj[sort.substring(1)] = -1; 
                } else {
                    sortObj[sort] = 1;
                }
                
                const { reviews, totalDocuments } = await this.#executeAdminReviewAggregation(
                    matchConditions, sortObj, skip, limit
                );
                dbReadPerformed = true;
                
                // Structure the result
                finalResult = {
                    status: 'success',
                    results: reviews.length,
                    pagination: {
                        totalDocuments,
                        totalPages: Math.ceil(totalDocuments / limit),
                        currentPage: page,
                        limit,
                    },
                    data: { reviews }
                };
                
                // 5. Cache the result
                if (isLocked || !cachedResult) {
                    await cacheSet(cacheKey, finalResult, ADMIN_CACHE_TTL);
                    span.setAttribute('cache.action', 'SET');
                    Logger.info('CACHE_REBUILT_SET', { key: cacheKey, isLocked });
                }

                return finalResult;

            } catch (error) {
                Metrics.increment('service.error.fetch_reviews_total', 1, { method: 'getAdminReviewsByFilter' }); // 🚀 METRIC: Error
                Logger.error('REVIEW_FETCH_FAILED', { err: error, cacheKey, dbReadPerformed });
                throw new Error(`Failed to retrieve reviews: ${error.message}`);
            } finally {
                // 6. Release the lock
                if (isLocked) {
                    await releaseLock(lockKey);
                    Logger.info('CACHE_LOCK_RELEASED', { key: lockKey });
                }
            }
        });
    }

    /**
     * Updates the status of a specific review (e.g., publish, hide).
     */
    async updateReviewStatus({ reviewId, newStatus, adminNotes, adminId }) { 
        // 🚀 TRACING
        return Tracing.withSpan('ReviewService:updateReviewStatus', async (span) => {
            
            const statusMetricTags = { new_status: newStatus.toLowerCase(), admin_id: adminId };

            span.setAttributes({ 
                'review.id': reviewId, 
                'review.new_status': newStatus, 
                'user.admin_id': adminId 
            });

            if (!mongoose.Types.ObjectId.isValid(reviewId)) {
                Metrics.increment('service.error.validation_total', 1, { field: 'reviewId' }); // 🚀 METRIC: Validation Error
                throw new Error(`Invalid review ID format: ${reviewId}`);
            }
            
            // 1. Update the database.
            const updatedReview = await Review.findByIdAndUpdate(
                reviewId,
                {
                    status: newStatus.toLowerCase(), 
                    adminNotes: adminNotes || null,
                    updatedAt: Date.now()
                },
                { new: true, runValidators: true, select: '-__v' }
            );

            if (!updatedReview) {
                Metrics.increment('service.error.not_found_total', 1, { entity: 'review' }); // 🚀 METRIC: Not Found Error
                throw new NotFoundError(`Review with ID ${reviewId} not found.`);
            }

            // 2. Audit Log and Metrics for Moderation Action
            Metrics.increment('moderation.status_changes_total', 1, statusMetricTags); // 🚀 METRIC: Business Metric
            Logger.audit('REVIEW_STATUS_UPDATED', {
                entityId: reviewId,
                action: 'UPDATE_STATUS',
                userId: adminId, 
                newStatus: newStatus.toLowerCase(),
            });

            // 3. Invalidate all Admin Review List caches
            const pattern = `${CACHE_PREFIX}:admin:reviews:*`;
            await delPattern(pattern);
            Metrics.increment('cache.invalidation_total', 1, { pattern_type: 'admin_list' }); // 🚀 METRIC: Invalidation
            Logger.warn('CACHE_INVALIDATION', { pattern, reason: 'Review status changed' });

            return updatedReview;
        });
    }

    /**
     * Allows an admin to edit the content of a review.
     */
    async adminEditReviewContent(reviewId, allowedUpdates, adminId) {
        // 🚀 TRACING
        return Tracing.withSpan('ReviewService:adminEditReviewContent', async (span) => {
            span.setAttributes({ 
                'review.id': reviewId, 
                'user.admin_id': adminId 
            });

            if (!mongoose.Types.ObjectId.isValid(reviewId)) {
                Metrics.increment('service.error.validation_total', 1, { field: 'reviewId' }); 
                throw new Error(`Invalid review ID format: ${reviewId}`);
            }

            // 1. Update the database.
            const updatedReview = await Review.findByIdAndUpdate(
                reviewId,
                { ...allowedUpdates, updatedAt: Date.now() },
                { new: true, runValidators: true, select: '-__v' }
            );

            if (!updatedReview) {
                Metrics.increment('service.error.not_found_total', 1, { entity: 'review' });
                throw new NotFoundError(`Review with ID ${reviewId} not found.`);
            }
            
            // 2. Audit Log and Metrics
            Metrics.increment('moderation.content_edits_total', 1, { admin_id: adminId }); // 🚀 METRIC: Business Metric
            Logger.audit('REVIEW_CONTENT_EDITED', {
                entityId: reviewId,
                action: 'EDIT_CONTENT',
                userId: adminId,
                fields: Object.keys(allowedUpdates),
            });

            // 3. Invalidate all Admin Review List caches
            const pattern = `${CACHE_PREFIX}:admin:reviews:*`;
            await delPattern(pattern);
            Metrics.increment('cache.invalidation_total', 1, { pattern_type: 'admin_list' });
            Logger.warn('CACHE_INVALIDATION', { pattern, reason: 'Review content edited' });

            return updatedReview;
        });
    }

    /**
     * Permanently deletes a review.
     */
    async deleteReviewPermanently(reviewId, adminId) {
        // 🚀 TRACING
        return Tracing.withSpan('ReviewService:deleteReviewPermanently', async (span) => {
            span.setAttributes({ 
                'review.id': reviewId,
                'user.admin_id': adminId 
            });

            if (!mongoose.Types.ObjectId.isValid(reviewId)) {
                Metrics.increment('service.error.validation_total', 1, { field: 'reviewId' });
                throw new Error(`Invalid review ID format: ${reviewId}`);
            }

            // 1. Delete from database.
            const review = await Review.findByIdAndDelete(reviewId);

            if (!review) {
                Metrics.increment('service.error.not_found_total', 1, { entity: 'review' });
                throw new NotFoundError(`Review with ID ${reviewId} not found for permanent deletion.`);
            }

            // 2. Audit Log and Metrics
            Metrics.increment('moderation.deletions_total', 1, { admin_id: adminId }); // 🚀 METRIC: Business Metric
            Logger.audit('REVIEW_DELETED', {
                entityId: reviewId,
                action: 'DELETE_PERMANENT',
                userId: adminId,
            });

            // 3. Invalidate all Admin Review List caches
            const pattern = `${CACHE_PREFIX}:admin:reviews:*`;
            await delPattern(pattern);
            Metrics.increment('cache.invalidation_total', 1, { pattern_type: 'admin_list' });
            Logger.warn('CACHE_INVALIDATION', { pattern, reason: 'Review deleted' });

            return true;
        });
    }

    // ========================================================
    // PUBLIC/USER METHODS
    // ========================================================
    
    /**
     * Fetches published reviews for a specific product.
     */
    async getPublishedProductReviews(productId, { page = 1, limit = 10, sort = "-createdAt" }) {
        // 🚀 TRACING
        return Tracing.withSpan('ReviewService:getPublishedProductReviews', async (span) => {
            span.setAttributes({ 
                'product.id': productId, 
                'query.page': page, 
                'query.limit': limit 
            });
            const dbTimer = Date.now();
            const metricTags = { product_id: productId };

            if (!mongoose.Types.ObjectId.isValid(productId)) {
                Metrics.increment('service.error.validation_total', 1, { field: 'productId' });
                throw new Error(`Invalid product ID format.`);
            }

            page = Math.max(1, parseInt(page, 10) || 1);
            limit = Math.max(1, parseInt(limit, 10) || 10);
            const skip = (page - 1) * limit;
            
            const [reviews, totalCount] = await Tracing.withSpan('DB:FetchReviewsAndCount', () => 
                Promise.all([
                    Review.find({ product: productId, status: 'published' })
                        .select('rating title text isVerifiedPurchase helpful createdAt')
                        .skip(skip)
                        .limit(limit)
                        .sort(sort)
                        .populate({ path: 'user', select: 'name photo' }), 
                    Review.countDocuments({ product: productId, status: 'published' })
                ])
            ); 
            
            const duration = Date.now() - dbTimer;
            Metrics.timing('db.review_public_fetch_ms', duration, metricTags); // 🚀 METRIC: Public Read Latency

            span.setAttribute('db.total_documents', totalCount);

            return {
                docs: reviews,
                total: totalCount,
                page,
                totalPages: Math.ceil(totalCount / limit)
            };
        });
    }
}

module.exports = {
    ReviewService,
    reviewService: new ReviewService()
};