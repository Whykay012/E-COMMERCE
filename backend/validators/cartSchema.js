const Joi = require('joi');
const mongoose = require('mongoose');

// =============================================================================
// 1. Custom Extensions & Core Schemas (Defined once)
// =============================================================================

// Custom Joi extension for MongoDB ObjectId validation
const JoiObjectId = Joi.extend((joi) => ({
    type: 'objectId',
    base: joi.string(),
    messages: {
        'objectId.invalid': '{{#label}} must be a valid MongoDB ObjectId',
    },
    validate(value, helpers) {
        if (!mongoose.Types.ObjectId.isValid(value)) {
            return { value, errors: helpers.error('objectId.invalid') };
        }
        return value;
    }
}));

// Core Cart Item Schema (Used by POST /addToCart, POST /sync, and internally)
const itemSchema = Joi.object({
    productId: JoiObjectId.objectId().required().label('Product ID'), 
    quantity: Joi.number().integer().min(1).required().label('Quantity'),
    selectedColor: Joi.string().trim().allow(null, '').max(50).optional().label('Color'),
    selectedSize: Joi.string().trim().allow(null, '').max(20).optional().label('Size'),
    
    // Internal reference, useful if sync includes a populated item from a guest session
    product: JoiObjectId.objectId().optional().label('Product ID (Internal)'), 
}).label('Cart Item');


// =============================================================================
// 2. User/Public Cart Schemas (/api/cart)
// =============================================================================

// --- POST /api/cart (addToCart) ---
const addToCartSchema = Joi.object({
    productId: JoiObjectId.objectId().required().label('Product ID'),
    quantity: Joi.number().integer().min(1).default(1).label('Quantity'),
    selectedColor: Joi.string().trim().allow(null, '').max(50).optional().label('Color'),
    selectedSize: Joi.string().trim().allow(null, '').max(20).optional().label('Size'),
}).label('Add To Cart Request');

// --- PUT /api/cart/:productId (updateCartItem) ---
const updateCartItemBodySchema = Joi.object({
    // Note: min(0) allows setting quantity to 0, signaling removal or delegation
    quantity: Joi.number().integer().min(0).required().label('Quantity'), 
    selectedColor: Joi.string().trim().allow(null, '').max(50).optional().label('Color'),
    selectedSize: Joi.string().trim().allow(null, '').max(20).optional().label('Size'),
}).label('Update Cart Item Body');

const cartItemParamsSchema = Joi.object({
    productId: JoiObjectId.objectId().required().label('Product ID'),
}).label('Cart Item Parameters');

// --- DELETE /api/cart/:productId (removeCartItem) ---
// Re-uses cartItemParamsSchema for URL validation
const removeCartItemBodySchema = Joi.object({
    // Body is optional, used for multi-variant removal
    selectedColor: Joi.string().trim().allow(null, '').max(50).optional().label('Color'),
    selectedSize: Joi.string().trim().allow(null, '').max(20).optional().label('Size'),
}).label('Remove Cart Item Body');

// --- POST /api/cart/coupon (applyCoupon) ---
const applyCouponSchema = Joi.object({
    code: Joi.string().trim().uppercase().alphanum().min(3).max(50).required().label('Coupon Code'),
}).label('Apply Coupon Request');

// --- POST /api/cart/sync (syncCart) ---
const syncCartSchema = Joi.object({
    items: Joi.array().items(itemSchema).max(100).required().label('Cart Items Array'), 
}).label('Sync Cart Request');

// --- POST /api/cart/merge/:guestId (mergeCarts) ---
const mergeCartsParamsSchema = Joi.object({
    guestId: Joi.string().trim().required().label('Guest Identifier'),
}).label('Merge Cart Parameters');


// =============================================================================
// 3. Admin Cart Schemas (/api/admin/carts)
// =============================================================================

// --- GET /api/admin/carts (Query Validation for Pagination/Sorting/Filtering) ---
const adminGetAllCartsQuerySchema = Joi.object({
    // --- Pagination ---
    page: Joi.number().integer().min(1).default(1).label('Page Number'),
    limit: Joi.number().integer().min(1).max(100).default(20).label('Limit Per Page'),

    // --- Sorting ---
    sort: Joi.string().trim().valid('createdAt', '-createdAt', 'updatedAt', '-updatedAt', 'totalPrice', '-totalPrice')
          .default('-createdAt').label('Sort Field'),

    // --- Filtering ---
    userId: JoiObjectId.objectId().optional().allow(null, '').label('Filter by User ID'),
    minItems: Joi.number().integer().min(0).optional().label('Minimum Items'),
    maxTotalPrice: Joi.number().min(0).optional().label('Maximum Total Price'),
    status: Joi.string().trim().valid('active', 'expired', 'abandoned').optional().label('Cart Status'),

}).label('Admin Get All Carts Query');

// --- GET /api/admin/carts/:identifier and DELETE /api/admin/carts/:identifier (Params) ---
const adminIdentifierParamsSchema = Joi.object({
    identifier: Joi.string().required().label('Cart Identifier'),
}).label('Admin Cart Identifier Parameters');

// --- POST /api/admin/carts/refresh-discounts (Body Validation) ---
const adminRefreshDiscountsBodySchema = Joi.object({
    // Targets can be a list of user IDs or cart IDs
    targets: Joi.array().items(
        Joi.alternatives().try(
            JoiObjectId.objectId(), // Mongoose ObjectId (e.g., Cart ID or User ID)
            Joi.string().trim()    // Plain string identifier (e.g., Session ID)
        )
    ).min(1).required().label('Target Identifiers Array'),
    
    // Optional flag to control the controller's recalculation logic
    forceRecalculate: Joi.boolean().default(false).label('Force Recalculation'), 
    
    // Optional filter to scope the update operation
    statusFilter: Joi.string().trim().valid('active', 'expired').optional().label('Status Filter'),

}).label('Admin Refresh Discounts Body');


// =============================================================================
// 4. Module Exports
// =============================================================================

module.exports = {
    // User Schemas
    addToCartSchema,
    updateCartItemBodySchema,
    cartItemParamsSchema, // Consolidated name for productId param validation
    removeCartItemBodySchema,
    applyCouponSchema,
    syncCartSchema,
    mergeCartsParamsSchema,
    
    // Admin Schemas
    adminGetAllCartsQuerySchema,
    adminIdentifierParamsSchema,
    adminRefreshDiscountsBodySchema, // Exported the new schema
};