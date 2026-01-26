const express = require('express');
const router = express.Router();

// --- 1. CORE MIDDLEWARE IMPORTS ---
// Assuming these are located in the structure implied by the router's path
const { authenticate, adminOnly } = require('../../middleware/authMiddleware');
const { validate } = require('../../validators/validate'); // The generic Joi validation middleware
const { globalLimiter } = require('../../middleware/rateLimiter'); // General admin/API rate limiter

// --- 2. VALIDATION SCHEMA IMPORTS (Joi objects) ---
const Joi = require("joi");
// Assuming the first provided block is order validation
const { updateOrderStatusSchema } = require('../../validators/orderValidators');
// Assuming the second provided block is admin/general validation
const { IdParamSchema } = require('../../validators/adminValidators');


// --- 3. LOCAL SCHEMA DEFINITION ---
// Recreating the missing schema for the automation trigger endpoint
const triggerAutomationSchema = Joi.object({
    taskName: Joi.string()
        .valid('cancelStaleOrders', 'rebuildCache', 'syncInventory')
        .required()
        .messages({
            'any.only': 'Invalid automation task name provided.',
        }),
}).options({ abortEarly: false, allowUnknown: false });


// Apply protection: Ensures user is authenticated and has admin privileges for all routes
router.use(authenticate, adminOnly);

/* ===========================================================
 * Rate Limiting (Applied to all admin routes)
 * =========================================================== */
router.use(globalLimiter);


// Import the controller functions
const {
    adminDashboard,
    triggerAutomation,
    updateOrderStatusAdmin,
    getFestiveBanners,
    deleteFestiveBanner,
} = require('../../controller/adminController'); 


/* ===========================================================
 * Admin Dashboard & Utility Routes
 * =========================================================== */

/**
 * GET /api/admin/dashboard
 * Fetches the comprehensive administrative dashboard summary.
 */
router.get(
    '/dashboard', 
    adminDashboard
);

/**
 * POST /api/admin/automation/trigger
 * Manually triggers critical background automation tasks.
 * SECURITY: Validate the taskName payload.
 */
router.post(
    '/automation/trigger', 
    validate(triggerAutomationSchema, 'body'),
    triggerAutomation
);


/* ===========================================================
 * Order Management Routes
 * =========================================================== */

/**
 * PATCH /api/admin/orders/:id/status
 * Manually updates the status of a specific order by ID.
 * SECURITY: Validate the ID parameter and the status body field.
 * Note: IdParamSchema validates req.params.body; updateOrderStatusSchema validates req.body.
 */
router.patch(
    '/orders/:id/status', 
    validate(IdParamSchema, 'params'), // Validate ID
    validate(updateOrderStatusSchema, 'body'), // Validate status payload
    updateOrderStatusAdmin
);


/* ===========================================================
 * Banner Management Routes
 * =========================================================== */

/**
 * GET /api/admin/banners
 * Retrieves all festive banners.
 * Optional: Consider adding sanitation here if banner creation involves free text, 
 * but that logic would typically be in the POST/PUT/PATCH routes for banner creation.
 */
router.get(
    '/banners', 
    getFestiveBanners
);

/**
 * DELETE /api/admin/banners/:id
 * Deletes a specific banner by ID.
 * SECURITY: Validate the ID parameter.
 */
router.delete(
    '/banners/:id', 
    validate(IdParamSchema, 'params'), // Validate ID
    deleteFestiveBanner
);


/* ===========================================================
 * EXPORTS
 * =========================================================== */
module.exports = router;