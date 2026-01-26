/**
 * routes/paymentRoutes.js
 * Enterprise-grade payment routing (Merged Version)
 */

const express = require("express");
const router = express.Router();

const paymentController = require("../controller/paymentController");
const { validate } = require("../validators/validate");
const sanitizeInput = require("../middlewares/sanitize");
const { authenticate } = require("../../middleware/authMiddleware");

// ✅ Centralized Redis Rate Limiters
const {
  globalLimiter,
  checkoutLimiter,
  strictWriteLimiter,
  activityLogLimiter,
} = require("../../middleware/rateLimiter");

// ✅ Validation Schemas
const {
  initializePaymentSchema,
  verifyPaymentSchema,
  verifyStepUpSchema,
} = require("../../validators/payment.validation");



/**
 * ---------------------------------------------------------------------
 * AUTHENTICATION GATE
 * ---------------------------------------------------------------------
 */
router.use(authenticate);

/**
 * ---------------------------------------------------------------------
 * WALLET (READ-HEAVY, HIGH FREQUENCY)
 * GET /api/payment/wallet
 * ---------------------------------------------------------------------
 */
router.get(
  "/wallet",
  activityLogLimiter,
  paymentController.getWallet
);

/**
 * ---------------------------------------------------------------------
 * PAYMENT INITIATION (CRITICAL FINANCIAL OPERATION)
 * POST /api/payment/initiate
 * Rate Limiting Layers:
 *   - checkoutLimiter → limits payment attempts
 *   - strictWriteLimiter → protects DB & wallet writes
 * ---------------------------------------------------------------------
 */
router.post(
  "/initiate",
  checkoutLimiter,
  strictWriteLimiter,
  validate(initializePaymentSchema),
  sanitizeInput([], true),
  paymentController.initializePayment
);

/**
 * ---------------------------------------------------------------------
 * PAYMENT VERIFICATION
 * POST /api/payment/verify
 * Protects from replay & verify spam
 * ---------------------------------------------------------------------
 */
router.post(
  "/verify",
  strictWriteLimiter,
  validate(verifyPaymentSchema),
  paymentController.verifyPayment
);

/**
 * ---------------------------------------------------------------------
 * STEP-UP VERIFICATION (OTP / 3DS)
 * POST /api/payment/verify-stepup
 * Very sensitive route
 * ---------------------------------------------------------------------
 */
router.post(
  "/verify-stepup",
  checkoutLimiter,
  strictWriteLimiter,
  validate(verifyStepUpSchema),
  paymentController.verifyStepUpOtp
);

/**
 * ---------------------------------------------------------------------
 * PAYMENT HISTORY (READ-HEAVY / PAGINATED)
 * GET /api/payment/history
 * ---------------------------------------------------------------------
 */
router.get(
  "/history",
  activityLogLimiter,
  paymentController.getPaymentHistory
);

module.exports = router;
