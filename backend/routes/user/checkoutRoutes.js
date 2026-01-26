// routes/checkoutRoutes.js

const express = require("express");
const router = express.Router();

// Import Controller
const { createCheckout } = require("../controller/checkoutController"); 

// Import Security/Middleware
const { validate } = require("../middleware/validate"); // Assuming path
const { checkoutBodySchema } = require("../validation/checkoutSchema"); // Assuming path
const { checkoutLimiter } = require("./rateLimiters"); // Assuming path and file name

// 💡 Middleware Placeholders: (Ensure these are imported/defined elsewhere)
const protect = (req, res, next) => {
    // Check for a valid token and attach user to req.user (Crucial for limiter and controller)
    if (!req.user) req.user = { userID: 'mockUserId123' }; 
    next();
}; 

// -----------------------------------------------------------------
// 🛒 Checkout Route Definition
// -----------------------------------------------------------------

/**
 * @route POST /api/v1/checkout
 * @desc Creates a new order, reserves stock, and initiates payment (if online).
 * @access Private
 * * Middleware Stack:
 * 1. Authentication (protect)
 * 2. Rate Limiting (checkoutLimiter) - Ensures max 2 attempts per minute per user.
 * 3. Validation & Sanitization (validate) - Ensures clean, whitelisted input.
 * 4. Idempotency Check and Core Logic (createCheckout)
 */
router.post(
    "/", 
    protect, 
    checkoutLimiter, // 🔥 Rate Limiter added here (User-ID based, post-auth)
    validate(checkoutBodySchema, 'body'), // 🛡️ Joi Validation & Sanitization added here
    createCheckout
);


module.exports = router;