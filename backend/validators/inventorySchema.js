// --- Joi Validation Schema (inventorySchema.js) ---

const Joi = require('joi');
const { Types } = require('mongoose');

// Custom Joi type for MongoDB ObjectId validation
const objectId = Joi.custom((value, helpers) => {
    if (!Types.ObjectId.isValid(value)) {
        return helpers.error('any.invalid');
    }
    return value;
}, 'MongoDB ObjectId');


// Base Schemas for reusable parts
const productMetadataSchema = {
    name: Joi.string().trim().max(128).optional(),
    description: Joi.string().max(1024).optional(),
    sku: Joi.string().trim().alphanum().max(50).optional(),
    category: Joi.string().trim().max(50).optional(),
    brand: Joi.string().trim().max(50).optional(),
    isVerified: Joi.boolean().optional(),
    // Note: price and stock are forbidden here and handled by updateStockSchema
};

const paginationQuerySchema = {
    limit: Joi.number().integer().min(1).max(100).default(20).optional(),
    lastId: objectId.optional().description('The MongoDB _id of the last item received for cursor/keyset pagination.'),
    direction: Joi.string().valid('next', 'prev').default('next').optional().description('Pagination direction.'),
    search: Joi.string().trim().max(100).optional().description('Search query for name or SKU.'),
    category: Joi.string().trim().max(50).optional(),
};

// --- Exported Validation Schemas ---
const inventorySchema = {
    
    // POST /api/v1/admin/inventory
    createProduct: {
        body: Joi.object({
            ...productMetadataSchema,
            name: Joi.string().trim().max(128).required(),
            sku: Joi.string().trim().alphanum().max(50).required(),
            price: Joi.number().min(0).precision(2).required(),
            stock: Joi.number().integer().min(0).required(),
            category: Joi.string().trim().max(50).required(),
        }),
    },

    // PATCH /api/v1/admin/inventory/:productId/metadata
    updateProductMetadata: {
        params: Joi.object({
            productId: objectId.required(),
        }),
        body: Joi.object(productMetadataSchema).min(1).messages({
            'object.min': 'At least one valid field (excluding stock and price) must be provided for update.',
        }),
    },

    // PATCH /api/v1/admin/inventory/:productId/stock
    updateProductStock: {
        params: Joi.object({
            productId: objectId.required(),
        }),
        body: Joi.object({
            stock: Joi.number().integer().min(0).optional().description('Quantity to add/subtract or set.'),
            newPrice: Joi.number().min(0).precision(2).optional().description('New price to set.'),
            type: Joi.string().valid('add', 'subtract', 'set').required().description('Type of stock operation.'),
            reason: Joi.string().max(255).required().description('Reason for inventory adjustment/price change.'),
            referenceId: Joi.string().max(100).optional().description('External reference (e.g., order ID, transfer ID).'),
            lowStockThreshold: Joi.number().integer().min(0).optional().description('Override for the low stock threshold for immediate alert.'),
        }).or('stock', 'newPrice').messages({
            'object.or': 'Either "stock" or "newPrice" must be provided for the update.'
        }),
    },

    // GET /api/v1/admin/inventory
    getAllInventory: {
        query: Joi.object(paginationQuerySchema),
    },
    
    // GET /api/v1/admin/inventory/:productId
    getProductInventory: {
        params: Joi.object({
            productId: objectId.required(),
        }),
    },

    // DELETE /api/v1/admin/inventory/:productId
    deleteProduct: {
        params: Joi.object({
            productId: objectId.required(),
        }),
    },

    // POST /api/v1/admin/inventory/alerts/trigger-low-stock
    triggerLowStockAlerts: {
        body: Joi.object({
            threshold: Joi.number().integer().min(1).default(5).optional(),
        }),
    },

    // GET /api/v1/admin/inventory/:productId/audit
    getProductAuditHistory: {
        params: Joi.object({
            productId: objectId.required(),
        }),
        query: Joi.object({
            limit: Joi.number().integer().min(1).max(100).default(50).optional(),
            lastId: objectId.optional().description('The MongoDB _id of the last audit record for cursor pagination (chronologically descending).'),
        }),
    },

    // POST /api/v1/admin/inventory/revert/:auditId
    revertProductStock: {
        params: Joi.object({
            auditId: objectId.required(),
        }),
    },
};

module.exports = inventorySchema;