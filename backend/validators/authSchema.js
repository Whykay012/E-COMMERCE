// validation/authValidation.js
const Joi = require('joi');
const { validate } = require("./validation"); // Assuming validation file is in the same directory or adjust path

// --------------------------------------------------------------------------------
// ⚙️ Constants and Regex
// --------------------------------------------------------------------------------

// Mongoose Password Regex: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&.,])[A-Za-z\d@$!%*?&.,]{12,}$/
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&.,])[A-Za-z\d@$!%*?&.,]{12,}$/;
const PASSWORD_HINT = 'Password must be at least 12 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&.,).';
const PHONE_REGEX = /^\+?\d{7,15}$/;
const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;

// --------------------------------------------------------------------------------
// 1. Registration Schema (Aligned with Mongoose required fields)
// --------------------------------------------------------------------------------
const registerSchema = Joi.object({
    firstName: Joi.string()
        .trim()
        .max(50)
        .min(2)
        .required(),

    lastName: Joi.string()
        .trim()
        .max(50)
        .min(2)
        .required(),

    username: Joi.string()
        .trim()
        .lowercase()
        .min(3)
        .max(30)
        .regex(USERNAME_REGEX)
        .required()
        .messages({
            'string.pattern.base': 'Username can only contain letters, numbers, and underscores.'
        }),

    email: Joi.string()
        .email({ tlds: { allow: true } })
        .required()
        .messages({
            'string.email': 'Please provide a valid email address.'
        }),

    password: Joi.string()
        .min(12)
        .regex(PASSWORD_REGEX)
        .required()
        .messages({
            'string.min': 'Password must be at least 12 characters long.',
            'string.pattern.base': PASSWORD_HINT
        }),

    // --- Additional Required Fields from Mongoose Schema ---
    age: Joi.number()
        .integer()
        .min(13)
        .max(120)
        .required(),

    address: Joi.string()
        .trim()
        .min(5)
        .max(100)
        .required(),

    state: Joi.string()
        .trim()
        .min(2)
        .required(),

    country: Joi.string()
        .trim()
        .min(2)
        .required(),

    dob: Joi.date()
        .less('now') // Date of birth must be in the past
        .required(),

    phone: Joi.string()
        .trim()
        .regex(PHONE_REGEX)
        .required()
        .messages({
            'string.pattern.base': 'Phone number must be 7-15 digits and may start with a plus sign.'
        }),

    // Optional fields
    middleName: Joi.string().trim().max(50),
    profilePic: Joi.string().uri(), // Ensure it's a URL if provided

    // NOTE: Referral code should likely be handled separately after registration logic
    referralCode: Joi.string().max(30).optional(),
});

// --------------------------------------------------------------------------------
// 2. Login Schema (Combined: Email/Username)
// --------------------------------------------------------------------------------
const loginSchema = Joi.object({
    // 'identifier' covers both email or username, as determined by the business logic
    identifier: Joi.string()
        .trim()
        .max(100)
        .required()
        .messages({
            'any.required': 'Identifier (email or username) is required.',
            'string.empty': 'Identifier cannot be empty.',
            'string.max': 'Identifier cannot exceed 100 characters.'
        }),

    password: Joi.string()
        .max(128) // Max length for security, min length should match API requirement
        .required()
        .messages({
            'any.required': 'Password is required.',
            'string.empty': 'Password cannot be empty.'
        }),

    // Optional field for session tracking
    deviceName: Joi.string()
        .max(256)
        .optional()
        .default('Unknown Device')
});

// --------------------------------------------------------------------------------
// 3. MFA Verification Schema
// --------------------------------------------------------------------------------
const mfaSchema = Joi.object({
    // Temporary token received from the initial /login (202 ACCEPTED response)
    mfaToken: Joi.string()
        .length(64) // Assuming your mfaToken is a 32-byte hex string
        .required()
        .messages({
            'any.required': 'MFA token is missing.',
            'string.length': 'MFA token has an invalid format.'
        }),

    // The code (TOTP/SMS/Email) the user submits
    mfaCode: Joi.string()
        .pattern(/^[0-9]{6,8}$/) // Typically 6 or 8 digit numeric codes
        .required()
        .messages({
            'any.required': 'MFA code is missing.',
            'string.pattern': 'MFA code must be 6 to 8 numeric digits.'
        }),
});

