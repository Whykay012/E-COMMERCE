// routes/paymentWebhook.js

const express = require("express");
const ingressContext = require("../middleware/ingressContext"); // Adds req.ingressRequestId
const rateLimiter = require("../middleware/rateLimit");       // Your rate limiter middleware
const { paymentWebhookHandler } = require("../controllers/paymentWebhookController");

const router = express.Router();

// Use express.raw() to ensure raw body is available for signature verification
router.use(express.raw({ type: "*/*" }));

/**
 * POST /api/webhooks/payment
 * - ingressContext: assigns a unique request ID
 * - rateLimiter: throttles requests and prevents replay attacks
 * - paymentWebhookHandler: verifies the webhook and logs it
 */
router.post(
    "/",
    ingressContext,
    rateLimiter,
    paymentWebhookHandler
);

module.exports = router;
