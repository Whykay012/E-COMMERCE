// controllers/productController.js (TITAN NEXUS: Controller Layer)

const { StatusCodes } = require("http-status-codes");
const yup = require("yup"); 
const asyncHandler = require("../middleware/asyncHandler"); 

// --- 👑 PEAK ZENITH DELEGATION ---
const ProductService = require("../services/productService"); 
const { createSchema, updateSchema, stockSchema } = require("../validation/productSchema"); // <-- Assuming schemas include stock validation

// --- Resilience Imports ---
const { UnauthorizedError, BadRequestError } = require("../errors/customErrors"); 

// -------------------------------
// Read / Query Endpoints (Minimal Logic)
// -------------------------------
exports.getProducts = asyncHandler(async (req, res, next) => {
    // Controller only validates and extracts query parameters
    const queryParams = req.query;
    
    // Delegation: Pass control to the Service Layer for all filtering and DB logic
    const { products, total, page, totalPages } = await ProductService.getProducts(queryParams);

    res.status(StatusCodes.OK).json({
        success: true,
        total,
        page: Number(page),
        totalPages: totalPages,
        products,
    });
});

exports.getRandomProducts = asyncHandler(async (req, res, next) => {
    // 🚀 TITAN NEXUS: Include userId for personalization logic in the service
    const size = Math.min(parseInt(req.query.size) || 10, 50);
    const userId = req.user ? req.user._id.toString() : null; // Pass user ID if authenticated
    
    const products = await ProductService.getRandomProducts(size, userId);
    
    res.status(StatusCodes.OK).json({ success: true, products });
});

exports.getProductById = asyncHandler(async (req, res, next) => {
    const id = req.params.id;

    // Delegation: Service handles validation, population, lookup, and related products logic (with advanced caching).
    const { product, related } = await ProductService.getProductById(id);
    
    res.status(StatusCodes.OK).json({ success: true, product, related });
});

// -------------------------------
// Write / Mutate Endpoints (Delegation & File Handling)
// -------------------------------
exports.createProduct = asyncHandler(async (req, res, next) => {
    // 1. Authorization check
    if (req.user.role !== "admin") {
        throw new UnauthorizedError("Admin access required for product creation.");
    }

    // 2. Validate body (Sync validation done here for fast feedback)
    const validatedPayload = await createSchema.validate(req.body, { abortEarly: false });

    // 3. Extract files and context
    const files = req.files;
    const idempotencyKey = req.headers['x-idempotency-key']; 

    // 4. Delegation: Service handles file uploads, DB creation, and returning sanitized data.
    // The service now expects a destructured object containing files, creatorId, idempotencyKey, and the payload.
    const product = await ProductService.createProduct({
        ...validatedPayload,
        files: files,
        creatorId: req.user._id.toString(), // Ensure ID is a string if the service expects it
        idempotencyKey: idempotencyKey, 
    });

    res.status(StatusCodes.CREATED).json({
        success: true,
        message: "Product created",
        product,
    });
});

exports.updateProduct = asyncHandler(async (req, res, next) => {
    if (req.user.role !== "admin") {
        throw new UnauthorizedError("Admin access required for product update.");
    }

    const id = req.params.id;
    const validatedPayload = await updateSchema.validate(req.body, { abortEarly: false });
    const files = req.files;

    // 🚀 COSMIC UPGRADE: Pass the traceId/requestId from the middleware context (if available)
    const traceId = req.traceId || req.requestId; 

    // Delegation: Service expects 'id', 'files', 'traceId', and the rest as updates.
    // We restructure the payload to match the service's destructured argument signature:
    // updateProduct({ id, files, traceId, ...updates })
    const updatedProduct = await ProductService.updateProduct({
        id,
        ...validatedPayload, // Destructure payload directly as the updates
        files: files,
        traceId: traceId, // Inject tracing context
    });

    res.status(StatusCodes.OK).json({
        success: true,
        message: "Product updated (Media cleanup queued)",
        product: updatedProduct,
    });
});

// -------------------------------
// Stock Management Endpoints (NEW)
// -------------------------------

exports.decrementStock = asyncHandler(async (req, res, next) => {
    // Authorization is typically handled by middleware (e.g., 'inventoryManager' role)
    // For simplicity, we assume an Inventory/Admin role here.
    if (req.user.role !== "admin" && req.user.role !== "inventoryManager") {
        throw new UnauthorizedError("Inventory management access required.");
    }
    
    const id = req.params.id;
    
    // Validate quantity
    const { quantity } = await stockSchema.validate(req.body);
    
    // Delegation: Service handles stock update, concurrency checks, event emission, and cache invalidation.
    const updatedProduct = await ProductService.decrementStock(id, quantity);
    
    res.status(StatusCodes.OK).json({
        success: true,
        message: `Stock decremented by ${quantity}. New stock: ${updatedProduct.stock}`,
        product: updatedProduct,
    });
});

exports.incrementStock = asyncHandler(async (req, res, next) => {
    if (req.user.role !== "admin" && req.user.role !== "inventoryManager") {
        throw new UnauthorizedError("Inventory management access required.");
    }
    
    const id = req.params.id;
    
    // Validate quantity
    const { quantity } = await stockSchema.validate(req.body);
    
    // Delegation
    const updatedProduct = await ProductService.incrementStock(id, quantity);
    
    res.status(StatusCodes.OK).json({
        success: true,
        message: `Stock incremented by ${quantity}. New stock: ${updatedProduct.stock}`,
        product: updatedProduct,
    });
});


// -------------------------------
// Delete and Restore Methods
// -------------------------------

exports.softDeleteProduct = asyncHandler(async (req, res, next) => {
    if (req.user.role !== "admin") {
        throw new UnauthorizedError("Admin access required for product deletion.");
    }

    const id = req.params.id;
    // Query parameters are handled by the controller and passed to the service
    const purgeMedia = req.query.purgeMedia === "true"; 

    // Delegation: Service handles soft-delete, media queue logic, and ensures consistency.
    await ProductService.softDeleteProduct(id, purgeMedia);

    res
        .status(StatusCodes.OK)
        .json({ success: true, message: "Product soft-deleted (Media cleanup queued if purgeMedia=true)" });
});

exports.restoreProduct = asyncHandler(async (req, res, next) => {
    if (req.user.role !== "admin") {
        throw new UnauthorizedError("Admin access required for product restoration.");
    }

    const id = req.params.id;
    
    const product = await ProductService.restoreProduct(id);

    res.status(StatusCodes.OK).json({
        success: true,
        message: "Product restored",
        product,
    });
});

exports.hardDeleteProduct = asyncHandler(async (req, res, next) => {
    if (req.user.role !== "admin") {
        throw new UnauthorizedError("Admin access required for permanent product deletion.");
    }
    
    const id = req.params.id;
    
    // Delegation: Service handles lookup, media cleanup job queuing, and final DB delete.
    await ProductService.hardDeleteProduct(id);

    res
        .status(StatusCodes.OK)
        .json({ success: true, message: "Product permanently deleted (Media cleanup queued)" });
});


// -------------------------------
// Exports
// -------------------------------
module.exports = {
    getProducts: exports.getProducts,
    getRandomProducts: exports.getRandomProducts,
    getProductById: exports.getProductById,
    createProduct: exports.createProduct,
    updateProduct: exports.updateProduct,
    decrementStock: exports.decrementStock, 
    incrementStock: exports.incrementStock, 
    softDeleteProduct: exports.softDeleteProduct,
    restoreProduct: exports.restoreProduct,
    hardDeleteProduct: exports.hardDeleteProduct,
};