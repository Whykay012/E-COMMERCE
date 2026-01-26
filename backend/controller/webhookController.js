const { preventReplay } = require("../utils/preventReplay");
const { dlqCounter } = require("../metrics/dlqMetrics");
const Logger = require("../utils/logger");

/**
 * Handles generic incoming webhooks
 */
async function webhookHandler(req, res) {
  try {
    const provider = req.params.provider || "unknown";

    const isReplay = await preventReplay({
      rawBody: req.rawBody || JSON.stringify(req.body),
      provider,
      providerId: req.headers["x-provider-id"] || "",
      signature: req.headers["x-signature"] || "",
      parsedPayload: req.body,
      headers: req.headers,
      metadata: { route: req.originalUrl, ingressRequestId: req.ingressRequestId },
    });

    if (isReplay) {
      dlqCounter.inc({ status: "replay_detected", provider });
      return res.status(429).json({
        status: "fail",
        code: "REPLAY_DETECTED",
        message: "Duplicate request detected",
      });
    }

    Logger.info("WEBHOOK_RECEIVED", { provider, ingressRequestId: req.ingressRequestId, payload: req.body });

    return res.status(200).json({ status: "success", message: "Webhook processed successfully" });
  } catch (err) {
    Logger.error({ err, ingressRequestId: req.ingressRequestId }, "WEBHOOK_HANDLER_FAILED");
    return res.status(500).json({ status: "error", message: "Internal server error processing webhook" });
  }
}

module.exports = { webhookHandler };
