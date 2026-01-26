// address.schema.js

const Joi = require("joi");

const addressBaseSchema = {
    fullName: Joi.string().trim().max(100).required(),
    phone: Joi.string().trim().max(20).required(),
    addressLine1: Joi.string().trim().max(255).required(),
    addressLine2: Joi.string().trim().max(255).allow("").optional(),
    city: Joi.string().trim().max(100).required(),
    state: Joi.string().trim().max(100).required(),
    country: Joi.string().trim().max(100).optional(),
    postalCode: Joi.string().trim().max(20).allow("").optional(),
    isDefault: Joi.boolean().optional(),
};

// --- Schema for POST (CREATE) ---
const createAddressSchema = Joi.object(addressBaseSchema);

// --- Schema for PATCH/PUT (UPDATE) ---
// All fields are optional, and must not allow the user to clear required fields entirely
const updateAddressSchema = Joi.object(
    Object.keys(addressBaseSchema).reduce((acc, key) => {
        // Make all fields optional, but if present, apply the validation rules
        acc[key] = addressBaseSchema[key].optional();
        
        // Ensure required fields cannot be explicitly set to null/empty string if they are essential
        if (["fullName", "phone", "addressLine1", "city", "state"].includes(key)) {
            acc[key] = acc[key].min(1); // Ensure non-empty string if provided
        }
        return acc;
    }, {})
).min(1).messages({ "object.min": "At least one field must be provided to update the address." });


// --- Schema for Params (GET/UPDATE/DELETE) ---
const addressIdParamSchema = Joi.object({
    id: Joi.string().hex().length(24).required().messages({
        "string.hex": "Address ID must be a valid MongoDB hexadecimal string.",
        "string.length": "Address ID must be 24 characters long.",
    }),
});

module.exports = {
    createAddressSchema,
    updateAddressSchema,
    addressIdParamSchema,
};