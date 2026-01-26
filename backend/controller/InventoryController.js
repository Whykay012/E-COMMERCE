// --- Conceptual inventoryController.js (FINAL PEAK CONSUMPTION) ---

const { StatusCodes } = require("http-status-codes");
const asyncHandler = require("../middleware/asyncHandler"); 
const Product = require("../model/product"); 
const InventoryAudit = require("../model/InventoryAudit"); 
const mongoose = require('mongoose'); 
const logger = require('../config/logger'); 

// 💡 Service Layer Imports - Consuming all necessary features
const { 
    processAtomicStockUpdate, 
    publishLowStockAlert,
    LOW_STOCK_THRESHOLD // Importing the default/configured threshold
} = require('../services/inventoryService'); 


// --- Helper Functions (Keyset Pagination) ---

const buildCursorQuery = (lastId, direction) => {
    if (!lastId) return {};
    if (direction === 'prev') {
        return { _id: { $lt: lastId } };
    }
    return { _id: { $gt: lastId } };
};


// ---------------------------------------------------------------------
// ----------------------------- CORE INVENTORY (CRUD) -----------------------------
// ---------------------------------------------------------------------

/**
 * @desc Create a new product (Transactional)
 * @route POST /api/v1/admin/inventory
 * @access Private/Admin
 */
const createProduct = asyncHandler(async (req, res) => {
    const { name, description, price, sku, stock, category, brand } = req.body;
    const adminUserId = req.user?._id || 'system_create';
    
    if (price < 0 || stock < 0) {
         return res.status(StatusCodes.BAD_REQUEST).json({ msg: "Price and stock must be non-negative." });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const product = await Product.create([{
            name, description, price, sku, stock, category, brand,
            isVerified: true 
        }], { session });

        const newProduct = product[0];

        await InventoryAudit.create([{
            product: newProduct._id,
            sku: newProduct.sku,
            action: 'CREATED',
            quantityChange: newProduct.stock,
            stockAfter: newProduct.stock,
            adminUser: adminUserId,
            reason: 'New product creation',
        }], { session });

        await session.commitTransaction();
        session.endSession();

        res.status(StatusCodes.CREATED).json({
            msg: `Product '${newProduct.name}' created successfully.`,
            product: newProduct.toObject({ getters: true })
        });
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        logger.error("Transactional Product Creation Error:", { error: err.message });
        if (err.code === 11000) { 
             return res.status(StatusCodes.CONFLICT).json({ msg: `Product with SKU or Name already exists.` });
        }
        throw new Error("Failed to create product atomically.");
    }
});

/**
 * @desc Update Product Metadata (Transactional for consistency)
 * @route PATCH /api/v1/admin/inventory/:productId/metadata
 * @access Private/Admin
 */
const updateProductMetadata = asyncHandler(async (req, res) => {
    const { productId } = req.params;
    const updateFields = req.body;
    
    const forbiddenFields = ['stock', 'price', 'isArchived', 'deletedAt']; 
    const safeUpdate = Object.keys(updateFields).reduce((acc, key) => {
        if (!forbiddenFields.includes(key) && updateFields[key] !== undefined) {
            acc[key] = updateFields[key];
        }
        return acc;
    }, {});

    if (Object.keys(safeUpdate).length === 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: "No valid fields provided for metadata update." });
    }
    
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const updatedProduct = await Product.findByIdAndUpdate(
            productId,
            { $set: safeUpdate },
            { new: true, runValidators: true, session }
        ).lean();

        if (!updatedProduct) {
             await session.abortTransaction();
             session.endSession();
             return res.status(StatusCodes.NOT_FOUND).json({ msg: "Product not found" });
        }
        
        await session.commitTransaction();
        session.endSession();

        res.status(StatusCodes.OK).json({ 
            msg: `Product metadata updated for ${updatedProduct.name}.`,
            product: updatedProduct 
        });
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        logger.error("Transactional Metadata Update Error:", { error: err.message });
        throw new Error("Failed to update product metadata atomically.");
    }
});


/**
 * @desc Get a list of all products in inventory with Keyset Pagination
 * @route GET /api/v1/admin/inventory
 * @access Private/Admin
 */
