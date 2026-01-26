// routes/user.referral.routes.js
// Handles all public and authenticated user-specific endpoints.

const express = require("express");
const userRouter = express.Router();
const UserReferralController = require("../controller/userReferralController");

// Middlewares (implementations must exist in your project)
const authenticate = require("../middleware/authMiddleware"); // attaches req.user
// Use the validate middleware you provided
const { validate } = require("../validators/validate"); 
const validators = require("../validators/referralValidators"); 
const { createRateLimiter } = require("../middleware/rateLimiter"); 

// Rate limiters for sensitive endpoints (tune per env)
const validateLimiter = createRateLimiter({ windowSeconds: 60, max: 30, keyPrefix: "rl:referral:validate" });
const recordLimiter = createRateLimiter({ windowSeconds: 60, max: 10, keyPrefix: "rl:referral:record" });
const generateLimiter = createRateLimiter({ windowSeconds: 3600, max: 50, keyPrefix: "rl:referral:generate" });

// === PUBLIC ROUTES ===
userRouter.post("/validate", validate(validators.validateReferralSchema), validateLimiter, UserReferralController.validateReferralCode);

// === AUTHENTICATED USER ROUTES ===
userRouter.post("/generate", authenticate, generateLimiter, UserReferralController.createReferralForUser);
userRouter.get("/me", authenticate, UserReferralController.getMyReferral);

// Update custom code
userRouter.patch("/code", authenticate, validate(validators.updateCustomCodeSchema), UserReferralController.updateReferralCode);

// === CORE BUSINESS LOGIC ROUTES ===
// Link a referred user upon signup (Idempotency Key validation happens in controller)
userRouter.post("/signup", validate(validators.signupReferralSchema), UserReferralController.processNewReferralSignup);

// Record commission (often called by an authenticated internal service)
// Using the correct schema name: recordOrderReferralSchema
userRouter.post("/record", authenticate, recordLimiter, validate(validators.recordOrderReferralSchema), UserReferralController.creditOrderReferralCommission);

module.exports = userRouter;