// --------------------------------------------------------------------------------
// 4. Forgot Password Schema
// --------------------------------------------------------------------------------
const forgotPasswordSchema = Joi.object({
    email: Joi.string()
        .email({ tlds: { allow: true } })
        .required()
        .messages({
            'any.required': 'Email is required to initiate password reset.',
            'string.email': 'Please provide a valid email address.'
        }),
});

// --------------------------------------------------------------------------------
// 5. Reset Password Schema (After link click)
// --------------------------------------------------------------------------------
const resetPasswordSchema = Joi.object({
    // The reset token is passed to the API route (e.g., in query or body)
    token: Joi.string()
        // Standard token length often derived from `crypto.randomBytes(32).toString('hex')`
        .length(64)
        .required()
        .messages({
            'any.required': 'Reset token is missing or invalid.',
            'string.length': 'Invalid reset token format.'
        }),

    newPassword: Joi.string()
        .min(12)
        .regex(PASSWORD_REGEX)
        .required()
        .messages({
            'string.min': 'New password must be at least 12 characters long.',
            'string.pattern.base': PASSWORD_HINT
        }),

    confirmPassword: Joi.string()
        .valid(Joi.ref('newPassword'))
        .required()
        .messages({
            'any.required': 'Confirmation password is required.',
            'any.only': 'Confirmation password must match the new password.'
        }),
});

// --------------------------------------------------------------------------------
// 6. 🛠️ Update Profile Schema (PATCH/PUT)
// --------------------------------------------------------------------------------
const updateProfileSchema = Joi.object({
    firstName: Joi.string()
        .trim()
        .max(50)
        .min(2)
        .optional(),

    lastName: Joi.string()
        .trim()
        .max(50)
        .min(2)
        .optional(),

    middleName: Joi.string()
        .trim()
        .max(50)
        .optional(),

    username: Joi.string()
        .trim()
        .lowercase()
        .min(3)
        .max(30)
        .regex(USERNAME_REGEX)
        .optional()
        .messages({
            'string.pattern.base': 'Username can only contain letters, numbers, and underscores.'
        }),

    email: Joi.string()
        .email({ tlds: { allow: true } })
        .optional()
        .messages({
            'string.email': 'Please provide a valid email address.'
        }),

    age: Joi.number()
        .integer()
        .min(13)
        .max(120)
        .optional(),

    address: Joi.string()
        .trim()
        .min(5)
        .max(100)
        .optional(),

    state: Joi.string()
        .trim()
        .min(2)
        .optional(),

    country: Joi.string()
        .trim()
        .min(2)
        .optional(),

    dob: Joi.date()
        .less('now')
        .optional(),

    phone: Joi.string()
        .trim()
        .regex(PHONE_REGEX)
        .optional()
        .messages({
            'string.pattern.base': 'Phone number must be 7-15 digits and may start with a plus sign.'
        }),

    profilePic: Joi.string()
        .uri()
        .optional(),

    referralCode: Joi.string()
        .max(30)
        .optional(),

    // Explicitly forbid password/token fields in a standard profile update
    password: Joi.forbidden().messages({ 'any.unknown': 'Use the dedicated change-password endpoint.' }),
    token: Joi.forbidden(),
});


// --------------------------------------------------------------------------------
// 7. Export Validation Middleware Functions
// --------------------------------------------------------------------------------

// Middleware functions utilize the imported 'validate' utility
const validateRegister = validate(registerSchema, 'body');
const validateLogin = validate(loginSchema, 'body');
const validateMfa = validate(mfaSchema, 'body');
const validateForgotPassword = validate(forgotPasswordSchema, 'body');
const validateResetPassword = validate(resetPasswordSchema, 'body');
const validateUpdateProfile = validate(updateProfileSchema, 'body');


module.exports = {
    // Schemas
    registerSchema,
    loginSchema,
    mfaSchema,
    forgotPasswordSchema,
    resetPasswordSchema,
    updateProfileSchema,
    
    // Middleware Functions
    validateRegister,
    validateLogin,
    validateMfa,
    validateForgotPassword,
    validateResetPassword,
    validateUpdateProfile
};