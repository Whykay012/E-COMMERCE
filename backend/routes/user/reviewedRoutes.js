const express = require('express');
const router = express.Router();

// --- Controllers ---
const reviewController = require('../controller/reviewController');

// --- Validation Schemas ---
const { 
	idSchema,
	createReviewSchema,
	updateReviewSchema,
	publicListQuerySchema
} = require('../model/reviewValidation'); 

// --- Middleware ---
const {validate} = require('../validators/validate'); 
const { globalLimiter, reviewLimiter } = require('../middleware/rateLimiters');
const {authenticate} = require('../middleware/authMiddleware'); 
// NEW: Import the sanitation middleware
const { sanitizeInput } = require('../middleware/sanitizeOutput');


// Apply global rate limiting to all requests
router.use(globalLimiter); 

// ========================================================
// PUBLIC ROUTES
// ========================================================

router.get(
	'/product/:productId',
	validate(idSchema, 'params', { id: 'productId' }),
	validate(publicListQuerySchema, 'query'),
	reviewController.listForProduct
);

// ========================================================
// AUTHENTICATED USER ROUTES
// ========================================================

router.use(authenticate); 

// POST /api/reviews
// Submit a new review
router.post(
	'/', 
	reviewLimiter, 								
	validate(createReviewSchema, 'body'), 		
	sanitizeInput(), // <-- APPLY SANITATION: Cleans 'title' and 'text' before controller
	reviewController.createReview
);

// GET /api/reviews/user/:productId
// Retrieve the authenticated user's review for a product
router.get(
	'/user/:productId',
	validate(idSchema, 'params', { id: 'productId' }),
	reviewController.getUserReview
);

// PUT /api/reviews/:id
// Edit an existing review (owner or admin)
router.put(
	'/:id', 
	validate(idSchema, 'params'), 			
	validate(updateReviewSchema, 'body'), 	
	sanitizeInput(), // <-- APPLY SANITATION: Cleans potentially updated 'title' and 'text'
	reviewController.editReview 			
);

// DELETE /api/reviews/:id
// Delete a review (owner or admin)
router.delete(
	'/:id', 
	validate(idSchema, 'params'), 			
	reviewController.removeReview 			
);


module.exports = router;