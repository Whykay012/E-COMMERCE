const Joi = require("joi");

// --- Reusable Definitions ---

// Defines a required MongoDB ObjectId for parameters
const IdSchema = Joi.string()
    .trim()
    .length(24) // Assuming standard MongoDB ObjectId length
    .required()
    .messages({
        'string.length': 'ID must be a valid 24-character identifier.',
});

// Schema for validating a single ID parameter (e.g., /:id)
const IdParamSchema = Joi.object({
    id: IdSchema.label('ID Parameter'),
}).options({ abortEarly: false, allowUnknown: false });

// Reusable pagination and list query parameters
const ListQuerySchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
}).options({ abortEarly: false, allowUnknown: true });

// --- Specific Schemas ---

/**
 * NEW: Schema for GET /admin/users (Query Parameters)
 * Input: query { page: 1, limit: 20, status: 'active', role: 'user', search: 'john' }
 */
const userListQuerySchema = ListQuerySchema.keys({
    status: Joi.string().valid('active', 'inactive', 'deleted', 'all').default('active'),
    role: Joi.string().valid('user', 'admin', 'moderator', 'editor', 'all').default('all'),
    search: Joi.string().trim().min(2).optional().allow(''), // For filtering by name/email
}).options({ abortEarly: false, allowUnknown: true });


/**
 * Schema for GET /admin/inventory/low-stock
 * Input: query { threshold: 5, limit: 10 }
 */
const lowStockQuerySchema = ListQuerySchema.keys({
    threshold: Joi.number().integer().min(0).default(10),
}).options({ abortEarly: false, allowUnknown: false });


/**
 * Schema for POST /admin/media/delete
 * Input: { publicId: 'product/abc1234' }
 */
const deleteMediaSchema = Joi.object({
    publicId: Joi.string().trim().min(5).required().label('Public ID'),
}).options({ abortEarly: false, allowUnknown: false });

/**
 * Schema for POST /admin/media/replace
 * Input: { publicIdToDelete: 'product/abc1234', folder: 'products' }
 * The new file is handled by Multer middleware and does not need Joi validation.
 */
const replaceMediaSchema = Joi.object({
    publicIdToDelete: Joi.string().trim().min(5).required().label('Public ID to Delete'),
    // Optional: context for the replacement (e.g., target folder)
    folder: Joi.string().trim().optional(),
}).options({ abortEarly: false, allowUnknown: false });


/**
 * NEW: Schema for PUT /admin/users/:id/role
 * Input: { role: 'admin' }
 */
const updateUserRoleSchema = Joi.object({
    role: Joi.string().trim().valid('user', 'admin', 'moderator', 'editor').required().label('New Role'),
}).options({ abortEarly: false, allowUnknown: false });

/**
 * Schema for POST /admin/dashboard/send-notifications
 * Input: { message: 'Alert!', target: 'vips' }
 */
const adminNotificationSchema = Joi.object({
    message: Joi.string().trim().min(10).max(500).required(),
    target: Joi.string().valid('all', 'vips', 'inactive', 'new-users').default('all'),
}).options({ abortEarly: false, allowUnknown: false });


/**
 * Schema for PUT /support/bulk-close
 * Input: { ticketIds: ['id1', 'id2', 'id3'] }
 */
const bulkCloseTicketsSchema = Joi.object({
    ticketIds: Joi.array()
        .items(IdSchema)
        .min(1)
        .max(50) // Limit bulk operation size
        .required()
        .label('Ticket IDs'),
}).options({ abortEarly: false, allowUnknown: false });

/**
 * Schema for POST /loyalty/adjust
 * Input: { userId: 'id', points: 500, reason: 'Manual bonus' }
 */
const adjustLoyaltyPointsSchema = Joi.object({
    userId: IdSchema.label('Target User ID'),
    points: Joi.number().integer().not(0).required().label('Points Adjustment'), // Can be positive or negative
    reason: Joi.string().trim().min(5).max(100).required(),
}).options({ abortEarly: false, allowUnknown: false });

/**
 * Schema for forgotPassword controller (POST /forgot-password)
 * Input: { email: 'user@example.com' }
 */
const forgotPasswordSchema = Joi.object({
    email: Joi.string().email().trim().required(),
}).options({ abortEarly: false, allowUnknown: false });


/**
 * Base Schema for Product Creation and Update
 * Note: Multer handles file fields (images, video). Joi validates the text/data fields.
 */
const productBaseSchema = Joi.object({
    name: Joi.string().trim().min(3).max(150).required(),
    sku: Joi.string().trim().min(3).max(50).required(),
    description: Joi.string().trim().min(10).max(5000).required(),
    price: Joi.number().positive().precision(2).required(),
    stock: Joi.number().integer().min(0).default(0),
    category: Joi.string().trim().min(3).required(),
    brand: Joi.string().trim().min(2).optional(),
    tags: Joi.array().items(Joi.string().trim().min(1)).optional(),
}).options({ abortEarly: false, allowUnknown: false });

const createProductSchema = productBaseSchema;

// For updates, all fields can be optional, but must adhere to type/format if present.
const updateProductSchema = productBaseSchema.keys({
    name: Joi.string().trim().min(3).max(150).optional(),
    sku: Joi.string().trim().min(3).max(50).optional(),
    description: Joi.string().trim().min(10).max(5000).optional(),
    price: Joi.number().positive().precision(2).optional(),
    stock: Joi.number().integer().min(0).optional(),
    category: Joi.string().trim().min(3).optional(),
    brand: Joi.string().trim().min(2).optional(),
}).options({ abortEarly: false, allowUnknown: false });


module.exports = {
    IdSchema,
    IdParamSchema,
    ListQuerySchema,
    userListQuerySchema, // <-- NEW
    lowStockQuerySchema,
    deleteMediaSchema,
    replaceMediaSchema,
    updateUserRoleSchema, // <-- UPDATED/REFINED
    adminNotificationSchema,
    bulkCloseTicketsSchema,
    adjustLoyaltyPointsSchema,
    forgotPasswordSchema,
    createProductSchema,
    updateProductSchema,
};