const express = require('express');
const router = express.Router();
const cartController = require('../controller/cartController'); 

// Middleware & Schemas Imports (Update paths as necessary)
const { validate } = require('../validators/validation'); 
const sanitizeInput = require('../middleware/sanitization'); 
// 🔑 Import the specific limiters from your configuration file
const { globalLimiter, strictWriteLimiter } = require('../middleware/rateLimiters'); 

// Joi Schemas Import (Assuming correct path)
const {
    addToCartSchema,
    updateCartItemBodySchema,
    updateCartItemParamsSchema,
    removeCartItemBodySchema,
    removeCartItemParamsSchema,
    applyCouponSchema,
    syncCartSchema,
    mergeCartsParamsSchema,
} = require('../joi-schemas/cartSchemas'); 

// --- Middleware Configuration ---
const cartItemSanitizer = sanitizeInput(['selectedColor', 'selectedSize'], true);
const couponCodeSanitizer = sanitizeInput(['code'], true);

// =========================================================================
// PUBLIC/AUTHENTICATED ROUTES (/api/cart)
// =========================================================================

// GET / (Lightweight Read)
router.get('/', globalLimiter, cartController.getCart);

// POST / (Add Item)
router.post(
    '/',
    globalLimiter, // General rate limit
    validate(addToCartSchema, 'body'),
    cartItemSanitizer, 
    cartController.addToCart
);

// PUT /:productId (Update Item)
router.put(
    '/:productId',
    globalLimiter, // General rate limit
    validate(updateCartItemParamsSchema, 'params'),
    validate(updateCartItemBodySchema, 'body'),
    cartItemSanitizer, 
    cartController.updateCartItem
);

// DELETE /:productId (Remove Item)
router.delete(
    '/:productId',
    globalLimiter, // General rate limit
    validate(removeCartItemParamsSchema, 'params'),
    validate(removeCartItemBodySchema, 'body'),
    cartController.removeCartItem
);

// DELETE / (Clear Cart)
router.delete(
    '/',
    globalLimiter, // General rate limit
    cartController.clearCart
);

// POST /coupon (Apply Coupon)
router.post(
    '/coupon',
    globalLimiter, // General rate limit
    validate(applyCouponSchema, 'body'),
    couponCodeSanitizer, 
    cartController.applyCoupon
);

// DELETE /coupon (Remove Coupon)
router.delete(
    '/coupon',
    globalLimiter, // General rate limit
    cartController.removeCoupon
);

// POST /sync (Sync Client Cart - Resource Intensive)
router.post(
    '/sync',
    strictWriteLimiter, // Stricter limit (30 reqs/min) for this heavier operation
    validate(syncCartSchema, 'body'),
    cartController.syncCart
);

// POST /merge/:guestId (Merge Carts - Transactional and Heavy)
router.post(
    '/merge/:guestId',
    strictWriteLimiter, // Stricter limit (30 reqs/min) for this heavier operation
    validate(mergeCartsParamsSchema, 'params'),
    cartController.mergeCarts
);

module.exports = router;