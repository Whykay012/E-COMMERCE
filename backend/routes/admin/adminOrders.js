
// routes/adminRoutes.js
const express = require('express');
const router = express.Router();

// 1. Controllers (Assumed to exist)
const { adminForceLogout } = require('../controller/auth/logoutController');
const userController = require('../controller/admin/userController'); // CRUD/Update logic
const orderController = require('../controller/admin/orderController'); // Order management logic

// 2. Middleware
const { authenticate, adminOnly } = require("../../middleware/authMiddleware");

// Protect all routes
const sanitizeInput = require('../middleware/security/sanitization'); // Sanitation utility

// 3. Validation Middleware (Joi)
const { 
    validateMongoId, 
    validateForceLogoutBody, 
    validateAdminUserUpdate,
    validateUpdateOrderStatus, 
} = require('../validation/adminValidation'); 

// 4. Rate Limiters
const { 
    adminLimiter, 
    strictWriteLimiter 
} = require('../config/rateLimiterConfig'); 


// -----------------------------------------------------------
// 🛡️ Global Admin Middleware 
// (Applied to all routes in this file)
// -----------------------------------------------------------
router.use(authenticate, adminOnly);

router.use(protect, authorize('admin')); // Must be authenticated and have the 'admin' role
router.use(adminLimiter); // Apply strict admin rate limiting

// -----------------------------------------------------------
// 🛠️ User Management Routes (/api/v1/admin/user)
// -----------------------------------------------------------

/**
 * @route POST /api/v1/admin/user/:userId/force-logout
 * @desc Admin forces a target user to revoke all sessions.
 * @access Private/AdminOnly
 */
router.post(
    '/user/:userId/force-logout', 
    validateMongoId, // Validate :userId parameter in params
    strictWriteLimiter,
    validateForceLogoutBody, // Validate reason in body
    sanitizeInput(['reason'], true), // Strictly sanitize the reason field
    adminForceLogout
);

/**
 * @route PATCH /api/v1/admin/user/:userId
 * @desc Admin updates a target user's profile, roles, or verification status.
 * @access Private/AdminOnly
 */
router.patch(
    '/user/:userId', 
    validateMongoId, // Validate :userId parameter in params
    strictWriteLimiter, 
    validateAdminUserUpdate, // Validate body fields (role, isBlocked, etc.)
    // Sanitize user-facing profile fields and the admin reason
    sanitizeInput(['firstName', 'lastName', 'adminReason'], false),
    userController.updateUser
);


// -----------------------------------------------------------
// 📦 Order Management Routes (/api/v1/admin/orders)
// -----------------------------------------------------------

/**
 * @route PATCH /api/v1/admin/orders/:id/status
 * @desc Admin updates the status of an order.
 * @access Private/AdminOnly
 */
router.patch(
    '/orders/:id/status', 
    validateMongoId, // Validate :id parameter
    strictWriteLimiter, 
    validateUpdateOrderStatus, // Validate new status in body
    orderController.updateOrderStatus
);

/**
 * @route GET /api/v1/admin/orders
 * @desc Admin fetches a list of all orders.
 * @access Private/AdminOnly
 */
router.get(
    '/orders', 
    orderController.getAllOrders
);


module.exports = router;