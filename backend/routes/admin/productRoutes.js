const express = require("express");
const router = express.Router();
const { authenticate, adminOnly } = require("../../middleware/authMiddleware");
const { validate } = require("../../middleware/validate");
const sanitizeInput = require("../../middleware/sanitizeInput"); // Import your new middleware
const { 
    IdParamSchema, 
    createProductSchema, 
    updateProductSchema 
} = require("../../validators/admin.validators");

const {
    getProducts,
    getProductById,
    createProduct,
    updateProduct,
    softDeleteProduct,
    restoreProduct,
    hardDeleteProduct,
} = require("../../controller/productController"); 

const {
    productImagesUpload, 
    productVideoUpload, 
} = require("../../validators/uploadValidator"); 

// --- Protect All Routes in this router ---
router.use(authenticate, adminOnly);

// --- Product CRUD Routes ---

// GET all products (uses ListQuerySchema for optional pagination/limit)
router.get("/", validate(require("../../validators/admin.validators").ListQuerySchema, 'query'), getProducts);

// GET product by ID
router.get("/:id", validate(IdParamSchema, 'params'), getProductById);

// POST create product (1. Upload -> 2. Validate -> 3. Sanitize -> 4. Controller)
router.post(
    "/",
    productImagesUpload, 
    productVideoUpload, 
    validate(createProductSchema), 
    // Sanitize relevant string fields (allowing safe formatting like bold/lists)
    sanitizeInput(['name', 'description', 'category', 'brand']), 
    createProduct
);

// PUT update product (1. Validate ID -> 2. Upload -> 3. Validate Body -> 4. Sanitize -> 5. Controller)
router.put(
    "/:id",
    validate(IdParamSchema, 'params'), 
    productImagesUpload, 
    productVideoUpload, 
    validate(updateProductSchema), 
    // Sanitize relevant string fields
    sanitizeInput(['name', 'description', 'category', 'brand']), 
    updateProduct
);

// --- Product Deletion and Restoration Routes ---
router.delete("/soft/:id", validate(IdParamSchema, 'params'), softDeleteProduct); 
router.delete("/purge/:id", validate(IdParamSchema, 'params'), hardDeleteProduct); 
router.put("/restore/:id", validate(IdParamSchema, 'params'), restoreProduct); 

module.exports = router;