const Joi = require("joi");
const { validate } = require("./validators/validate"); // Assuming validationMiddleware.js contains the provided utility functions

// --- Helper Schemas ---
const passwordSchema = Joi.string()
  .min(8)
  .max(72)
  .required()
  .messages({
    "string.min": "Password must be at least 8 characters long.",
    "string.max": "Password cannot exceed 72 characters.",
    "any.required": "Password is required.",
  });

const productIdSchema = Joi.string()
  .hex()
  .length(24)
  .required()
  .messages({
    "string.hex": "Invalid Product ID format.",
    "string.length": "Invalid Product ID length.",
    "any.required": "Product ID is required.",
  });

const mongoIdSchema = Joi.string()
  .hex()
  .length(24)
  .required()
  .messages({
    "string.hex": "Invalid ID format.",
    "string.length": "Invalid ID length.",
    "any.required": "ID is required.",
  });

// --------------------------------------------------------------------------------
// SCHEMAS FOR USER CONTROLLER
// --------------------------------------------------------------------------------

// 1. Update Profile (PUT /profile)
const updateProfileSchema = Joi.object({
  username: Joi.string()
    .min(3)
    .max(50)
    .trim()
    .optional()
    .messages({
      "string.min": "Username must be at least 3 characters.",
      "string.max": "Username cannot exceed 50 characters.",
    }),
  email: Joi.string()
    .email()
    .trim()
    .optional()
    .messages({ "string.email": "Must be a valid email address." }),
  phone: Joi.string()
    .pattern(/^\+?\d{10,15}$/) // Basic international phone number pattern
    .optional()
    .messages({ "string.pattern": "Must be a valid phone number." }),
})
  .min(1) // Ensure at least one field is provided for update
  .messages({ "object.min": "At least one field (username, email, or phone) is required for update." });


// 2. Change Password (PATCH /change-password)
const changePasswordSchema = Joi.object({
  oldPassword: passwordSchema.label("Old Password"), // Reuse helper schema
  newPassword: passwordSchema
    .label("New Password")
    .invalid(Joi.ref("oldPassword")) // New password cannot be the same as the old one
    .messages({
      "any.invalid": "New password must be different from the old password.",
    }),
});

// 3. Add to Wishlist (POST /wishlist)
const addToWishlistSchema = Joi.object({
  productId: productIdSchema,
});

// 4. ID in Params (Used for Revoke Session, Remove from Wishlist, Mark Read, Set Default Address/Payment)
const idInParamsSchema = Joi.object({
  id: mongoIdSchema.label("Resource ID"),
});

// 5. Session ID in Params (Used for Revoke Session)
const sessionIdInParamsSchema = Joi.object({
  sessionId: mongoIdSchema.label("Session ID"),
});

// --------------------------------------------------------------------------------
// EXPORT VALIDATORS (using the `validate` middleware wrapper)
// --------------------------------------------------------------------------------

module.exports = {
  validateUpdateProfile: validate(updateProfileSchema, "body"),
  validateChangePassword: validate(changePasswordSchema, "body"),
  validateAddToWishlist: validate(addToWishlistSchema, "body"),
  validateIdInParams: validate(idInParamsSchema, "params"),
  validateSessionIdInParams: validate(sessionIdInParamsSchema, "params"),
};