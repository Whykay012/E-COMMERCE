const mongoose = require("mongoose");
const { StatusCodes } = require("http-status-codes");
const asyncHandler = require("express-async-handler");
const { setTimeout } = require('node:timers/promises'); // For mock lock release

// Assuming these models exist in the application
const Cart = require("../model/cart");
const Product = require.require("../model/product");

// 🚀 IMPORT DEDICATED SERVICES
const {
    getVariantStock, 
    checkBatchStock, 
    getAndValidateCoupon 
} = require("./ecommerce-service"); 

const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const ForbiddenError = require("../errors/forbiddenError");
const { ERROR_CODES } = require("../errrors/constants"); 

// --- CRITICAL: MOCK DISTRIBUTED LOCK UTILITY ---
// In a real production system, this would be an actual Redis/Zookeeper/Redlock client.
// This mock simulates the locking and release behavior.
const LOCK_TIMEOUT_MS = 3000;
const MOCK_LOCKS = new Map();

const acquireLock = async (resourceKey) => {
    const lockId = mongoose.Types.ObjectId().toString();
    const expiryTime = Date.now() + LOCK_TIMEOUT_MS;

    // Simulate waiting for lock
    while (MOCK_LOCKS.has(resourceKey) && MOCK_LOCKS.get(resourceKey).expiry > Date.now()) {
        await setTimeout(50); // Wait 50ms before retrying
    }

    if (MOCK_LOCKS.has(resourceKey) && MOCK_LOCKS.get(resourceKey).expiry <= Date.now()) {
        // Lock expired, clean up
        MOCK_LOCKS.delete(resourceKey);
    }

    MOCK_LOCKS.set(resourceKey, { id: lockId, expiry: expiryTime });
    return {
        lockId,
        release: () => {
            if (MOCK_LOCKS.get(resourceKey)?.id === lockId) {
                MOCK_LOCKS.delete(resourceKey);
            }
        }
    };
};
// --------------------------------------------------

// --- CORE HELPER FUNCTIONS (Refined) ---

const ensureUserOrGuest = (req) => {
    if (!req.user?.userID && !req.guestID) {
        throw new ForbiddenError("Authentication or a valid guest session is required.");
    }
    return req.user?.userID ? req.user.userID.toString() : req.guestID.toString();
};

const ensureAuth = (req) => {
    if (!req.user?.userID) {
        throw new ForbiddenError("A fully authenticated user is required for this operation.");
    }
    return req.user.userID.toString();
};

const matchItem = (item, productId, color, size) => {
    const itemColor = item.selectedColor || null;
    const itemSize = item.selectedSize || null;
    const targetColor = color || null;
    const targetSize = size || null;

    return (
        item.product.toString() === productId.toString() &&
        itemColor === targetColor &&
        itemSize === targetSize
    );
};

const calculateCartTotal = (items, appliedCoupon = null, taxRate = 0.05, baseShipping = 5.0) => {
    let subtotal = 0;

    for (const item of items) {
        const productPrice = item.product?.price || item.price || 0;
        const effectiveDiscountPercent = item.product?.discount || item.discount || 0;

        const discountedPrice = productPrice * (1 - effectiveDiscountPercent / 100);
        subtotal += discountedPrice * item.quantity;
    }

    let finalCouponDiscount = 0;
    let shippingDiscount = 0;
    let validatedCoupon = appliedCoupon;

    if (validatedCoupon && subtotal > 0) {
        if (subtotal < (validatedCoupon.minSpend || 0)) {
            validatedCoupon = null; 
        } else {
            if (validatedCoupon.appliesToShipping) {
                shippingDiscount = validatedCoupon.discountValue;
            }

            if (validatedCoupon.discountType === 'fixed') {
                finalCouponDiscount = Math.min(validatedCoupon.discountValue, subtotal);
            } else if (validatedCoupon.discountType === 'percentage') {
                finalCouponDiscount = subtotal * (validatedCoupon.discountValue / 100);
            }
        }
    }

    const totalDiscount = finalCouponDiscount;
    const discountedSubtotal = subtotal - totalDiscount;

    const isFreeShippingRule = discountedSubtotal >= 100;
    let shipping = isFreeShippingRule ? 0 : baseShipping;

    shipping = Math.max(0, shipping - shippingDiscount);

    const taxableBase = discountedSubtotal;
    const tax = taxableBase * taxRate;

    const finalTotal = discountedSubtotal + tax + shipping;

    return {
        subtotal: parseFloat(subtotal.toFixed(2)),
        cartDiscount: parseFloat(totalDiscount.toFixed(2)),
        discountedSubtotal: parseFloat(discountedSubtotal.toFixed(2)),
        shippingCost: parseFloat(shipping.toFixed(2)),
        tax: parseFloat(tax.toFixed(2)),
        finalTotal: parseFloat(finalTotal.toFixed(2)),
        appliedCoupon: validatedCoupon,
        taxRate: taxRate,
    };
};

