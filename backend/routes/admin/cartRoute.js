const express = require('express');
const router = express.Router();
const cartController = require('../controller/cartController'); 

// Middleware Imports
const { validate } = require('../middleware/validation'); 
// 🔑 Import the admin limiter
const { adminLimiter } = require('../middleware/rateLimiters'); 
// const auth = require('../middleware/auth'); // Hypothetical Auth Middleware (REQUIRED)

// Joi Schemas Import (Assuming this path is correct for your consolidated file)
const { 
    adminGetAllCartsQuerySchema, 
    adminIdentifierParamsSchema,
    adminRefreshDiscountsBodySchema // 🔥 Imported the new body schema
} = require('../joi-schemas/validationSchemas'); 


// =========================================================================
// ADMIN ROUTES (/api/admin/carts)
// =========================================================================

// 1. GET / (Fetch All Carts with Pagination/Sorting)
// Validates: req.query
router.get('/', 
    /* auth.admin, */ // Ensure admin authentication middleware is here
    adminLimiter, 
    // 🔥 VALIDATE THE QUERY PARAMETERS (Pagination, Sorting, Filtering)
    validate(adminGetAllCartsQuerySchema, 'query'), 
    cartController.getAllCarts
);

// 2. GET /:identifier (Fetch Specific Cart)
// Validates: req.params
router.get('/:identifier', 
    /* auth.admin, */ 
    adminLimiter,
    // 🔥 VALIDATE THE PARAMETER
    validate(adminIdentifierParamsSchema, 'params'), 
    cartController.getCartByIdentifier
);

// 3. DELETE /clear/:identifier (Admin Cleanup)
// Validates: req.params
router.delete('/clear/:identifier', 
    /* auth.admin, */ 
    adminLimiter,
    // 🔥 VALIDATE THE PARAMETER
    validate(adminIdentifierParamsSchema, 'params'), 
    cartController.clearCartForIdentifier
);

// 4. POST /refresh-discounts (Bulk Update - Heavy Write)
// Validates: req.body
router.post('/refresh-discounts', 
    /* auth.admin, */ 
    adminLimiter,
    // 🔥 VALIDATE THE REQUEST BODY (Targets, flags, filters)
    validate(adminRefreshDiscountsBodySchema, 'body'),
    cartController.refreshCartDiscounts
);

module.exports = router;