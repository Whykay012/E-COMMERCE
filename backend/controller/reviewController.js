const reviewService = require("../services/reviewService");
// Assumed to be imported or defined via global middleware/utilities
const UnauthorizedError = require("../errors/unauthorized"); 
const BadRequestError = require("../errors/bad-request-error"); 
// Assuming a middleware/utility wraps controller functions for centralized error handling
const asyncHandler = require("../middleware/asyncHandler"); 

/**
 * Helper: extracts authenticated user id and admin flag.
 * Assumes an authentication middleware has successfully populated req.user.
 * * IMPORTANT UPDATE: Checks req.user.role === 'admin' for admin status.
 * * @param {object} req - Express request object
 * @returns {{userId: string, isAdmin: boolean}}
 * @throws {UnauthorizedError} if the user is not authenticated.
 */
function getAuth(req) {
    const user = req.user;
    // Standardizing on 'id' or 'userId' from the token payload
    const userId = user && (user.id || user.userId); 
    
    if (!user || !userId) {
        throw new UnauthorizedError("Authentication required.");
    }
    
    // Check if the user has the 'admin' role
    const isAdmin = user.role === 'admin';

    return { userId, isAdmin };
}

// ========================================================
// POST /api/reviews
// Purpose: Create a new review, relying on middleware for body validation.
// ========================================================
exports.createReview = asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);

    // req.body is guaranteed clean: { productId, rating, title, text }
    const { productId, rating, title, text } = req.body;

    // Delegate all business logic to the service layer
    const review = await reviewService.submitReview({
        userId,
        productId,
        rating,
        title,
        text,
    });

    // Send success response (201 Created)
    return res.status(201).json({ 
        status: 'success', 
        message: 'Review submitted for moderation.',
        data: { review } 
    });
});

// ========================================================
// PUT /api/reviews/:id
// Purpose: Edit an existing review (owner or admin), relying on middleware for ID/body validation.
// ========================================================
exports.editReview = asyncHandler(async (req, res) => {
    const { userId, isAdmin } = getAuth(req);
    const reviewId = req.params.id; 

    // req.body is guaranteed clean and contains ONLY allowed fields (e.g., rating, title, text, status for admin)
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
// DELETE /api/reviews/:id
// Purpose: Delete a review (owner or admin).
// ========================================================
exports.removeReview = asyncHandler(async (req, res) => {
    const { userId, isAdmin } = getAuth(req); 
    const reviewId = req.params.id; // Guaranteed valid ID

    // Delegate deletion logic and authorization checks to the service layer
    await reviewService.deleteReview({ reviewId, userId, isAdmin });

    // 204 No Content for successful deletion
    return res.status(204).json({ 
        status: 'success', 
        data: null 
    });
});

// ========================================================
// GET /api/reviews/product/:productId (Public View)
// Purpose: List published reviews for a product, with pagination.
// ========================================================
exports.listForProduct = asyncHandler(async (req, res) => {
    const { productId } = req.params; 
    
    // req.query fields (page, limit, sort) are guaranteed clean and cast by middleware
    const { page, limit, sort } = req.query;

    const result = await reviewService.getReviewsForProduct(productId, { page, limit, sort });

    return res.status(200).json(result);
});

// ========================================================
// GET /api/reviews/user/:productId (User's specific review)
// Purpose: Retrieve the authenticated user's review for a product.
// ========================================================
exports.getUserReview = asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const productId = req.params.productId; 
    
    const review = await reviewService.getUserReview(userId, productId);
    
    return res.status(200).json({ 
        status: 'success',
        data: { review }
    }); 
});