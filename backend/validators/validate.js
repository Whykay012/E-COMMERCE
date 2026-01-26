const Joi = require("joi");
// Assuming this path is correct for your custom error class
const BadRequestError = require("../errors/bad-request-error"); 

//
// ────────────────────────────────────────────────────────────────────────────────
//  HELPER: FORMAT JOI ERRORS
// ────────────────────────────────────────────────────────────────────────────────
//
/**
 * Transforms Joi error details into a structured JSON object: { "fieldName": "Error message" }
 * This structure is ideal for client-side display (e.g., mapping errors to form fields).
 * @param {Joi.ValidationError} joiError 
 * @returns {Object} Structured error object.
 */
const formatJoiError = (joiError) => {
    return joiError.details.reduce((acc, detail) => {
        const key = detail.path.join("."); // Handles nested paths (e.g., address.street)

        // Clean Joi messages (e.g., removes the field name from the start)
        const cleanMessage = detail.message.replace(/['"]\w+['"]\s+/, "");

        acc[key] = cleanMessage.trim();
        return acc;
    }, {});
};


//
// ────────────────────────────────────────────────────────────────────────────────
//  CORE MIDDLEWARE: JOI VALIDATION
// ────────────────────────────────────────────────────────────────────────────────
//
/**
 * Generic middleware function for Joi validation across any request property.
 * This function also performs input sanitization and whitelisting.
 * @param {Joi.ObjectSchema} schema - The Joi schema to validate against.
 * @param {string} property - The request property to validate (e.g., 'body', 'query', 'params').
 */
function validate(schema, property = "body") {
    return (req, res, next) => {
        const { error, value } = schema.validate(req[property], {
            abortEarly: false,     // Collect all errors for a comprehensive response
            stripUnknown: true,    // REMOVE fields not defined in the schema (SECURITY/WHITELISTING)
            allowUnknown: false,   // Ensure only defined properties are allowed
        });

        if (error) {
            const structuredErrors = formatJoiError(error);

            // Throw BadRequestError (HTTP 400) with structured errors
            throw new BadRequestError(
                "Validation failed. Please correct the fields.",
                structuredErrors
            );
        }

        // IMPORTANT: Override the original request property with the validated, stripped value
        req[property] = value; 
        next();
    };
}


//
// ────────────────────────────────────────────────────────────────────────────────
//  UTILITY: BODY FILTER (STILL USEFUL FOR PARTIAL UPDATES)
// ────────────────────────────────────────────────────────────────────────────────
//
/**
 * Utility function to explicitly whitelist and filter fields for Mongoose partial updates 
 * where running the full Joi schema might be redundant (e.g., in a controller's update logic).
 * @param {Object} obj - The request body object.
 * @param {...string} allowedFields - The fields to keep.
 * @returns {Object} The filtered object.
 */
function filterBody(obj, ...allowedFields) {
    const newObj = {};
    Object.keys(obj).forEach((key) => {
        if (allowedFields.includes(key)) {
            newObj[key] = obj[key];
        }
    });
    return newObj;
}


//
// ────────────────────────────────────────────────────────────────────────────────
//  EXPORTS
// ────────────────────────────────────────────────────────────────────────────────
//
module.exports = {
    validate,
    filterBody,
};