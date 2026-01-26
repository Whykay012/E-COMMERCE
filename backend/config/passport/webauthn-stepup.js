const { Strategy: CustomStrategy } = require("passport-custom");
const webAuthnSecurityService = require("../../services/WebAuthnSecurityService");
const Logger = require("../../utils/logger");
const Tracing = require("../../utils/tracingClient");

/**
 * @file WebAuthnStepUpStrategy.js
 * @desc High-Assurance Passport Strategy for Zenith Enterprise
 */
const WebAuthnStepUpStrategy = new CustomStrategy(async (req, done) => {
  // 💡 Integration of Tracing for Performance Monitoring
  return Tracing.withSpan("auth.strategy.webauthn_verify", async (span) => {
    try {
      const { userId, assertionResponse } = req.body;

      if (!userId || !assertionResponse) {
        return done(null, false, {
          message: "Missing required verification data",
        });
      }

      /**
       * 🛡️ DELEGATION LOGIC
       * The WebAuthnSecurityService.verifyStepUpAssertion (v4.0.0) handles:
       * 1. Zero-Trust DB Projection
       * 2. Cryptographic Signature Validation
       * 3. Atomic Counter Update ($lt check)
       * 4. Session Binding (lastWebAuthnVerification & mfaContext)
       */
      const result = await webAuthnSecurityService.verifyStepUpAssertion(
        req,
        userId,
        assertionResponse
      );

      if (result.success) {
        // Return minimal identity to Passport
        span.setAttribute("auth.success", true);
        return done(null, { userID: userId });
      }

      return done(null, false, { message: "Hardware verification failed" });
    } catch (err) {
      span.recordException(err);
      Logger.error("PASSPORT_WEBAUTHN_ERROR", {
        error: err.message,
        userId: req.body.userId,
      });
      return done(err);
    }
  });
});

module.exports = WebAuthnStepUpStrategy;