const getAllInventory = asyncHandler(async (req, res) => {
    const { search, category, limit = 20, lastId, direction = 'next' } = req.query;
    const effectiveLimit = parseInt(limit, 10);
    
    let query = { isArchived: false };
    
    if (search) {
        // NOTE: $regex is kept here but is noted as the scaling bottleneck.
        query.$or = [
            { name: { $regex: search, $options: "i" } },
            { sku: { $regex: search, $options: "i" } },
        ];
    }
    if (category) {
        query.category = category;
    }

    const cursorQuery = buildCursorQuery(lastId, direction);
    query = { ...query, ...cursorQuery };

    const sortOrder = direction === 'prev' ? { _id: -1 } : { _id: 1 };
    
    let inventory = await Product.find(query)
        .sort(sortOrder) 
        .limit(effectiveLimit)
        .lean();

    if (direction === 'prev') {
        inventory = inventory.reverse();
    }
    
    // Keyset pagination logic for prev cursor check
    let prevCursor = null;
    if (inventory.length > 0) {
        const firstId = inventory[0]._id;
        const previousItemExists = await Product.findOne({ isArchived: false, _id: { $lt: firstId } }).sort({ _id: -1 }).limit(1).lean();
        if (previousItemExists) {
             prevCursor = firstId; 
        }
    }

    res.status(StatusCodes.OK).json({
        limit: effectiveLimit,
        nextCursor: inventory.length === effectiveLimit ? inventory[inventory.length - 1]._id : null,
        prevCursor: prevCursor,
        count: inventory.length,
        inventory,
    });
});


// ---------------------------------------------------------------------
// --------------------- ADVANCED STOCK MANAGEMENT ---------------------
// ---------------------------------------------------------------------

/**
 * @desc Production-Ready Stock/Price Update (Delegates to Service Layer)
 * @route PATCH /api/v1/admin/inventory/:productId/stock
 * @access Private/Admin
 */
const updateProductStock = asyncHandler(async (req, res) => {
    const { productId } = req.params;
    // Consume LOW_STOCK_THRESHOLD from the service layer, but allow override via body.
    const { stock, type, reason, referenceId, newPrice, lowStockThreshold = LOW_STOCK_THRESHOLD } = req.body;
    const adminUserId = req.user?._id || 'system_user_id_placeholder'; 

    // Controller's sole job: Input validation
    if (['add', 'subtract', 'set'].includes(type) && (!Number.isInteger(stock) || stock < 0)) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: "Stock quantity must be a non-negative integer." });
    }
    if (newPrice !== undefined && newPrice < 0) {
        return res.status(StatusCodes.BAD_REQUEST).json({ msg: "Price cannot be negative." });
    }
    
    // 👑 PEAK: Call service layer, passing the threshold for internal alert logic.
    const { updatedProduct, stockAfter } = await processAtomicStockUpdate(
        productId, 
        { stock, type, reason, referenceId, newPrice }, 
        adminUserId,
        lowStockThreshold // Pass the threshold to the service for post-commit alerting
    );

    res.status(StatusCodes.OK).json({
        msg: `Stock updated successfully via atomic transaction. Stock is now ${stockAfter}.`,
        product: updatedProduct,
    });
});


// ---------------------------------------------------------------------
// -------------------- ADVANCED AUDITING & ALERTING --------------------
// ---------------------------------------------------------------------

/**
 * @desc Initiate Low Stock Alert Processing (Asynchronous)
 * @route POST /api/v1/admin/inventory/alerts/trigger-low-stock
 * @access Private/Admin
 */
const triggerLowStockAlerts = asyncHandler(async (req, res) => {
    const { threshold = LOW_STOCK_THRESHOLD } = req.body;
    
    // Delegates bulk alert job publishing to service layer
    const jobDetails = await publishLowStockAlert(threshold); 

    res.status(StatusCodes.ACCEPTED).json({
        msg: `Low stock alert job initiated for threshold ${threshold}. Check alerting service logs for details.`,
        jobId: jobDetails.jobId,
        // 💡 VAST: Include idempotency key in response for client-side tracking
        idempotencyKey: jobDetails.idempotencyKey
    });
});

/**
 * @desc Retrieve the full audit history for a single product. (Keyset Pagination)
 * @route GET /api/v1/admin/inventory/:productId/audit
 * @access Private/Admin
 */
const getProductAuditHistory = asyncHandler(async (req, res) => {
    const { productId } = req.params;
    const { limit = 50, lastId } = req.query; 

    let query = { product: productId };
    const effectiveLimit = parseInt(limit, 10);

    // Keyset Pagination: Get documents whose _id is less than the lastId (i.e., older/previous entries)
    if (lastId) {
        query._id = { $lt: lastId }; 
    }

    const auditHistory = await InventoryAudit.find(query)
        .sort({ _id: -1 }) // Sort descending by ID to get the latest first
        .limit(effectiveLimit)
        .populate('adminUser', 'firstName lastName email') 
        .lean();

    const nextLastId = auditHistory.length === effectiveLimit ? auditHistory[auditHistory.length - 1]._id : null;

    res.status(StatusCodes.OK).json({
        count: auditHistory.length,
        nextCursor: nextLastId,
        history: auditHistory,
    });
});

