// routes/webhook.js
const express = require("express");
const ingressContext = require("../middleware/ingressContext");
const rateLimiter = require("../middleware/rateLimit");
const { webhookHandler } = require("../controllers/webhookController");

const router = express.Router();

/**
 * Webhook endpoint with:
 * 1. Ingress correlation
 * 2. Rate limiting + replay protection
 * 3. Actual webhook handling
 */
router.post(
    "/webhook/:provider",
    ingressContext,
    rateLimiter,
    webhookHandler
);

module.exports = router;