const getCartAndClean = async (identifier) => {
    let cart = await Cart.findOne({ user: identifier }).populate("items.product");

    if (!cart) {
        return { cart: new Cart({ user: identifier, items: [], coupon: null }), cleaned: false, stockErrors: [] };
    }

    let cleaned = false;
    let couponNeedsRemoval = false;

    const itemsToCheck = cart.items.map(item => ({
        product: item.product._id,
        quantity: item.quantity,
        selectedColor: item.selectedColor,
        selectedSize: item.selectedSize
    }));

    const { validatedItems, stockErrors } = await checkBatchStock(itemsToCheck);
    
    if (validatedItems.length !== cart.items.length || stockErrors.length > 0) {
        cleaned = true;
    }

    cart.items = validatedItems.map(validated => {
        const item = cart.items.find(i => matchItem(i, validated.product, validated.selectedColor, validated.selectedSize)) || {};
        // Use the validated fields (price, discount) which are authoritative
        return {
            ...item.toObject(), 
            product: validated.product,
            quantity: validated.quantity,
            selectedColor: validated.selectedColor,
            selectedSize: validated.selectedSize,
            discount: validated.discount, 
        };
    });
    
    if (cart.coupon) {
        const itemsForValidation = cart.items.map(item => ({
            product: item.product,
            quantity: item.quantity,
            // Re-use populated/validated price/discount for consistency
            price: item.product.price, 
            discount: item.product.discount || 0
        }));

        const { couponError } = await getAndValidateCoupon(cart.coupon.code, itemsForValidation, identifier);
        if (couponError) {
            couponNeedsRemoval = true;
            cleaned = true;
            console.log(`Cart cleanup: Removing invalid coupon ${cart.coupon.code}. Reason: ${couponError.message}`);
        }
    }

    if (couponNeedsRemoval) {
        cart.coupon = null;
    }

    if (cleaned) {
        await cart.save();
        await cart.populate("items.product");
    }
    
    return { cart, cleaned, stockErrors };
};


// =======================
// CORE USER/GUEST CART ROUTES
// =======================

/**
 * @route GET /api/cart
 * Fetches the user's cart, performs automatic cleanup, and returns the structured total.
 */
const getCart = asyncHandler(async (req, res) => {
    const identifier = ensureUserOrGuest(req);
    const { cart, stockErrors } = await getCartAndClean(identifier);

    res.status(StatusCodes.OK).json({
        items: cart.items,
        coupon: cart.coupon,
        totals: calculateCartTotal(cart.items, cart.coupon),
        notifications: stockErrors.filter(err => err.code !== ERROR_CODES.OUT_OF_STOCK)
    });
});
// --------------------------------------------------

/**
 * @route POST /api/cart
 * **UPGRADED:** Uses Distributed Lock for stock check before transaction commit.
 */
