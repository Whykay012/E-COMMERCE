// address.router.js

const express = require("express");
const router = express.Router();

// --- Middleware & Controller Imports ---
const { authenticateUser } = require("../middleware/authentication");
const { validate } = require("../middleware/validate");
const sanitizeInput = require("../middleware/sanitizeInput");
const {
    listAddresses,
    getAddress,
    createAddress,
    updateAddress,
    deleteAddress,
} = require("../controller/address.controller");

// NOTE: Assuming address.schema exports these Joi/YUP validation schemas
const {
    createAddressSchema,
    updateAddressSchema,
    addressIdParamSchema,
} = require("./address.schema"); 

// Import the instantiated limiters
const { globalLimiter, checkoutLimiter } = require("../middleware/rateLimiters"); 

// ----------------------------------------------------
// Rate Limiter Rationale:
// - Read (GET): Uses globalLimiter (General IP-based limit)
// - Write (POST/PATCH/DELETE): Uses checkoutLimiter (Strict, User-ID based limit for critical data)
// ----------------------------------------------------

// ## /api/v1/addresses 🏠
// List all addresses & Create a new address
router
    .route("/")
    .get(
        authenticateUser, 
        globalLimiter, // Apply general IP-based read limit
        listAddresses
    )
    .post(
        authenticateUser, 
        checkoutLimiter, // Apply strict, user-based write limit (CRITICAL)
        validate(createAddressSchema, "body"), // Validation 
        sanitizeInput(["fullName", "addressLine1", "addressLine2", "city", "state"]), // Sanitization 
        createAddress
    );

// ## /api/v1/addresses/:id 🗺️
// Get, Update, and Delete single address by ID
router
    .route("/:id")
    .all(
        authenticateUser, 
        // Validate the ID format for all subsequent requests to this route
        validate(addressIdParamSchema, "params")
    )
    .get(
        globalLimiter, // Apply general IP-based read limit
        getAddress
    )
    .patch(
        checkoutLimiter, // Apply strict, user-based write limit
        validate(updateAddressSchema, "body"), 
        sanitizeInput(["fullName", "addressLine1", "addressLine2", "city", "state"]), 
        updateAddress
    )
    .delete(
        checkoutLimiter, // Apply strict, user-based write limit
        deleteAddress
    );

module.exports = router;