/**
 * @desc Revert Product Stock to a Prior Audit State (Transactional)
 * @route POST /api/v1/admin/inventory/revert/:auditId
 * @access Private/Admin
 */
const revertProductStock = asyncHandler(async (req, res) => {
    const { auditId } = req.params;
    const adminUserId = req.user?._id || 'system_user_id_placeholder'; 
    
    const targetAudit = await InventoryAudit.findById(auditId).lean();

    if (!targetAudit) {
        return res.status(StatusCodes.NOT_FOUND).json({ msg: "Audit log entry not found." });
    }

    const productId = targetAudit.product;
    const desiredStock = targetAudit.stockAfter; // The stock level we are reverting *to*
    
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const currentProduct = await Product.findById(productId).session(session).select('stock sku name').lean();
        
        if (!currentProduct) {
            await session.abortTransaction();
            session.endSession();
            return res.status(StatusCodes.NOT_FOUND).json({ msg: "Product not found during reversion." });
        }
        
        const stockBefore = currentProduct.stock;
        const quantityChange = desiredStock - stockBefore; // Log the change made by the reversion

        const updatedProduct = await Product.findByIdAndUpdate(
            productId,
            { $set: { stock: desiredStock } },
            { new: true, runValidators: true, session } 
        ).select('name sku stock');
        
        // Log the reversion action itself
        await InventoryAudit.create([{
            product: updatedProduct._id,
            sku: updatedProduct.sku,
            action: 'REVERTED',
            quantityChange: quantityChange, 
            stockBefore: stockBefore,
            stockAfter: desiredStock,
            adminUser: adminUserId,
            reason: `Reverted stock to state of audit ID: ${auditId}`,
            referenceId: auditId, 
        }], { session });

        await session.commitTransaction();
        session.endSession();

        logger.warn(`Stock Reverted for ${updatedProduct.sku}. Stock changed from ${stockBefore} to ${desiredStock}.`, { 
            userId: adminUserId, 
            productId: productId, 
            revertAuditId: auditId 
        });

        res.status(StatusCodes.OK).json({
            msg: `Stock successfully reverted. Stock is now ${updatedProduct.stock}.`,
            product: updatedProduct,
            revertedToAuditId: auditId
        });

    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        logger.error("Transactional Stock Reversion Error:", { error: err.message, productId, auditId });
        throw new Error("A system error occurred during the atomic stock reversion."); 
    }
});


// ---------------------------------------------------------------------
// ------------------------- UTILITY & CLEANUP -------------------------
// ---------------------------------------------------------------------

/**
 * @desc Get inventory details for a single product
 * @route GET /api/v1/admin/inventory/:productId
 * @access Private/Admin
 */
const getProductInventory = asyncHandler(async (req, res) => {
    const { productId } = req.params;
    
    const product = await Product.findById(productId).lean(); 

    if (!product || product.isArchived) { 
        return res.status(StatusCodes.NOT_FOUND).json({ msg: "Product not found or is archived" });
    }

    res.status(StatusCodes.OK).json({ product });
});


/**
 * @desc Soft Delete a product (Transactional Logging)
 * @route DELETE /api/v1/admin/inventory/:productId
 * @access Private/Admin
 */
const deleteProduct = asyncHandler(async (req, res) => {
    const { productId } = req.params; 
    const adminUserId = req.user?._id || 'system_archive';
    
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const product = await Product.findByIdAndUpdate(
            productId,
            { $set: { isArchived: true, deletedAt: new Date() } },
            { new: true, session }
        ).select('name sku stock isArchived');

        if (!product) {
            await session.abortTransaction();
            session.endSession();
            return res.status(StatusCodes.NOT_FOUND).json({ msg: "Product not found" });
        }
        
        // Log the archive action
        await InventoryAudit.create([{
            product: product._id,
            sku: product.sku,
            action: 'ARCHIVED',
            quantityChange: 0,
            stockBefore: product.stock,
            stockAfter: product.stock,
            adminUser: adminUserId,
            reason: 'Product archived/soft-deleted',
        }], { session });

        await session.commitTransaction();
        session.endSession();
        
        res.status(StatusCodes.OK).json({ 
            msg: `Product ${product.name} soft-deleted/archived.`,
            product: {
                 _id: product._id,
                 isArchived: product.isArchived
            }
        });
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        logger.error("Transactional Soft Delete Error:", { error: err.message, productId });
        throw new Error("A system error occurred during the atomic soft delete."); 
    }
});


module.exports = {
    createProduct,
    updateProductMetadata, 
    getAllInventory,
    getProductInventory,
    updateProductStock,
    triggerLowStockAlerts, 
    deleteProduct,
    getProductAuditHistory, 
    revertProductStock,
};