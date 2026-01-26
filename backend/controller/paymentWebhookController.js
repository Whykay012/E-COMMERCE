// controllers/paymentWebhookController.js

const { preventReplay } = require("../utils/preventReplay");
const { dlqCounter } = require("../metrics/prometheus");
const PaymentService = require("../services/paymentServices");
const Logger = require("../utils/logger");
const WebhookLog = require("../model/webHookLog");

/**
 * Payment webhook handler
 * Applies:
 * 1. Ingress correlation via req.ingressRequestId
 * 2. Replay protection (preventReplay)
 * 3. Payment provider verification (Stripe, Paystack, Flutterwave)
 * 4. Logging to WebhookLog and Prometheus DLQ counter
 */
async function paymentWebhookHandler(req, res) {
    try {
        // Ensure rawBody is available (middleware express.raw() should have been used)
        const rawBody = req.rawBody || JSON.stringify(req.body);
        const headers = req.headers;
        const provider = headers["x-provider"] || "unknown";

        // 1️⃣ Replay protection
        const isReplay = await preventReplay({
            rawBody,
            provider,
            providerId: headers["x-provider-id"] || "",
            signature: headers["x-signature"] || "",
            parsedPayload: req.body,
            headers,
            metadata: { route: req.originalUrl, ingressRequestId: req.ingressRequestId },
        });

        if (isReplay) {
            dlqCounter.inc({ reason: "replay_detected", provider });
            return res.status(429).json({
                status: "fail",
                code: "REPLAY_DETECTED",
                message: "Duplicate request detected",
            });
        }

        // 2️⃣ Log incoming webhook as "processing"
        const logEntry = await WebhookLog.create({
            provider,
            payload: req.body,
            status: "processing",
        });

        // 3️⃣ Payment-specific verification
        let eventData = null;
        if (headers["stripe-signature"]) {
            provider = "stripe";
            eventData = await PaymentService.verifyStripeSignature(rawBody.toString(), headers);
        } else if (headers["x-paystack-signature"]) {
            provider = "paystack";
            eventData = await PaymentService.verifyPaystackSignature(rawBody.toString(), headers);
        } else if (headers["verif-hash"]) {
            provider = "flutterwave";
            eventData = await PaymentService.verifyFlutterwaveSignature(rawBody.toString(), headers);
        }

        // 4️⃣ Update log status
        logEntry.status = "processed";
        logEntry.payload = eventData || req.body;
        await logEntry.save();

        Logger.info("PAYMENT_WEBHOOK_PROCESSED", { provider, ingressRequestId: req.ingressRequestId });

        // 5️⃣ Return success
        return res.status(200).json({ status: "success", message: "Payment webhook processed" });
    } catch (err) {
        // Error handling & logging
        Logger.error({ err, ingressRequestId: req.ingressRequestId }, "PAYMENT_WEBHOOK_FAILED");

        // Optional: increment DLQ metric for failures
        dlqCounter.inc({ reason: "processing_failed", provider: req.headers["x-provider"] || "unknown" });

        return res.status(500).json({ status: "error", message: err.message });
    }
}

module.exports = { paymentWebhookHandler };
