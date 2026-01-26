const Tracing = require("../utils/tracingClient");
const Logger = require("../utils/logger");

/**
 * @desc Enterprise High-Assurance Guard
 * Checks for fresh biometric verification and prevents session hijacking via IP/UA binding.
 */
const requireStepUp = (
  options = { validityMinutes: 15, strictBinding: true }
) => {
  return async (req, res, next) => {
    return Tracing.withSpan("security.requireStepUp", async (span) => {
      const { lastWebAuthnVerification, mfaContext } = req.session;
      const now = Date.now();

      span.setAttributes({
        "auth.user_id": req.user?._id?.toString(),
        "auth.policy": "High-Assurance",
        "request.ip": req.ip,
      });

      // 1. Check Time Validity
      const isFresh =
        lastWebAuthnVerification &&
        now - lastWebAuthnVerification < options.validityMinutes * 60 * 1000;

      // 2. Check Device Binding (Anti-Hijacking)
      const isBound =
        !options.strictBinding ||
        (mfaContext?.ip === req.ip &&
          mfaContext?.ua === req.headers["user-agent"]);

      if (isFresh && isBound) {
        span.setAttribute("auth.stepup.result", "authorized");
        return next();
      }

      // 3. Challenge Issuance
      Logger.security("MFA_STEP_UP_REQUIRED", {
        userId: req.user?._id,
        reason: !isFresh ? "EXPIRED" : "FINGERPRINT_MISMATCH",
        path: req.originalUrl,
      });

      res.status(401).json({
        success: false,
        code: "REAUTHENTICATION_REQUIRED",
        message: "This action requires biometric verification.",
        payload: {
          userId: req.user?._id,
          action: req.originalUrl,
        },
      });
    });
  };
};

module.exports = { requireStepUp };