const addToCart = asyncHandler(async (req, res) => {
    const identifier = ensureUserOrGuest(req);
    const { productId, quantity = 1, selectedColor, selectedSize } = req.body;
    const lockKey = `product_stock:${productId.toString()}`;
    let lock = null;

    if (quantity < 1 || !Number.isInteger(quantity)) {
        throw new BadRequestError("Quantity must be a positive integer.");
    }
    
    // 1. Acquire Distributed Lock
    try {
        lock = await acquireLock(lockKey);
    } catch (error) {
        throw new BadRequestError("System is highly busy, please try again in a moment.", { code: ERROR_CODES.BUSY_LOCK_WAIT });
    }
    
    // 2. Pre-Transaction Validation (Optimized Read)
    const { validatedItems, stockErrors } = await checkBatchStock([
        { product: productId, quantity, selectedColor, selectedSize }
    ]);
    
    const hardError = stockErrors.find(e => e.code === ERROR_CODES.PRODUCT_UNAVAILABLE || e.code === ERROR_CODES.OUT_OF_STOCK);
    if (hardError) {
        lock.release(); // Release lock immediately on hard error
        throw new BadRequestError(hardError.message, { code: hardError.code });
    }
    
    const quantityToAdd = validatedItems[0]?.quantity || 0;
    if (quantityToAdd === 0) {
        lock.release();
        throw new BadRequestError("Cannot add item, stock is zero.", { code: ERROR_CODES.OUT_OF_STOCK });
    }
    
    const productData = validatedItems[0];
    const variantStock = productData.stockAvailable;
    
    let session = null;
    try {
        // 3. Start Transaction for Cart Update
        session = await mongoose.startSession();
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' }
        });

        let cart = await Cart.findOne({ user: identifier }).session(session);
        if (!cart) cart = new Cart({ user: identifier, items: [] });

        const existing = cart.items.find(i =>
            matchItem(i, productId, selectedColor, selectedSize)
        );
        
        let finalQuantity;
        
        if (existing) {
            finalQuantity = existing.quantity + quantityToAdd;
            if (finalQuantity > variantStock) {
                // IMPORTANT: Check consolidated quantity against the stock read under lock
                throw new BadRequestError(`Cannot add. Maximum stock limit of ${variantStock} reached for this item.`, { code: ERROR_CODES.STOCK_LIMIT_EXCEEDED });
            }
            existing.quantity = finalQuantity;
            existing.discount = productData.discount; 
        } else {
            // New item, quantity is already verified against stock
            finalQuantity = quantityToAdd;
            cart.items.push({
                product: productId,
                quantity: finalQuantity,
                selectedColor: selectedColor || null,
                selectedSize: selectedSize || null,
                discount: productData.discount,
            });
        }
        
        // 4. Save and Commit
        await cart.save({ session });
        await session.commitTransaction();

        // 5. Release Lock and Respond
        lock.release();
        await cart.populate("items.product");
        res.status(StatusCodes.OK).json({
            message: "Item successfully added to cart.",
            items: cart.items,
            coupon: cart.coupon,
            totals: calculateCartTotal(cart.items, cart.coupon),
            notifications: stockErrors.filter(e => e.code === ERROR_CODES.STOCK_CORRECTED)
        });

    } catch (error) {
        if (session) await session.abortTransaction();
        if (lock) lock.release();
        console.error("addToCart transaction failed:", error);
        throw error;
    } finally {
        if (session) session.endSession();
    }
});

/**
 * @route PUT /api/cart/:productId
 * **UPGRADED:** Uses Distributed Lock for stock check before transaction commit.
 */
const updateCartItem = asyncHandler(async (req, res) => {
    const identifier = ensureUserOrGuest(req);
    const { quantity, selectedColor, selectedSize } = req.body;
    const { productId } = req.params;
    const lockKey = `product_stock:${productId.toString()}`;
    let lock = null;

    if (quantity < 0 || !Number.isInteger(quantity)) {
        throw new BadRequestError("Quantity must be a non-negative integer.");
    }

    if (quantity === 0) {
        return removeCartItem(req, res);
    }
    
    // 1. Acquire Distributed Lock
    try {
        lock = await acquireLock(lockKey);
    } catch (error) {
        throw new BadRequestError("System is highly busy, please try again in a moment.", { code: ERROR_CODES.BUSY_LOCK_WAIT });
    }

    // 2. Pre-Transaction Validation (Optimized Read)
    const { validatedItems, stockErrors } = await checkBatchStock([
        { product: productId, quantity, selectedColor, selectedSize }
    ]);
    
    // Check if the requested quantity caused a correction (which indicates oversell or limit reached)
    const correction = stockErrors.find(e => e.code === ERROR_CODES.STOCK_CORRECTED);
    if (correction) {
        lock.release();
        throw new BadRequestError(correction.message, { 
            code: correction.code, 
            correctedQuantity: correction.correctedQuantity 
        });
    }
    
    const productData = validatedItems[0];

    let session = null;
    try {
        session = await mongoose.startSession();
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' }
        });

        const cart = await Cart.findOne({ user: identifier }).session(session);
        if (!cart) throw new NotFoundError("Cart not found.");

        const item = cart.items.find(i =>
            matchItem(i, productId, selectedColor, selectedSize)
        );

        if (!item) throw new NotFoundError("Item variant not found in cart.");

        // 3. Update item details
        item.quantity = quantity;
        item.discount = productData.discount; 

        // 4. Save and Commit
        await cart.save({ session });
        await session.commitTransaction();

        // 5. Release Lock and Respond
        lock.release();
        await cart.populate("items.product");
        res.status(StatusCodes.OK).json({
            message: "Cart item updated successfully.",
            items: cart.items,
            coupon: cart.coupon,
            totals: calculateCartTotal(cart.items, cart.coupon)
        });

    } catch (error) {
        if (session) await session.abortTransaction();
        if (lock) lock.release();
        console.error("updateCartItem transaction failed:", error);
        throw error;
    } finally {
        if (session) session.endSession();
    }
});

