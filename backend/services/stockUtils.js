const Product = require('./model/product'); // Import real Mongoose Models
const Coupon = require('./model/coupon'); // Import real Mongoose Models
const { ERROR_CODES } = require('../errrors/constants'); // Import Error Codes

/**
 * UTILITY: Variant Stock Lookup
 * Retrieves the stock level for a specific product variant based on color and size.
 * This function works on a Mongoose product document (or its .lean() representation).
 */
const getVariantStock = (product, selectedColor, selectedSize) => {
    // Normalize inputs to null if falsy (e.g., undefined, empty string)
    const color = selectedColor || null;
    const size = selectedSize || null;

    // If the product has no variants defined, use the main product stock field.
    if (!product.variants || product.variants.length === 0) {
        return product.stock || 0; 
    }

    // Find the variant that matches both color and size.
    const variant = product.variants.find(v => 
        // Match color (handles cases where both are null/undefined)
        (v.color === color || (!v.color && !color)) &&
        // Match size (handles cases where both are null/undefined)
        (v.size === size || (!v.size && !size))
    );

    // If a variant was explicitly requested (color OR size is present) but not found, stock is zero.
    if ((color || size) && !variant) {
        return 0; 
    }

    // Return the variant's stock, or 0 if somehow stock is null/undefined
    return variant ? variant.stock : 0;
};

/**
 * UTILITY: Batch Stock Check (Optimized Read)
 * Validates a batch of shopping cart items against database stock, price, and status.
 * It uses a single Mongoose query for efficiency.
 * @param {Array<Object>} items - Array of items from the client (product ID, quantity, color, size).
 * @returns {Object} An object containing validated items and a list of errors/corrections.
 */
const checkBatchStock = async (items) => {
    // 1. Collect unique Product IDs for optimization (avoiding duplicate DB calls)
    const productIds = [...new Set(items.map(i => i.product.toString()))];
    
    // 2. Fetch products in a single optimized Mongoose query using .lean() for faster reads
    const products = await Product.find({ _id: { $in: productIds } }).select('variants price stock isActive discount').lean();
    const productMap = new Map(products.map(p => [p._id.toString(), p]));

    const validatedItems = [];
    let stockErrors = [];

    for (const item of items) {
        const product = productMap.get(item.product.toString());
        
        // 3. Validation: Check product existence and status
        if (!product || !product.isActive) {
            stockErrors.push({ productId: item.product, code: ERROR_CODES.PRODUCT_UNAVAILABLE, message: 'Product is deleted or inactive.' });
            continue; // Skip item if unavailable
        }

        const color = item.selectedColor || null;
        const size = item.selectedSize || null;
        const variantStock = getVariantStock(product, color, size);
        
        let quantity = item.quantity;
        
        // 4. Validation: Check stock quantity requested vs. available
        if (quantity > variantStock) {
            if (variantStock > 0) {
                quantity = variantStock; // Auto-correct quantity to max available (SOFT correction)
                stockErrors.push({ 
                    productId: item.product, 
                    code: ERROR_CODES.STOCK_CORRECTED, 
                    message: `Quantity adjusted to maximum available: ${variantStock}.`,
                    correctedQuantity: variantStock
                });
            } else {
                stockErrors.push({ productId: item.product, code: ERROR_CODES.OUT_OF_STOCK, message: 'Item is sold out.' }); // HARD error
                continue; // Skip item if 0 stock
            }
        }
        
        // 5. Build validated item list (using server's authoritative price/discount)
        if (quantity > 0) {
            validatedItems.push({
                product: product._id,
                quantity: quantity,
                selectedColor: color,
                selectedSize: size,
                price: product.price, 
                discount: product.discount || 0,
                stockAvailable: variantStock
            });
        }
    }
    
    return { validatedItems, stockErrors };
};


/**
 * UTILITY: Coupon Validation and Application
 * Fetches a coupon and checks its validity against the current cart state.
 * @param {string} couponCode - The coupon code string.
 * @param {Array<Object>} validatedItems - The list of items after stock check.
 * @param {string} userId - The ID of the current user (required for usage limits).
 * @returns {Object} An object containing the validated coupon object or a coupon error.
 */
const getAndValidateCoupon = async (couponCode, validatedItems, userId) => {
    if (!couponCode) {
        return { validatedCoupon: null, couponError: null };
    }
    
    // 1. Find the Coupon (using uppercase for robust lookups)
    const coupon = await Coupon.findOne({ code: couponCode.toUpperCase() }).lean();
    
    if (!coupon) {
        return { couponError: { code: ERROR_CODES.COUPON_INVALID, message: 'Coupon code is invalid.' } };
    }

    // 2. Check Expiration
    if (coupon.expiresAt && new Date() > coupon.expiresAt) {
        return { couponError: { code: ERROR_CODES.COUPON_EXPIRED, message: 'This coupon has expired.' } };
    }
    
    // 3. Check Minimum Spend based on current subtotal
    const subtotal = validatedItems.reduce((sum, item) => {
        // Calculate subtotal based on price after any existing product discount
        const effectivePrice = item.price * (1 - (item.discount || 0) / 100);
        return sum + (effectivePrice * item.quantity);
    }, 0);

    if (coupon.minSpend > 0 && subtotal < coupon.minSpend) {
        return { 
            couponError: { 
                code: ERROR_CODES.COUPON_MIN_SPEND, 
                message: `Minimum spend of $${coupon.minSpend.toFixed(2)} is required.`
            } 
        };
    }
    
    // 4. Check Product Restrictions
    if (coupon.productRestrictions && coupon.productRestrictions.length > 0) {
        const restrictions = coupon.productRestrictions.map(id => id.toString());
        // Check if AT LEAST ONE item in the cart matches a restricted product ID
        const isProductRestricted = validatedItems.some(item => 
            restrictions.includes(item.product.toString())
        );
        
        // If the coupon has restrictions AND none of the cart items match the restriction list, it's invalid.
        if (!isProductRestricted) {
            return { 
                couponError: { 
                    code: ERROR_CODES.COUPON_RESTRICTED_PRODUCTS, 
                    message: 'Coupon is not valid for any items in your cart.'
                } 
            };
        }
    }
    
    // 5. Check Usage Limits (Crucial for production, but requires a separate "Usage" collection/logic)
    // Placeholder: A real system would query the database here using the userId and couponCode
    // if (coupon.maxUsesPerUser !== -1) { /* Check database usage for this user */ }

    // Coupon is valid
    return { validatedCoupon: coupon, couponError: null };
};


module.exports = {
    getVariantStock,
    checkBatchStock,
    getAndValidateCoupon
};