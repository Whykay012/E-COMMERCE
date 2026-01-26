// --- Updated Router File (inventoryRoutes.js) with Sanitization and Rate Limiters ---

const express = require('express');
const router = express.Router();
const {
    createProduct,
    updateProductMetadata, 
    getAllInventory,
    getProductInventory,
    updateProductStock,
    triggerLowStockAlerts, 
    deleteProduct,
    getProductAuditHistory, 
    revertProductStock,
} = require('../controller/inventoryController');

// 💡 Middleware Imports
const {adminOnly, authrnticate} = require('../middleware/authMiddleware'); 
const validate = require('../validators/validate');   
const sanitizeBody = require('../middleware/sanitizeInput'); // 💡 NEW: Import the sanitization middleware
const schemas = require('../validators/inventorySchema');
const {
    adminLimiter,
    inventoryWriteLimiter,
    inventoryReadLimiter,
} = require('../config/rateLimiterConfig'); 


// Apply a general admin limiter to all routes in this router as a baseline security measure.
router.use(adminLimiter);


// --- Inventory Core (CRUD & Listing) ---

// POST /api/v1/admin/inventory (Create Product)
router.post(
    '/',
    adminOnly, authrnticate,
    inventoryWriteLimiter, 
    // SANITIZE: name, description (potentially multi-line), category, brand
    sanitizeBody(['name', 'description', 'category', 'brand'], true), // Strict: Admin-input fields should be plain text
    validate(schemas.createProduct),
    createProduct
);

// GET /api/v1/admin/inventory (List Inventory - No Body/Sanitation needed)
router.get(
    '/',
    adminOnly, authrnticate,
    inventoryReadLimiter, 
    validate(schemas.getAllInventory),
    getAllInventory
);

// GET /api/v1/admin/inventory/:productId (Get Single Product Details - No Body/Sanitation needed)
router.get(
    '/:productId',
    adminOnly, authrnticate,
    validate(schemas.getProductInventory),
    getProductInventory
);

// DELETE /api/v1/admin/inventory/:productId (Soft Delete/Archive - No Body/Sanitation needed)
router.delete(
    '/:productId',
    adminOnly, authrnticate,
    inventoryWriteLimiter, 
    validate(schemas.deleteProduct),
    deleteProduct
);


// --- Advanced Stock Management & Metadata ---

// PATCH /api/v1/admin/inventory/:productId/metadata (Update Metadata)
router.patch(
    '/:productId/metadata',
    adminOnly, authrnticate,
    inventoryWriteLimiter, 
    // SANITIZE: name, description, category, brand
    sanitizeBody(['name', 'description', 'category', 'brand'], true), // Strict: Enforce plain text for metadata
    validate(schemas.updateProductMetadata),
    updateProductMetadata
);

// PATCH /api/v1/admin/inventory/:productId/stock (Atomic Stock/Price Update)
router.patch(
    '/:productId/stock',
    adminOnly, authrnticate,
    inventoryWriteLimiter, 
    // SANITIZE: reason (The only free text field)
    sanitizeBody(['reason'], true), // Strict: Stock adjustment reasons should be plain text
    validate(schemas.updateProductStock),
    updateProductStock
);


// --- Auditing & Reversion ---

// GET /api/v1/admin/inventory/:productId/audit (Get Audit History - No Body/Sanitation needed)
router.get(
    '/:productId/audit',
    adminOnly, authrnticate,
    inventoryReadLimiter, 
    validate(schemas.getProductAuditHistory),
    getProductAuditHistory
);

// POST /api/v1/admin/inventory/revert/:auditId (Revert Stock - No Body/Sanitation needed)
router.post(
    '/revert/:auditId',
    adminOnly, authrnticate,
    inventoryWriteLimiter, 
    validate(schemas.revertProductStock),
    revertProductStock
);


// --- Asynchronous Alerting ---

// POST /api/v1/admin/inventory/alerts/trigger-low-stock (Trigger Alert Job - No Body/Sanitation needed)
router.post(
    '/alerts/trigger-low-stock',
    adminOnly, authrnticate,
    inventoryWriteLimiter, 
    validate(schemas.triggerLowStockAlerts),
    triggerLowStockAlerts
);


module.exports = router;