// --- External Dependencies & Helpers ---
const reviewService = require("../services/reviewService");
// Assumed to be imported or defined via global middleware/utilities
const UnauthorizedError = require("../errors/unauthorized"); 
const BadRequestError = require("../errors/bad-request-error"); 
const NotFoundError = require("../errors/not-found-error"); 
// Assuming a middleware/utility wraps controller functions for centralized error handling
const asyncHandler = require("../middleware/asyncHandler"); 

/**
 * Helper: extracts authenticated user id and admin flag.
 * Assumes an authentication middleware has successfully populated req.user.
 * @param {object} req - Express request object
 * @returns {{userId: string, isAdmin: boolean}}
 * @throws {UnauthorizedError} if the user is not authenticated.
 */
function getAuth(req) {
    const user = req.user;
    // Standardizing on 'id' or 'userId' from the token payload, ensuring it's a string identifier
    const userId = user && (user.id || user.userId); 
    
    if (!user || !userId) {
        // Log sensitive auth failure details in the service/middleware layer, not here.
        throw new UnauthorizedError("Authentication required to access this resource.");
    }
    
    // Check if the user has the 'admin' role (case-insensitive check for robustness)
    const isAdmin = user.role && String(user.role).toLowerCase() === 'admin';

    return { userId, isAdmin };
}

// ========================================================
// POST /api/v1/reviews
// Purpose: Create a new review.
// ========================================================
exports.createReview = asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);

    // req.body is guaranteed clean: { productId, rating, title, text }
    const { productId, rating, title, text } = req.body;

    // Delegate all business logic (e.g., uniqueness check, rating aggregation) to the service layer
    const review = await reviewService.submitReview({
        userId,
        productId,
        rating,
        title,
        text,
    });

    // Send success response (201 Created). Awaiting moderation is standard practice.
    return res.status(201).json({ 
        status: 'success', 
        message: 'Review successfully submitted and awaiting moderation.',
        data: { review } 
    });
});

// ========================================================
// PUT /api/v1/reviews/:reviewId
// Purpose: Edit an existing review (owner or admin).
// Admin can update status; owner can update content (rating, title, text).
// ========================================================
exports.editReview = asyncHandler(async (req, res) => {
    const { userId, isAdmin } = getAuth(req);
    const reviewId = req.params.reviewId; 
    
    // req.body contains the fields to update
    const updateFields = req.body;

    if (Object.keys(updateFields).length === 0) {
        throw new BadRequestError("No valid fields provided for update.");
    }

    // Delegate update logic and authorization checks to the service layer
    const updated = await reviewService.updateReview({
        reviewId,
        userId,
        isAdmin,
        ...updateFields,
    });

    return res.status(200).json({ 
        status: 'success', 
        message: 'Review updated successfully.',
        data: { review: updated } 
    });
});

// ========================================================
// DELETE /api/v1/reviews/:reviewId
// Purpose: Delete a review (owner or admin).
// ========================================================
exports.removeReview = asyncHandler(async (req, res) => {
    const { userId, isAdmin } = getAuth(req); 
    const reviewId = req.params.reviewId; 

    // Delegate deletion logic and authorization checks to the service layer
    await reviewService.deleteReview({ reviewId, userId, isAdmin });

    // 204 No Content for successful deletion - MUST NOT send a body
    return res.status(204).end(); 
});

// ========================================================
// POST /api/v1/reviews/:reviewId/report
// Purpose: Report a review for moderation.
// ========================================================
exports.reportReview = asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const reviewId = req.params.reviewId;
    
    // Optional: req.body can include a reason or category for reporting
    const { reason = 'General misconduct' } = req.body;

    // Service handles: validation, checking if user already reported, logging the report
    await reviewService.submitReport({ reviewId, reportedByUserId: userId, reason });

    return res.status(202).json({
        status: 'accepted',
        message: 'Review report submitted successfully. Thank you for helping keep our community safe.',
        data: null
    });
});

// ========================================================
// GET /api/v1/reviews/product/:productId (Public)
// Purpose: List PUBLISHED reviews for a specific product, with pagination/sorting.
// ========================================================
exports.listForProduct = asyncHandler(async (req, res) => {
    const { productId } = req.params; 
    
    // Extract and ensure query parameters are safely structured
    const { page, limit, sort, filter } = req.query;
    const options = { 
        page: parseInt(page) || 1, 
        limit: parseInt(limit) || 10, 
        sort, 
        filter 
    };

    // Public list only fetches reviews with status 'published'
    const result = await reviewService.getReviewsForProduct(productId, options);

    return res.status(200).json(result);
});

// ========================================================
// GET /api/v1/reviews/user/:productId (Private)
// Purpose: Retrieve the authenticated user's review for a product.
// Useful for checking if the user has already submitted one.
// ========================================================
exports.getUserReview = asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const productId = req.params.productId; 
    
    const review = await reviewService.getUserReview(userId, productId);
    
    // If review is null/undefined, it means user hasn't reviewed yet, which is not an error
    if (!review) {
        throw new NotFoundError(`No review found for user ${userId} on product ${productId}.`);
    }

    return res.status(200).json({ 
        status: 'success',
        data: { review }
    }); 
});


// ========================================================
// GET /api/v1/reviews/:reviewId (Public/Admin Read)
// Purpose: Get a single review by ID.
// Admin gets it regardless of status; Public users only see published reviews.
// ========================================================
exports.getReviewById = asyncHandler(async (req, res) => {
    // Auth is optional for public read, but needed to determine admin status
    let userId = null;
    let isAdmin = false;
    try {
        ({ userId, isAdmin } = getAuth(req));
    } catch (e) {
        // Ignore UnauthorizedError if fetching publicly
    }

    const reviewId = req.params.reviewId;

    const review = await reviewService.getSingleReview({ reviewId, userId, isAdmin });

    if (!review) {
         throw new NotFoundError(`Review with ID ${reviewId} not found or is not published.`);
    }

    return res.status(200).json({ 
        status: 'success',
        data: { review }
    });
});


// ========================================================
// GET /api/v1/reviews/admin (Admin Only)
// Purpose: List ALL reviews for moderation dashboard, with advanced filtering.
// ========================================================
exports.listAllReviews = asyncHandler(async (req, res) => {
    const { isAdmin } = getAuth(req);

    if (!isAdmin) {
        throw new UnauthorizedError("Administrative access required.");
    }

    // Extract and ensure query parameters are safely structured
    const { page, limit, sort, status, minRating, maxRating } = req.query;
    const options = { 
        page: parseInt(page) || 1, 
        limit: parseInt(limit) || 25, // Higher default limit for admin dashboards
        sort, 
        filters: { status, minRating, maxRating } 
    };

    // This service call fetches all reviews (pending, published, rejected)
    const result = await reviewService.getAllReviews(options);

    return res.status(200).json(result);
});