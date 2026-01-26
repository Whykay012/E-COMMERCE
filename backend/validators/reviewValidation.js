const Joi = require("joi");
// IMPORTANT: Assumes BSON library is installed and available in the execution environment
// The BSON object is needed for robust, binary-level MongoDB ObjectID validation.
const { BSON } = require("bson"); 

// Helper function for MongoDB ID validation
const mongoIdValidation = (value, helpers) => {
 // Check if the string is a valid 24-character hex string AND a valid BSON ObjectID
 if (!BSON.ObjectID.isValid(value)) {
  return helpers.error("any.invalid", { message: "Invalid MongoDB ObjectId format." });
 }
 return value;
};

// ------------------------------------------------
// Shared: ID Validation Functions
// ------------------------------------------------

// Generic ID Schema for params (e.g., used when route parameter is simply ':id')
const idSchema = Joi.object({
 id: Joi.string()
  .required()
  .custom(mongoIdValidation, 'MongoDB ID Validation'),
});

// Specific Parameter Schema for use in routes that use ':reviewId'
const reviewIdParam = Joi.object({
 reviewId: Joi.string()
  .required()
  .custom(mongoIdValidation, 'MongoDB ID Validation: Review'),
});

// Specific Parameter Schema for use in routes that use ':productId'
const productIdParam = Joi.object({
 productId: Joi.string()
  .required()
  .custom(mongoIdValidation, 'MongoDB ID Validation: Product'),
});


// ------------------------------------------------
// 1. Create Review Schema (POST /api/reviews)
// ------------------------------------------------
const createReviewSchema = Joi.object({
 productId: Joi.string()
  .required()
  .custom(mongoIdValidation, 'MongoDB ID Validation: Product'),
  
 rating: Joi.number()
  .integer()
  .min(1)
  .max(5)
  .required(),
  
 title: Joi.string()
  .trim()
  .min(3)
  .max(200)
  .optional(),
  
 text: Joi.string()
  .trim()
  .max(1000)
  .allow("")
  .optional(),
  
 // Optional compatibility fields (kept for backward compatibility, but discouraged)
 review: Joi.string().trim().max(1000).allow("").optional(),
 isVerifiedPurchase: Joi.boolean().optional()
});

// ------------------------------------------------
// 2. Update Review Schema (PUT/PATCH /api/reviews/:id)
// Used by both users and admin for content edits.
// ------------------------------------------------
const allowedStatuses = ["pending", "published", "hidden", "flagged", "archived"];

const updateReviewSchema = Joi.object({
 rating: Joi.number().integer().min(1).max(5).optional(),
 title: Joi.string().trim().min(3).max(200).optional(),
 text: Joi.string().trim().max(1000).allow("").optional(),
 // Alias fields are deprecated but supported for backward compatibility
 review: Joi.string().trim().max(1000).allow("").optional(), 
 
 // Admin-only field: Service layer should handle access control for this field.
 status: Joi.string()
  .valid(...allowedStatuses)
  .optional()
}).min(1);

// ------------------------------------------------
// 3. Admin Status Update Schema (PATCH /api/admin/reviews/:id/status)
// ------------------------------------------------
const adminStatusUpdateSchema = Joi.object({
 status: Joi.string()
  .valid(...allowedStatuses)
  .required(),
 adminNotes: Joi.string()
  .trim()
  .max(500)
  .allow(null, "")
  .optional()
});

// ------------------------------------------------
// 4. Admin Query Parameters Schema (GET /api/admin/reviews)
// ------------------------------------------------
const adminReviewQuerySchema = Joi.object({
 status: Joi.string()
  .valid(...allowedStatuses)
  .default(null) 
  .optional(),
 limit: Joi.number().integer().min(1).max(100).default(25),
 page: Joi.number().integer().min(1).default(1),
 product: Joi.string().custom(mongoIdValidation, 'MongoDB ID Validation: Product Filter').optional()
}).unknown(false);

// ------------------------------------------------
// 5. Public Query Parameters Schema (GET /api/reviews/product/:productId)
// ------------------------------------------------
const publicListQuerySchema = Joi.object({
 page: Joi.number().integer().min(1).default(1),
 limit: Joi.number().integer().min(1).max(50).default(20),
 sort: Joi.string()
  .valid("-createdAt", "createdAt", "-rating", "rating")
  .default("-createdAt")
}).unknown(false);

// ------------------------------------------------
// 6. Report Review Schema (POST /api/reviews/:reviewId/report)
// ------------------------------------------------
const reportReviewSchema = Joi.object({
    reason: Joi.string().trim().min(5).max(250).default('General misconduct').description('Reason for reporting the review.'),
});


module.exports = {
 // Shared Parameter Schemas
 idSchema,
  reviewIdParam,
  productIdParam,
  
 // Request Body/Query Schemas
 createReviewSchema,
 updateReviewSchema,
 adminStatusUpdateSchema,
 adminReviewQuerySchema,
 publicListQuerySchema,
  reportReviewSchema,
};