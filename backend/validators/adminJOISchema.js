// validation/adminValidation.js
const Joi = require("joi");
const { validate } = require("./validation"); // Assuming validation utility exists

// --------------------------------------------------------------------------------
// ⚙️ Constants
// --------------------------------------------------------------------------------

// List of allowed statuses for administrative order update
const allowedStatuses = [
    "pending",
    "paid",
    "confirmed",
    "processing",
    "shipped",
    "in_transit",
    "out_for_delivery",
    "delivered",
    "cancelled",
    "refunded",
];

// List of allowed user roles
const allowedRoles = ["user", "manager", "admin", "superadmin"];

// --------------------------------------------------------------------------------
// 1. Order Status Update Schema (Body Validation)
// --------------------------------------------------------------------------------
const updateOrderStatusSchema = Joi.object({
    status: Joi.string()
        .valid(...allowedStatuses)
        .required()
        .messages({
            "any.only": `Order status must be one of: ${allowedStatuses.join(", ")}`,
            "any.required": "Order status is required.",
        }),
});

// --------------------------------------------------------------------------------
// 2. MongoDB ID Schema (Params Validation)
// --------------------------------------------------------------------------------
const mongoIdSchema = Joi.object({
    id: Joi.string()
        .hex()
        .length(24)
        .required()
        .messages({
            "string.hex": "ID must be a valid MongoDB hexadecimal string.",
            "string.length": "ID must be 24 characters long.",
        }),
});

// --------------------------------------------------------------------------------
// 3. Admin Force Logout Schema (Body Validation)
// --------------------------------------------------------------------------------
const forceLogoutSchema = Joi.object({
    // Reason is mandatory for audit logging a security action
    reason: Joi.string()
        .trim()
        .min(5)
        .max(255)
        .required()
        .messages({
            'any.required': 'A reason is required for forcing a user logout for audit purposes.',
            'string.min': 'Reason must be at least 5 characters long.'
        }),
});

// --------------------------------------------------------------------------------
// 4. Admin User Update Schema (PATCH Body Validation)
// --------------------------------------------------------------------------------
const adminUserUpdateSchema = Joi.object({
    // Standard profile fields (optional)
    firstName: Joi.string().trim().max(50).min(2).optional(),
    lastName: Joi.string().trim().max(50).min(2).optional(),
    email: Joi.string().email({ tlds: { allow: true } }).optional(),

    // Admin-specific, sensitive fields (optional)
    role: Joi.string()
        .valid(...allowedRoles)
        .optional()
        .messages({
            "any.only": `Role must be one of: ${allowedRoles.join(", ")}`,
        }),

    isVerified: Joi.boolean().optional(),
    isBlocked: Joi.boolean().optional(),
    
    // Admin reason for action (Good audit practice)
    adminReason: Joi.string()
        .trim()
        .min(10)
        .max(500)
        .optional()
        .messages({
            'string.min': 'Admin reason must be at least 10 characters long if provided.'
        }),
    
    // Explicitly prohibit changing password via this general endpoint
    password: Joi.forbidden().messages({'any.unknown': 'Use the dedicated password reset or update flow.'}),
});


// --------------------------------------------------------------------------------
// 5. Middleware Exports
// --------------------------------------------------------------------------------
const validateUpdateOrderStatus = validate(updateOrderStatusSchema, 'body');
const validateMongoId = validate(mongoIdSchema, 'params');
const validateForceLogoutBody = validate(forceLogoutSchema, 'body');
const validateAdminUserUpdate = validate(adminUserUpdateSchema, 'body');


module.exports = {
    // Schemas
    updateOrderStatusSchema,
    mongoIdSchema,
    forceLogoutSchema,
    adminUserUpdateSchema,

    // Middleware Functions
    validateUpdateOrderStatus,
    validateMongoId,
    validateForceLogoutBody,
    validateAdminUserUpdate, // ⬅️ NEW EXPORT
};