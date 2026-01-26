const Joi = require("joi");
const { BSON } = require("bson"); // For validating MongoDB ObjectIDs

// Schema for Admin GET All Reviews Query Parameters
const adminReviewQuerySchema = Joi.object({
    status: Joi.string()
        .valid("pending", "published", "hidden", "flagged")
        .default('all') // Use a default if you want to query all by default
        .description("Filter reviews by status."),

    limit: Joi.number()
        .integer()
        .min(1)
        .max(100) // Define reasonable bounds
        .default(25)
        .description("Number of results per page."),

    page: Joi.number()
        .integer()
        .min(1)
        .default(1)
        .description("Page number for pagination."),

    // Note: Joi.string().custom() is the best way to validate Mongoose/Mongo IDs
    product: Joi.string()
        .custom((value, helpers) => {
            if (!BSON.ObjectID.isValid(value)) {
                return helpers.error('any.invalid', { message: 'Invalid MongoDB ObjectId format.' });
            }
            return value;
        }, 'MongoDB ID Validation')
        .description("Filter reviews by product ID.")

    // Any other query params (sort, fields, etc.) go here
}).allow(null); // Allow the query object to be empty

// Export the schema
module.exports = {
    adminReviewQuerySchema
};