/**
 * @route DELETE /api/cart/:productId
 * Removes a specific item/variant from the cart using $pull operator.
 */
const removeCartItem = asyncHandler(async (req, res) => {
    const identifier = ensureUserOrGuest(req);
    const { productId } = req.params;
    const { selectedColor, selectedSize } = req.body;

    const cart = await Cart.findOneAndUpdate(
        { user: identifier },
        {
            $pull: {
                items: {
                    product: productId,
                    selectedColor: selectedColor || null,
                    selectedSize: selectedSize || null,
                }
            }
        },
        { new: true }
    ).populate("items.product");

    if (!cart) throw new NotFoundError("Cart not found.");

    res.status(StatusCodes.OK).json({
        message: "Item removed from cart.",
        items: cart.items,
        coupon: cart.coupon,
        totals: calculateCartTotal(cart.items, cart.coupon)
    });
});

/**
 * @route DELETE /api/cart
 * **NEW:** Clears all items and the coupon from the cart.
 */
const clearCart = asyncHandler(async (req, res) => {
    const identifier = ensureUserOrGuest(req);

    const result = await Cart.updateOne(
        { user: identifier },
        { $set: { items: [], coupon: null } }
    );

    if (result.matchedCount === 0) {
        return res.status(StatusCodes.OK).json({ 
            message: "No cart found to clear.",
            items: [],
            coupon: null,
            totals: calculateCartTotal([], null) 
        });
    }

    res.status(StatusCodes.OK).json({
        message: "Your cart has been cleared.",
        items: [],
        coupon: null,
        totals: calculateCartTotal([], null)
    });
});

/**
 * @route POST /api/cart/coupon
 * Applies a coupon code to the cart using the dedicated service.
 */
const applyCoupon = asyncHandler(async (req, res) => {
    const identifier = ensureUserOrGuest(req);
    const { code } = req.body;

    if (!code) {
        throw new BadRequestError("Coupon code is required.");
    }

    // 1. Get Cart and Clean/Validate Items
    const { cart } = await getCartAndClean(identifier);
    if (cart.items.length === 0) {
        throw new BadRequestError("Cannot apply coupon to an empty cart.");
    }

    // 2. Prepare items for coupon validation service
    const itemsForValidation = cart.items.map(item => ({
        product: item.product._id,
        quantity: item.quantity,
        price: item.product.price,
        discount: item.product.discount || 0
    }));

    // 3. Validate Coupon against items and user limits (via dedicated service)
    const { validatedCoupon, couponError } = await getAndValidateCoupon(code, itemsForValidation, identifier);

    if (couponError) {
        throw new BadRequestError(couponError.message, { code: couponError.code });
    }

    // 4. Apply and Save (store minimal data on the cart)
    cart.coupon = {
        code: validatedCoupon.code,
        discountValue: validatedCoupon.discountValue,
        discountType: validatedCoupon.discountType,
        appliesToShipping: validatedCoupon.appliesToShipping || false,
        minSpend: validatedCoupon.minSpend || 0
    };

    await cart.save();

    const finalCalculation = calculateCartTotal(cart.items, cart.coupon);

    res.status(StatusCodes.OK).json({
        message: `Coupon ${code} applied successfully!`,
        coupon: cart.coupon,
        items: cart.items,
        totals: finalCalculation
    });
});

