const express = require('express');
const router = express.Router();

// --- CORE MIDDLEWARE IMPORTS ---
const { authenticate, adminOnly } = require('../../middleware/authMiddleware');
const { validate } = require('../../validators/validation'); // Joi validation middleware
const { globalLimiter } = require('../../middleware/rateLimiter'); // Global IP Rate Limiter

// --- VALIDATION SCHEMA IMPORTS ---
const { 
    IdParamSchema, 
    userListQuerySchema, 
    updateUserRoleSchema 
} = require('../../validators/admin.validators');

// --- CONTROLLER IMPORTS ---
const { 
    getAllUsers, 
    getUserDetails, 
    updateUserRole, 
    toggleUserStatus, 
    softDeleteUser, 
    hardDeleteUser 
} = require('../../controller/adminUserController.js');


// Apply common security middleware for all user admin routes
router.use(authenticate, adminOnly, globalLimiter);


/* ===========================================================
 * LISTING & DETAILS
 * =========================================================== */

/**
 * GET /api/admin/users
 * Retrieves a paginated list of users with filtering and sorting capabilities.
 */
router.get(
    '/', 
    validate(userListQuerySchema, 'query'),
    getAllUsers
);

/**
 * GET /api/admin/users/:id
 * Retrieves comprehensive details for a single user.
 */
router.get(
    '/:id', 
    validate(IdParamSchema, 'params'),
    getUserDetails
);


/* ===========================================================
 * ADMIN ACTIONS
 * =========================================================== */

/**
 * PUT /api/admin/users/:id/role
 * Updates a user's role (e.g., user, admin).
 */
router.put(
    '/:id/role', 
    validate(IdParamSchema, 'params'),
    validate(updateUserRoleSchema, 'body'),
    updateUserRole
);

/**
 * PATCH /api/admin/users/:id/status
 * Toggles user status (e.g., active/inactive/banned).
 */
router.patch(
    '/:id/status', 
    validate(IdParamSchema, 'params'),
    // Note: Assuming a simple Joi schema for { isActive: Joi.boolean() } is applied here 
    // or handled within the controller for boolean check only.
    toggleUserStatus
);


/* ===========================================================
 * DELETION
 * =========================================================== */

/**
 * DELETE /api/admin/users/:id
 * Performs a SOFT DELETE (hides user, retains data for audit/restore).
 */
router.delete(
    '/:id', 
    validate(IdParamSchema, 'params'),
    softDeleteUser
);

/**
 * DELETE /api/admin/users/:id/hard
 * Performs a HARD DELETE (permanent removal - restricted to super admin).
 */
router.delete(
    '/:id/hard', 
    validate(IdParamSchema, 'params'),
    hardDeleteUser
);


/* ===========================================================
 * EXPORTS
 * =========================================================== */
module.exports = router;