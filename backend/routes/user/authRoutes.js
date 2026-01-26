
const verifyUser = require("../../auth/verify");
const resendOtp = require("../../auth/resendotp");

// AUTH
router.post("/register", registerSchema, register);
router.post("/login", loginSchema, login);
router.post("/verify-email/:token", verifyUser);
router.post("/resend-otp/:token", resendOtp);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.delete("/delete", authenticate, deleteAccount);
router.post("/logout", authenticate, logout);

module.exports = router;


// routes/authRoutes.js
const express = require('express');
const router = express.Router();

// 1. Controllers (Assumed to exist)
const loginController = require('../controller/auth/loginController');
const verifyMfaController = require('../controller/auth/mfaController');
const registerController = require('../controller/auth/registerController'); // New
const forgotPasswordController = require('../controller/auth/forgotPasswordController'); // New
const resetPasswordController = require('../controller/auth/resetPasswordController'); // New
const changePasswordController = require('../controller/auth/changePasswordController'); // New (Post-Auth)
const logoutController = require('../controller/auth/logoutController'); // New (Post-Auth)

// 2. Validation Middleware (Joi)
const { 
    validateRegister, 
    validateLogin, 
    validateMfa,
    validateForgotPassword,
    validateResetPassword,
} = require('../validation/authValidation'); 

// 3. Rate Limiters (IP-based for pre-auth routes)
const { 
     
    loginLimiter, 
    stepUpOtpLimiter, 
    forgotPasswordLimiter, 
    strictWriteLimiter // Generic for write ops
} = require('../config/rateLimiterConfig'); 

// 4. Custom Middleware (Assumed to exist)
const sanitizeInput = require('../middleware/security/sanitization'); // Sanitation utility
const { authenticate } = require("../../middleware/authMiddleware");

// -----------------------------------------------------------
// 🔐 Pre-Authentication Routes (Public Access)
// -----------------------------------------------------------

/**
 * @route POST /api/v1/auth/register
 * @desc Creates a new user account.
 * @access Public
 * * Protection:  strictWriteLimiter (for DB resource protection)
 */
router.post(
    '/register', 
     
    strictWriteLimiter, 
    validateRegister, 
    // Sanitize user input (names, address, referralCode)
    sanitizeInput(['firstName', 'lastName', 'middleName', 'address', 'state', 'country', 'referralCode'], false),
    registerController
);

/**
 * @route POST /api/v1/auth/login
 * @desc Handles user login (200 OK or 202 ACCEPTED for MFA).
 * @access Public
 * * Protection:  loginLimiter (Brute-force protection)
 */
router.post(
    '/login', 
     
    loginLimiter, 
    validateLogin,
    sanitizeInput(['identifier', 'deviceName'], true), // Strict sanitation on identifiers
    loginController
);

/**
 * @route POST /api/v1/auth/mfa/verify
 * @desc Verifies the MFA code to complete the login using the mfaToken.
 * @access Public (Requires the temporary mfaToken)
 * * Protection:  stepUpOtpLimiter (High-risk OTP brute-force protection)
 */
router.post(
    '/mfa/verify', 
     
    stepUpOtpLimiter, 
    validateMfa, 
    verifyMfaController
);

/**
 * @route POST /api/v1/auth/forgot-password
 * @desc Initiates the password reset flow (sends email).
 * @access Public
 * * Protection:  forgotPasswordLimiter (Email resource protection)
 */
router.post(
    '/forgot-password', 
     
    forgotPasswordLimiter, 
    validateForgotPassword, 
    forgotPasswordController
);

/**
 * @route POST /api/v1/auth/reset-password
 * @desc Resets the user's password using a valid token.
 * @access Public
 * * Protection:  strictWriteLimiter
 */
router.post(
    '/reset-password', 
     
    strictWriteLimiter, 
    validateResetPassword, 
    resetPasswordController
);

// -----------------------------------------------------------
// 🔄 Post-Authentication Routes (Requires Session/Token)
// -----------------------------------------------------------

/**
 * @route POST /api/v1/auth/token/refresh
 * @desc Rotates the refresh token to get a new access token.
 * @access Private (Requires Refresh Cookie)
 */
// router.post('/token/refresh', refreshController); 

/**
 * @route DELETE /api/v1/auth/logout
 * @desc Logs out the current session by revoking the specific refresh token.
 * @access Private (Requires Access Token)
 * * Protection: protect (Auth required)
 */
router.delete(
    '/logout', 
    authenticate, 
    logoutController
);

/**
 * @route PATCH /api/v1/auth/change-password
 * @desc Allows authenticated users to change their password (requires old password).
 * @access Private (Requires Access Token)
 * * Protection: protect (Auth required), strictWriteLimiter
 */
router.patch(
    '/change-password', 
    authenticate, 
    strictWriteLimiter, 
    // Requires a custom validation schema (validateChangePassword)
    changePasswordController
);


module.exports = router;