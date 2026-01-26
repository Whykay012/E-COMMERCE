// activityLog.router.js

const express = require("express");
const router = express.Router();

// --- Middleware & Controller Imports ---
const { authenticateUser } = require("../../middleware/authentication"); 
const { listActivities } = require("../../controller/activityLog.controller"); 
const { validate } = require("../../validators/validate"); 
const { listActivitiesQuerySchema } = require("../../validators/activityLogSchema"); 
const { activityLogLimiter } = require("../../middleware/rateLimiter"); // 🔥 Imported new limiter
// const { sanitizeInput } = require("../../middleware/sanitize"); // Optional Sanitization Middleware

/**
 * @route GET /api/v1/activities
 * @desc Get the activity log for the current authenticated user with filters and pagination.
 * @access Private (requires authentication)
 */
router.get(
    "/",
    authenticateUser,                           // 1. Ensure the user is logged in (req.user is set)
    activityLogLimiter,                         // 2. Apply rate limiting (User-based)
    // sanitizeInput(['keyword']),             // 3. Optional: Sanitize specific query fields if necessary
    validate(listActivitiesQuerySchema, "query"), // 4. Validate and sanitize QUERY parameters
    listActivities                              // 5. Execute the controller logic
);

module.exports = router;