/**
 * @route DELETE /api/cart/coupon
 * Removes the currently applied coupon from the cart.
 */
const removeCoupon = asyncHandler(async (req, res) => {
    const identifier = ensureUserOrGuest(req);

    const cart = await Cart.findOneAndUpdate(
        { user: identifier, coupon: { $ne: null } },
        { $set: { coupon: null } },
        { new: true }
    ).populate("items.product");

    // If cart is found, recalculate and return. If not found, return empty cart status.
    const items = cart?.items || [];
    const totals = calculateCartTotal(items, null);

    res.status(StatusCodes.OK).json({
        message: "Coupon removed successfully.",
        coupon: null,
        items: items,
        totals: totals
    });
});

/**
 * @route POST /api/cart/sync
 * Syncs a client-side cart (e.g., from local storage) with the database, performing server-side validation.
 */
const syncCart = asyncHandler(async (req, res) => {
    const identifier = ensureUserOrGuest(req);
    const { items: incomingItems } = req.body;

    // 1. Perform efficient batch validation on incoming items
    const { validatedItems, stockErrors } = await checkBatchStock(incomingItems);

    let cart = await Cart.findOne({ user: identifier });
    if (!cart) cart = new Cart({ user: identifier, items: [] });
    
    // 2. Consolidate items that map to the same variant (e.g., if client sent two "red-small" products)
    const finalItemsMap = new Map();
    for(const item of validatedItems) {
        const pId = item.product.toString();
        const color = item.selectedColor || null;
        const size = item.selectedSize || null;
        const mapKey = `${pId}-${color}-${size}`;
        
        const existing = finalItemsMap.get(mapKey);

        if (existing) {
            // Re-check aggregated quantity against stock
            const newQuantity = existing.quantity + item.quantity;
            const finalQuantity = Math.min(newQuantity, item.stockAvailable);
            
            // Log error if quantity was capped by the sum
            if (newQuantity > finalQuantity) {
                stockErrors.push({
                    productId: pId,
                    code: ERROR_CODES.STOCK_LIMIT_EXCEEDED,
                    message: `Combined quantity for variant ${mapKey} was capped at max available stock: ${item.stockAvailable}.`
                });
            }

            existing.quantity = finalQuantity;

        } else {
            // New entry, already stock checked
            finalItemsMap.set(mapKey, {
                product: item.product,
                quantity: item.quantity,
                selectedColor: item.selectedColor,
                selectedSize: item.selectedSize,
                discount: item.discount,
            });
        }
    }
    
    // Set the new items, preserving coupon if it was there
    cart.items = Array.from(finalItemsMap.values()).filter(i => i.quantity > 0);

    // Re-validate coupon against the new cart items
    if (cart.coupon && cart.items.length > 0) {
        const itemsForValidation = cart.items.map(item => ({
            product: item.product,
            quantity: item.quantity,
            price: item.price, 
            discount: item.discount
        }));
        
        const { couponError } = await getAndValidateCoupon(cart.coupon.code, itemsForValidation, identifier);
        if (couponError) {
            cart.coupon = null;
            stockErrors.push({ code: ERROR_CODES.COUPON_REMOVED, message: `Applied coupon removed during sync: ${couponError.message}` });
        }
    }

    await cart.save();
    await cart.populate("items.product");
    res.status(StatusCodes.OK).json({
        message: `Cart synced. ${cart.items.length} unique items validated.`,
        items: cart.items,
        coupon: cart.coupon,
        totals: calculateCartTotal(cart.items, cart.coupon),
        notifications: stockErrors
    });
});

/**
 * @route POST /api/cart/merge/:guestId
 * Merges a guest cart into an authenticated user's cart upon sign-in.
 */
