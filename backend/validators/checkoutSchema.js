// validation/checkoutSchema.js

const Joi = require("joi");

const VALID_PAYMENT_METHODS = ["online", "wallet", "cod"];

// Schema for the checkout request body
const checkoutBodySchema = Joi.object({
    // 1. paymentMethod (Mandatory, Sanitized, Validated)
    paymentMethod: Joi.string()
        .valid(...VALID_PAYMENT_METHODS)
        .lowercase() // 🔑 Sanitization: Convert to lowercase
        .default("online")
        .required()
        .messages({
            'any.required': 'Payment method is required.',
            'any.only': `Payment method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}.`,
        }),

    // 2. addressId (Mandatory, Validated)
    addressId: Joi.string()
        .hex() // Ensures it's a hex string (common for MongoId without type check)
        .length(24) // Ensures it's a 24-character hex string (standard MongoId length)
        .required()
        .messages({
            'any.required': 'Shipping address ID is required.',
            'string.length': 'Invalid address ID format.',
        }),

    // 3. email (Optional, Sanitized)
    email: Joi.string()
        .email()
        .trim()
        .normalize() // 🔑 Sanitization: Normalize email
        .optional(),

    // 4. currency (Optional, Sanitized)
    currency: Joi.string()
        .trim()
        .uppercase() // 🔑 Sanitization: Convert to uppercase
        .default('NGN')
        .length(3)
        .optional(),
    
    // 5. metadata (Optional, Validated, Sanitized)
    metadata: Joi.object()
        .max(10) // Limit size of metadata object
        .pattern(Joi.string(), Joi.string().max(256)) // Only allow string keys and values
        .optional(),

    // 6. idempotencyKey (Header will be checked, but include in body schema 
    //    if you allow it there, otherwise, Joi's stripUnknown handles it). 
    //    We will rely on the header check in the controller.

}).options({ 
    // 🔑 Sanitization: Remove any extraneous fields from the request body
    stripUnknown: true 
});

module.exports = {
    checkoutBodySchema,
    VALID_PAYMENT_METHODS,
};