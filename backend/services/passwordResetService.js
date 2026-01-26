const crypto = require("crypto");
const User = require("../model/userModel");
const Outbox = require("../models/Outbox");
const Logger = require("../config/logger");
const { emailDispatchBreaker } = require("./authService");
const BadRequestError = require("../errors/bad-request-error");
const passwordResetLimiter = require("./passwordResetLimiter"); // Added import

/**
 * Zenith Reliability Tier: Merged Observability & Atomic Reset Initiation
 */
exports.initiatePasswordReset = async (identifier, context, session) => {
  // 1. Trace the operation for Distributed Tracing (Honeycomb/Jaeger)
  return tracingClient.withSpan("auth.reset.initiate", async (span) => {
    const { ip, traceId } = context;

    // 2. Find User (Supports Username or Email)
    const user = await User.findOne({
      $or: [{ username: identifier }, { email: identifier }],
    }).session(session);

    // Security: Silent exit on non-existent user to thwart enumeration
    if (!user) {
      Logger.warn("RESET_ATTEMPT_USER_NOT_FOUND", { identifier, ip });
      metricsClient.increment("auth.reset.initiate.fail", {
        reason: "enumeration_prevention",
      });
      return;
    }

    const userId = user._id.toString();
    span.setAttribute("user.id", userId);

    // 3. 🚨 Dual-Key Rate Limiting
    const { isRateLimited, timeToWaitMinutes } =
      await passwordResetLimiter.checkAttempt(userId, ip);
    if (isRateLimited) {
      auditLogger.log({
        level: "SECURITY",
        event: "RESET_RATE_LIMITED",
        userId,
        details: { ip, timeToWaitMinutes },
      });
      metricsClient.increment("auth.reset.initiate.fail", {
        reason: "rate_limit",
      });
      throw new BadRequestError(
        `You have exceeded the reset limit. Please wait ${timeToWaitMinutes} minutes.`
      );
    }

    // 4. Generate Cryptographic Token
    const rawResetToken = crypto.randomBytes(64).toString("hex");
    const hashedResetToken = crypto
      .createHash("sha256")
      .update(rawResetToken)
      .digest("hex");
    const expiry = new Date(
      Date.now() + (process.env.RESET_TOKEN_VALID_MINUTES || 60) * 60 * 1000
    );

    // 5. Atomic Update Phase (Everything inside the Session)
    // A. Update User Document
    user.passwordResetToken = hashedResetToken;
    user.passwordResetExpires = expiry;
    await user.save({ session, validateBeforeSave: false });

    // B. Record Rate Limit Attempt (Transactionally linked)
    await passwordResetLimiter.recordAttempt(userId, ip, session);

    // C. Create Transactional Outbox Event
    const outboxRecords = await Outbox.create(
      [
        {
          aggregateId: userId,
          eventType: "PASSWORD_RESET_REQUESTED",
          traceId: traceId,
          payload: {
            email: user.email,
            token: rawResetToken,
            link: `${process.env.CLIENT_URL}/reset-password?token=${rawResetToken}`,
          },
          status: "PENDING",
        },
      ],
      { session }
    );

    const eventId = outboxRecords[0]._id;

    // 6. Instant Dispatch Hint (Non-blocking)
    // Fire the circuit-breaker hint. If Redis/Queue is down, the Poller handles it.
    emailDispatchBreaker
      .fire("jobs", {
        name: "auth.email_relay",
        data: {
          type: "PASSWORD_RESET",
          eventId,
          email: user.email,
          traceId,
        },
      })
      .catch((err) => {
        Logger.critical("EMAIL_HINT_DELAYED", { userId, reason: err.message });
        metricsClient.security("email.dispatch.retry_queued", {
          flow: "reset",
        });
      });

    metricsClient.increment("auth.reset.initiate.success", { userId });
    return { success: true };
  });
};