const mergeCarts = asyncHandler(async (req, res) => {
    const userId = ensureAuth(req); 
    const { guestId } = req.params;

    if (userId === guestId) {
        throw new BadRequestError("Cannot merge a cart with itself.");
    }

    let session = null;
    try {
        session = await mongoose.startSession();
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' }
        });

        // 1. Fetch Carts within Transaction (unpopulated is faster inside TX)
        const [userCart, guestCart] = await Promise.all([
            Cart.findOne({ user: userId }).session(session),
            Cart.findOne({ user: guestId }).session(session),
        ]);

        if (!guestCart || guestCart.items.length === 0) {
            await session.commitTransaction();
            // Fallback to getCartAndClean to ensure existing user cart is fully processed
            const { cart: finalCart } = await getCartAndClean(userId); 
            return res.status(StatusCodes.OK).json({
                message: "No guest cart to merge. User cart returned.",
                items: finalCart.items,
                coupon: finalCart.coupon,
                totals: calculateCartTotal(finalCart.items, finalCart.coupon)
            });
        }
        
        // 2. Prepare items from both carts for batch validation (outside transaction)
        const allItems = [
            ...(userCart ? userCart.items : []),
            ...guestCart.items
        ];
        
        const itemsToValidate = allItems.map(item => ({
            product: item.product,
            quantity: item.quantity,
            selectedColor: item.selectedColor,
            selectedSize: item.selectedSize
        }));
        
        // 3. Batch Stock Validation (Service handles finding current stock/price/discount)
        const { validatedItems, stockErrors } = await checkBatchStock(itemsToValidate);

        // 4. Consolidate validated items (handles duplicates and final stock check)
        const consolidatedMap = new Map();
        for (const item of validatedItems) {
            const mapKey = `${item.product.toString()}-${item.selectedColor || null}-${item.selectedSize || null}`;
            
            // Use the stock available from the latest check
            const variantStock = item.stockAvailable; 
            
            const currentEntry = consolidatedMap.get(mapKey);
            
            let finalQuantity;
            if (currentEntry) {
                // If it's a duplicate entry (from user cart + guest cart), sum quantities
                finalQuantity = Math.min(currentEntry.quantity + item.quantity, variantStock);
            } else {
                // First entry for this variant, quantity is already capped by checkBatchStock
                finalQuantity = item.quantity;
            }

            consolidatedMap.set(mapKey, {
                product: item.product,
                quantity: finalQuantity, 
                selectedColor: item.selectedColor,
                selectedSize: item.selectedSize,
                discount: item.discount,
            });
        }
        
        const finalItems = Array.from(consolidatedMap.values()).filter(i => i.quantity > 0);
        
        let finalCart = userCart || new Cart({ user: userId, items: [] });

        // 5. Update Cart Document
        finalCart.items = finalItems;
        // Merge coupon: User's coupon takes priority, otherwise use guest's
        finalCart.coupon = userCart?.coupon || guestCart.coupon;
        
        // Re-validate final coupon
        if (finalCart.coupon) {
            const itemsForValidation = finalCart.items.map(item => ({
                product: item.product,
                quantity: item.quantity,
                price: item.price, 
                discount: item.discount
            }));
            const { couponError } = await getAndValidateCoupon(finalCart.coupon.code, itemsForValidation, userId);
            if (couponError) {
                finalCart.coupon = null;
                stockErrors.push({ code: ERROR_CODES.COUPON_REMOVED, message: `Merged coupon was invalid: ${couponError.message}` });
            }
        }


        // 6. Atomically save the final user cart and delete the guest cart
        await finalCart.save({ session });
        await Cart.deleteOne({ user: guestId }).session(session);

        await session.commitTransaction();

        // 7. Populate and Response
        await finalCart.populate("items.product");
        res.status(StatusCodes.OK).json({
            message: "Guest cart merged successfully.",
            items: finalCart.items,
            coupon: finalCart.coupon,
            totals: calculateCartTotal(finalCart.items, finalCart.coupon),
            notifications: stockErrors
        });

    } catch (error) {
        if (session) await session.abortTransaction();
        console.error("mergeCarts transaction failed:", error);
        throw error;
    } finally {
        if (session) session.endSession();
    }
});

// =======================
// ADMIN CART ROUTES
// =======================

/**
 * @route GET /api/admin/carts
 * Admin route to view all carts with mandatory pagination and sorting.
 */
