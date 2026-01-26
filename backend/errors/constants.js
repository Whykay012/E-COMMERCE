// --- Define consolidated ERROR_CODES ---
const ERROR_CODES = {
    // Stock/Product Errors
    PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
    STOCK_CORRECTED: 'STOCK_CORRECTED',
    OUT_OF_STOCK: 'OUT_OF_STOCK',
    
    // Coupon Errors
    COUPON_INVALID: 'COUPON_INVALID',
    COUPON_EXPIRED: 'COUPON_EXPIRED',
    COUPON_MIN_SPEND: 'COUPON_MIN_SPEND',
    COUPON_RESTRICTED_PRODUCTS: 'COUPON_RESTRICTED_PRODUCTS',
    COUPON_USED: 'COUPON_USED' // User-specific usage limit reached
};

module.exports = {
    ERROR_CODES
};