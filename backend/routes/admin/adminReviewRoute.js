const express = require('express');
const router = express.Router();

// --- Controllers ---
const reviewController = require('../controller/reviewController'); 

// --- Validation Schemas ---
const { 
    createReviewSchema,
    updateReviewSchema,
    publicListQuerySchema,
    adminReviewQuerySchema,
    adminStatusUpdateSchema, // New schema for dedicated admin status update
    reportReviewSchema,
    reviewIdParam, 
    productIdParam, 
} = require('../schemas/review.schema'); 

// --- Middleware ---
const validate = require('../middleware/validate'); 
const { globalLimiter } = require('../middleware/rateLimiters');
const { adminOnly, authenticate } = require('../middleware/authMiddleware'); 
const { sanitizeInput } = require('../middleware/sanitizeOutput');


// Apply global rate limiting to all requests
router.use(globalLimiter); 

// ========================================================
// 1. PUBLIC READ ROUTES (No Authentication Required)
// ========================================================

/**
 * @route GET /api/v1/reviews/product/:productId
 * @desc Get all published reviews for a specific product
 * @access Public
 */
router.get(
    '/product/:productId',
    validate(productIdParam, 'params'), 
    validate(publicListQuerySchema, 'query'),
    reviewController.listForProduct
);

/**
 * @route GET /api/v1/reviews/:reviewId
 * @desc Get a single review by ID (Public only sees 'published' status)
 * @access Public/Authenticated 
 */
router.get(
    '/:reviewId',
    validate(reviewIdParam, 'params'), 
    reviewController.getReviewById
);


// ========================================================
// 2. AUTHENTICATED USER ROUTES (Requires Login)
// ========================================================

router.use(authenticate); // All routes below this line require a valid token

/**
 * @route POST /api/v1/reviews
 * @desc Create a new review
 * @access Private (Authenticated User)
 */
router.post(
    '/',
    validate(createReviewSchema, 'body'),
    // Sanitize user-provided text content (title, text, review compatibility field)
    sanitizeInput(['title', 'text', 'review']), 
    reviewController.createReview
);

/**
 * @route GET /api/v1/reviews/user/:productId
 * @desc Retrieve the authenticated user's specific review for a product.
 * @access Private (Authenticated User)
 */
router.get(
    '/user/:productId',
    validate(productIdParam, 'params'),
    reviewController.getUserReview
);

/**
 * @route PUT /api/v1/reviews/:reviewId
 * @desc Edit an existing review (Requires review ownership or Admin role).
 * @access Private (Owner or Admin)
 */
router.put(
    '/:reviewId',
    validate(reviewIdParam, 'params'),
    validate(updateReviewSchema, 'body'),
    // Sanitize potential new text content
    sanitizeInput(['title', 'text', 'review']), 
    reviewController.editReview
);

/**
 * @route DELETE /api/v1/reviews/:reviewId
 * @desc Delete a review (Requires review ownership or Admin role)
 * @access Private (Owner or Admin)
 */
router.delete(
    '/:reviewId',
    validate(reviewIdParam, 'params'),
    reviewController.removeReview
);

/**
 * @route POST /api/v1/reviews/:reviewId/report
 * @desc Report a review for moderation
 * @access Private (Authenticated User)
 */
router.post(
    '/:reviewId/report',
    validate(reviewIdParam, 'params'),
    validate(reportReviewSchema, 'body'),
    reviewController.reportReview
);


// ========================================================
// 3. ADMIN-ONLY ROUTES (Requires Admin Role)
// ========================================================

router.use(adminOnly); // All routes below this line require the 'admin' role

/**
 * @route GET /api/v1/reviews/admin
 * @desc List ALL reviews (including pending/rejected) for the moderation dashboard
 * @access Private (Admin Only)
 */
router.get(
    '/admin',
    validate(adminReviewQuerySchema, 'query'),
    reviewController.listAllReviews
);

/**
 * @route PATCH /api/v1/reviews/:reviewId/status
 * @desc Admin-specific route to update review status and add administrative notes.
 * @access Private (Admin Only)
 */
router.patch(
    '/:reviewId/status',
    validate(reviewIdParam, 'params'),
    validate(adminStatusUpdateSchema, 'body'),
    // Re-use editReview, which is built to handle status updates if isAdmin is true
    reviewController.editReview 
);

module.exports = router;