const getAllCarts = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const sort = req.query.sort || '-updatedAt';
    const skip = (page - 1) * limit;

    const [carts, count] = await Promise.all([
        Cart.find({})
            .skip(skip)
            .limit(limit)
            .sort(sort)
            .select('user items.quantity items.product items.selectedColor items.selectedSize coupon updatedAt')
            .populate("user", "email firstName")
            .lean(),

        Cart.countDocuments({})
    ]);

    // Admin view optimization: Calculate totals for oversight
    const cartsWithTotals = carts.map(cart => ({
        ...cart,
        // Since product details are not populated, we need placeholder data for calc to work
        totals: calculateCartTotal(cart.items.map(item => ({ ...item, price: 1, discount: item.discount })), cart.coupon)
    }));

    res.status(StatusCodes.OK).json({
        carts: cartsWithTotals,
        count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
    });
});

/**
 * @route GET /api/admin/carts/:identifier
 * Admin route to view a specific user's cart by their ID.
 */
const getCartByIdentifier = asyncHandler(async (req, res) => {
    const { identifier } = req.params;

    // Use getCartAndClean to ensure admin always sees a clean and valid state
    const { cart } = await getCartAndClean(identifier);

    if (cart.isNew) {
          return res.status(StatusCodes.NOT_FOUND).json({ message: "Cart not found for this identifier." });
    }

    res.status(StatusCodes.OK).json({
        cart,
        totals: calculateCartTotal(cart.items, cart.coupon)
    });
});

/**
 * @route DELETE /api/admin/carts/clear/:identifier
 * Admin route to clear a specific user's cart.
 */
const clearCartForIdentifier = asyncHandler(async (req, res) => {
    const { identifier } = req.params;

    const result = await Cart.updateOne(
        { user: identifier },
        { $set: { items: [], coupon: null } },
        { runValidators: true }
    );

    if (result.matchedCount === 0) {
        return res.status(StatusCodes.NOT_FOUND).json({ message: "Cart not found for this identifier." });
    }

    res.status(StatusCodes.OK).json({ message: `Cart cleared for identifier ${identifier}.` });
});

/**
 * @route POST /api/admin/carts/refresh-discounts
 * Admin route to update the stored discount for all cart items based on current product discounts.
 */
const refreshCartDiscounts = asyncHandler(async (req, res) => {
    const bulkOps = [];
    let cartsUpdatedCount = 0;

    // 1. Find all active products and map their current discounts (optimized read)
    const products = await Product.find({ isActive: true }).select('discount').lean();
    const discountMap = new Map(products.map(p => [p._id.toString(), p.discount || 0]));

    // 2. Iterate through all carts using a cursor (low memory overhead for millions of documents)
    const cursor = Cart.find({}).cursor();
    for (let cart = await cursor.next(); cart != null; cart = await cursor.next()) {
        let needsUpdate = false;

        const updatedItems = cart.items.map(item => {
            const currentProductDiscount = discountMap.get(item.product.toString());

            // Check if product exists in our map and discount is different
            if (currentProductDiscount !== undefined && item.discount !== currentProductDiscount) {
                needsUpdate = true;
                return { ...item.toObject(), discount: currentProductDiscount };
            }
            return item.toObject();
        });

        if (needsUpdate) {
            bulkOps.push({
                updateOne: {
                    filter: { _id: cart._id },
                    update: { $set: { items: updatedItems } }
                }
            });
            cartsUpdatedCount++;
        }
    }

    if (bulkOps.length > 0) {
        // 3. Execute the bulk write operation (highly efficient single database command)
        await Cart.bulkWrite(bulkOps, { ordered: false });
    }

    res.status(StatusCodes.OK).json({
        message: `Cart item discounts refreshed. ${cartsUpdatedCount} carts were processed and updated.`,
        updatedCount: cartsUpdatedCount
    });
});

// =======================
// EXPORT ALL
// =======================

module.exports = {
getCart,
    addToCart,
    updateCartItem,
    removeCartItem,
    clearCart, // NEW FUNCTIONALITY
    applyCoupon,
    removeCoupon,
    syncCart,
    mergeCarts,
    // Admin Routes
    getAllCarts,
    getCartByIdentifier,
    clearCartForIdentifier,
    refreshCartDiscounts,
};