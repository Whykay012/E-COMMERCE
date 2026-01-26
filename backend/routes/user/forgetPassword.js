const express = require('express');
const router = express.Router();

// --- 1. Import Controller ---
// Assuming the module export is the function itself: module.exports = forgotPassword;
const forgotPassword = require('../controller/authController'); 

// --- 2. Import Middleware & Schema ---
// Assuming these are implemented as discussed:
const {validate} = require('../validators/validate'); 
const { forgotPasswordSchema } = require('../validators/authSchema'); 
const {forgotPasswordLimiter} = require("../middleware/rateLimitter")
// ---------------------------------------------------------------------
//                          🔐 PUBLIC AUTH ROUTES
// ---------------------------------------------------------------------

/**
 * @route POST /api/auth/forgot-password
 * @description Initiates the secure password reset process (Non-blocking via Queue).
 * @access Public
 * @middleware Validates the request body contains a valid email format.
 */
router.post(
    '/forgot-password', 
    forgotPasswordLimiter, // 🔥 APPLY RATE LIMITER FIRST (Security Check)
    validate(forgotPasswordSchema), // Validate input
    forgotPassword // Execute controller logic
);

// --- NOTE: Add other authentication routes here (e.g., /login, /register, /reset-password) ---

module.exports = router;