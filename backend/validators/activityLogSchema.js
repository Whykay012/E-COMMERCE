// activityLog.schema.js

const Joi = require("joi");
const mongoose = require("mongoose"); // 🔑 Required for the JoiObjectId extension

// =============================================================================
// Custom Joi Extension for MongoDB ObjectId
// Defined to match the controller's implicit requirement for ID validation
// =============================================================================
const JoiObjectId = Joi.extend((joi) => ({
    type: 'objectId',
    base: joi.string(),
    messages: {
        'objectId.invalid': '{{#label}} must be a valid MongoDB ObjectId',
    },
    validate(value, helpers) {
        if (!mongoose.Types.ObjectId.isValid(value)) {
            return { value, errors: helpers.error('objectId.invalid') };
        }
        return value;
    }
}));


/**
 * Schema for validating the query parameters for listing activities.
 * All fields are optional, as they are used for filtering/pagination.
 */
const listActivitiesQuerySchema = Joi.object({
    // Pagination
    page: Joi.number().integer().min(1).default(1).optional().messages({
        "number.base": "Page must be a number.",
        "number.min": "Page number must be at least 1.",
    }),
    limit: Joi.number()
        .integer()
        .min(1)
        .max(100) // Matches MAX_LIMIT in controller
        .default(10)
        .optional()
        .messages({
            "number.base": "Limit must be a number.",
            "number.min": "Limit must be at least 1.",
            "number.max": "Limit cannot exceed 100.",
        }),

    // Filtering (Matches the schema's enum)
    type: Joi.string()
        .valid(
            "login",
            "logout",
            "order",
            "payment",
            "wishlist",
            "profile-update",
            "password-change",
            "address-update",
            "support-ticket",
            "session-revoke"
        )
        .optional()
        .messages({
            "any.only": "Invalid activity type specified.",
        }),

    // 🔑 NEW: Filter by Actor ID (Matches controller's logic: query.actor)
    actorID: JoiObjectId.objectId().optional().messages({
        "objectId.invalid": "Actor ID must be a valid MongoDB ID.",
    }),

    // 🔑 NEW: Filter by Object ID (Matches controller's logic: query.object)
    objectID: JoiObjectId.objectId().optional().messages({
        "objectId.invalid": "Object ID must be a valid MongoDB ID.",
    }),

    // Date Filtering
    startDate: Joi.date().iso().optional().messages({
        "date.iso": "Start Date must be a valid ISO 8601 date string.",
    }),
    endDate: Joi.date().iso().optional().messages({
        "date.iso": "End Date must be a valid ISO 8601 date string.",
    }),

    // Keyword Search
    keyword: Joi.string().trim().min(1).optional(),

    // Sorting
    // Added actorID and objectID as valid fields to sort by.
    // The controller internally handles the special "score" sort.
    sortBy: Joi.string()
        .valid("createdAt", "type", "description", "actor", "object") 
        .default("createdAt")
        .optional(),
    order: Joi.string()
        .valid("asc", "desc")
        .default("desc")
        .optional()
        .messages({
            "any.only": "Order must be 'asc' or 'desc'.",
        }),
});

module.exports = {
    listActivitiesQuerySchema,
};