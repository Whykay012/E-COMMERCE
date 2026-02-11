/*
 * identityService.js (ZENITH UNIFIED IDENTITY & WORKER ENGINE)
 * ------------------------------------------------------------------
 * Enterprise-grade Identity Service with Integrated Worker Handlers
 * ------------------------------------------------------------------
 */

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const zod = require("zod");
const { promisify } = require("util");

// Errors & Models
const InternalServerError = require("../errors/internalServerError");
const UnauthorizedError = require("../errors/unauthenication-error");
const BadRequestError = require("../errors/bad-request-error");
const Outbox = require("../model/outbox");
const User = require("../model/userModel");

// Infrastructure
const tokenStore = require("./redisTokenStore");
const COOKIE_CFG = require("../config/cookieConfig");
const { emailDispatchBreaker } = require("./authService");
const passwordResetLimiter = require("./passwordResetLimiter");

// Observability
const Tracing = require("../utils/tracingClient");
const Metrics = require("../utils/metricsClient");
const Logger = require("../utils/logger");
const AuditLogger = require("../services/auditLogger");

const randomBytes = promisify(crypto.randomBytes);

// ------------------------------------------------------------------
// 📜 SCHEMA DEFINITION
// ------------------------------------------------------------------
const PasswordRotationSchema = zod
  .object({
    outboxId: zod.string().nonempty(),
    userId: zod.string().nonempty(),
    traceId: zod.string().uuid(),
    payload: zod
      .object({
        revokeSessions: zod.boolean().optional().default(true),
      })
      .passthrough(),
  })
  .passthrough();

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------
const {
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  JWT_SCOPED_SECRET = crypto.randomBytes(32).toString("hex"),
} = process.env;

const CONFIG = {
  ISSUER: "auth-service",
  ALGO: "HS256",
  ACCESS_TTL: Math.floor(COOKIE_CFG.CONFIG.ACCESS_TOKEN_MAX_AGE_MS / 1000),
  REFRESH_TTL: Math.floor(COOKIE_CFG.CONFIG.REFRESH_TOKEN_MAX_AGE_MS / 1000),
};

if (!JWT_ACCESS_SECRET || !JWT_REFRESH_SECRET) {
  Logger.error("FATAL_SECURITY_MISCONFIG", { reason: "JWT secrets missing" });
  process.exit(1);
}

// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------
const safeCompare = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

const decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------
// 🛠️ WORKER HANDLERS
// ------------------------------------------------------------------

/**
 * Bridges background worker jobs to identity logic.
 */
const handlePasswordRotation = async (data, job) => {
  const { outboxId, userId, traceId, payload } = data;
  const context = { jobId: job.id, outboxId, userId, traceId };

  const task = await Outbox.findOneAndUpdate(
    { _id: outboxId, status: "PENDING" },
    {
      $set: {
        status: "PROCESSING",
        claimedBy: process.env.HOSTNAME || "omega-worker-node",
      },
    },
    { new: true }
  );

  if (!task) {
    Logger.info("OUTBOX_CLAIM_SKIPPED", {
      reason: "Already processed",
      ...context,
    });
    return { status: "skipped" };
  }

  try {
    AuditLogger.log({
      level: "INFO",
      event: "PASSWORD_ROTATION_RELAY_START",
      context,
    });

    if (payload.revokeSessions) {
      await revokeAllTokens(userId, { reason: "PASSWORD_ROTATION", traceId });
    }

    task.status = "COMPLETED";
    task.processedAt = new Date();
    await task.save();

    AuditLogger.log({
      level: "INFO",
      event: "PASSWORD_ROTATION_RELAY_SUCCESS",
      context,
    });
    return { status: "success" };
  } catch (error) {
    task.status = "FAILED";
    task.errorLog.push({
      message: error.message,
      attempt: (job?.attemptsMade || 0) + 1,
      timestamp: new Date(),
    });
    await task.save();

    Logger.error("PASSWORD_ROTATION_TASK_FAILED", {
      ...context,
      error: error.message,
    });
    throw error;
  }
};

// ------------------------------------------------------------------
// 🔐 CORE IDENTITY LOGIC (Service Layer)
// ------------------------------------------------------------------

/**
 * Initiates Password Reset (High-Security Flow)
 */
/**
 * 🔐 ZENITH IDENTITY: Password Reset Orchestration
 * Architecture: Hybrid Transactional State Machine
 * Features: Enumeration Protection, Rate Limiting, Outbox Persistence, Tracing.
 */
const initiatePasswordReset = async (identifier, context, externalSession = null) => {
  // 1. SESSION MANAGEMENT: Support both local and injected transactions
  const session = externalSession || (await mongoose.startSession());
  const isLocalSession = !externalSession;

  if (isLocalSession) session.startTransaction();

  return await Tracing.withSpan("auth.reset.initiate", async (span) => {
    try {
      const { ip, traceId } = context;

      // 2. IDENTITY LOOKUP (Atomic & Scoped to Session)
      const user = await User.findOne({
        $or: [{ username: identifier }, { email: identifier }],
      }).session(session);

      if (!user) {
        // Log locally for security monitoring but return success to the client
        Logger.warn("RESET_ATTEMPT_USER_NOT_FOUND", { identifier, ip });
        Metrics.increment("auth.reset.initiate.fail", { reason: "enumeration_prevention" });
        
        if (isLocalSession) await session.commitTransaction();
        return { success: true };
      }

      const userId = user._id.toString();
      span.setAttribute("user.id", userId);

      // 3. SECURITY GUARD: Rate Limiting
      const { isRateLimited, timeToWaitMinutes } = await passwordResetLimiter.checkAttempt(userId, ip);
      
      if (isRateLimited) {
        AuditLogger.log({
          level: "SECURITY",
          event: "RESET_RATE_LIMITED",
          userId,
          details: { ip, timeToWaitMinutes },
        });
        Metrics.increment("auth.reset.initiate.fail", { reason: "rate_limit" });
        
        throw new BadRequestError(
          `You have exceeded the reset limit. Please wait ${timeToWaitMinutes} minutes.`
        );
      }

      // 4. CRYPTOGRAPHIC ENTROPY: Token Generation
      // 64-byte random string for maximum security against brute force
      const rawResetToken = crypto.randomBytes(64).toString("hex");
      const hashedResetToken = crypto.createHash("sha256").update(rawResetToken).digest("hex");
      
      // Default to 60 minutes if env is missing
      const ttlMinutes = parseInt(process.env.RESET_TOKEN_VALID_MINUTES) || 60;
      const expiry = new Date(Date.now() + ttlMinutes * 60 * 1000);

      // 5. ATOMIC STATE UPDATE
      user.passwordResetToken = hashedResetToken;
      user.passwordResetExpires = expiry;
      // validateBeforeSave: false is used because we only want to update these specific security fields
      await user.save({ session, validateBeforeSave: false });

      // Record the attempt within the transaction to prevent race conditions
      await passwordResetLimiter.recordAttempt(userId, ip, session);

      // 6. RELIABLE MESSAGING: Outbox Pattern
      // This ensures the email is ONLY sent if the database update actually succeeds.
      const [event] = await Outbox.create(
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
            priority: 10, // Security events take priority in the worker queue
          },
        ],
        { session }
      );

      // 7. TRANSACTION COMMIT
      if (isLocalSession) {
        await session.commitTransaction();
      }

      // 8. ASYNC HINT: Fire-and-forget background job notification
      // We do this AFTER commit. If the breaker fails, the Outbox worker will eventually pick it up anyway.
      emailDispatchBreaker
        .fire("jobs", {
          name: "auth.email_relay",
          data: { eventId: event._id, type: "PASSWORD_RESET", traceId },
        })
        .catch((err) => {
          Logger.critical("EMAIL_HINT_DELAYED", { userId, reason: err.message });
        });

      Metrics.increment("auth.reset.initiate.success", { userId });
      
      return { success: true };

    } catch (error) {
      // 9. ERROR HANDLING & ROLLBACK
      if (isLocalSession && session.inTransaction()) {
        await session.abortTransaction();
      }
      
      Logger.error("PASSWORD_RESET_ORCHESTRATION_FAILED", {
        identifier,
        error: error.message,
        traceId: context.traceId
      });
      
      throw error;
    } finally {
      // 10. CLEANUP
      if (isLocalSession) {
        await session.endSession();
      }
    }
  });
};
/**
 * Initiates Account Verification OTP
 */
const requestEmailVerification = async (user, context = {}, session = null) => {
  return Tracing.withSpan("auth.verification.initiate", async (span) => {
    const { traceId } = context;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    user.otp = crypto.createHash("sha256").update(otp).digest("hex");
    user.otpExpires = Date.now() + 10 * 60 * 1000;
    await user.save({ session });

    const [event] = await Outbox.create(
      [
        {
          aggregateId: user._id,
          eventType: "USER_VERIFICATION_REQUESTED",
          traceId: traceId,
          payload: { email: user.email, otp: otp },
          status: "PENDING",
        },
      ],
      { session }
    );

    emailDispatchBreaker
      .fire("jobs", {
        name: "auth.email_relay",
        data: { eventId: event._id, type: "VERIFICATION_OTP", traceId },
      })
      .catch((err) => {
        Logger.warn("VERIFICATION_HINT_DELAYED", {
          userId: user._id,
          reason: err.message,
        });
      });

    return { success: true };
  });
};

// ------------------------------------------------------------------
// TOKEN MANAGEMENT (ISSUANCE / VALIDATION / REVOCATION)
// ------------------------------------------------------------------

const generateAuthTokens = async (ctx) => {
  return Tracing.withSpan("Identity.generateAuthTokens", async (span) => {
    span.setAttribute("user.id", ctx.id);

    const [csrf, sessionBuf, accessJti, refreshJti] = await Promise.all([
      randomBytes(18).then((b) => b.toString("base64url")),
      randomBytes(12),
      randomBytes(12).then((b) => b.toString("hex")),
      randomBytes(12).then((b) => b.toString("hex")),
    ]);

    const issuedAt = Math.floor(Date.now() / 1000);
    const lastPasswordCheck = ctx.lastPasswordCheck || Date.now();

    const accessPayload = {
      sub: ctx.id,
      role: ctx.role,
      version: ctx.securityVersion, // 🚀 NEW: Bind to Global Security State
      csrf,
      jti: accessJti,
      lpc: lastPasswordCheck,
      scopes: ctx.scopes || [],
      type: "access",
      iat: issuedAt,
    };

    const accessToken = jwt.sign(accessPayload, JWT_ACCESS_SECRET, {
      expiresIn: CONFIG.ACCESS_TTL,
      issuer: CONFIG.ISSUER,
      algorithm: CONFIG.ALGO,
    });

    const refreshPayload = {
      sub: ctx.id,
      version: ctx.securityVersion, // 🚀 NEW: Bind to Global Security State
      jti: refreshJti,
      type: "refresh",
      iat: issuedAt,
    };

    const refreshToken = jwt.sign(refreshPayload, JWT_REFRESH_SECRET, {
      expiresIn: CONFIG.REFRESH_TTL,
      algorithm: CONFIG.ALGO,
    });

    const sessionMeta = {
      u: ctx.id,
      v: ctx.securityVersion, // 🚀 NEW: Store version in session metadata
      ip: ctx.ip,
      dev: ctx.deviceName,
      ua: ctx.userAgent,
      sid: sessionBuf.toString("hex"),
      ati: accessJti,
      lpc: lastPasswordCheck,
    };

    await tokenStore.setRefreshToken(
      refreshJti,
      sessionMeta,
      CONFIG.REFRESH_TTL
    );

    Metrics.increment("auth.tokens.issued", 1, { role: ctx.role });
    AuditLogger.log({
      level: "INFO",
      event: "SESSION_LOGIN_SUCCESS",
      userId: ctx.id,
      details: { ip: ctx.ip },
    });

    return {
      accessToken,
      refreshToken,
      csrfToken: csrf,
      sessionId: sessionMeta.sid,
    };
  });
};

const validateAccessToken = async (token, providedCsrf = null) => {
  return Tracing.withSpan("Identity.validateAccessToken", async () => {
    try {
      const payload = jwt.verify(token, JWT_ACCESS_SECRET, {
        issuer: CONFIG.ISSUER,
        algorithms: [CONFIG.ALGO],
      });

      if (payload.type !== "access") throw new Error("INVALID_TYPE");
      if (providedCsrf && !safeCompare(payload.csrf, providedCsrf))
        throw new Error("CSRF_MISMATCH");

      // 🛡️ REVEALED: Blacklist check
      const revoked = await tokenStore.isAccessTokenBlacklisted(payload.jti);
      if (revoked) throw new Error("TOKEN_REVOKED");

      return {
        isValid: true,
        id: payload.sub,
        role: payload.role,
        version: payload.version, // 🚀 NEW: Pass version to Middleware for DB check
        scopes: payload.scopes || [],
        lastPasswordCheck: payload.lpc,
      };
    } catch (err) {
      Metrics.security("access.validation.fail", { reason: err.message });
      throw new UnauthorizedError("Access denied");
    }
  });
};
const validateRefreshToken = async (refreshToken) => {
  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET, {
      algorithms: [CONFIG.ALGO],
    });
    if (decoded.type !== "refresh") throw new Error("INVALID_TYPE");

    const sessionData = await tokenStore.getRefreshToken(decoded.jti);
    if (!sessionData) return { isValid: false, userId: decoded.sub };

    return {
      isValid: true,
      userId: decoded.sub,
      jti: decoded.jti,
      sessionData,
    };
  } catch {
    return { isValid: false };
  }
};

/**
 * @desc Rotates the Refresh Token and issues a new Access Token.
 * Implements Replay Detection and Security Version synchronization.
 */
const rotateAuthTokens = async ({
  oldRefreshToken,
  id,
  role,
  ip,
  userAgent,
}) => {
  // 1. Cryptographic and Persistence Validation
  const validation = await validateRefreshToken(oldRefreshToken);

  // 🚩 SECURITY ALERT: Replay Attack Detection
  // If the refresh token is invalid but matches the user, someone is trying to reuse an old token.
  // We revoke EVERYTHING for this user as a scorched-earth defense.
  if (!validation.isValid || validation.userId !== id) {
    Metrics.security("refresh.replay.detected", { userId: id });
    await tokenStore.revokeAllUserTokens(id);
    throw new UnauthorizedError(
      "Security violation detected. All sessions terminated."
    );
  }

  // 2. Fetch the latest Global Security State
  // We pull the securityVersion and password check timestamp directly from the source of truth.
  const user = await User.findById(id).select(
    "+securityVersion +lastPasswordCheck"
  );
  if (!user) throw new UnauthorizedError("User no longer exists.");

  // 3. Atomic Revocation of the used pair
  // We blacklist the access token (ati) and delete the used refresh token (jti).
  await Promise.all([
    tokenStore.revokeRefreshToken(validation.jti),
    validation.sessionData?.ati &&
      tokenStore.blacklistAccessToken(
        validation.sessionData.ati,
        CONFIG.ACCESS_TTL
      ),
  ]);

  // 4. Issue fresh tokens bound to the new securityVersion
  return generateAuthTokens({
    id,
    role,
    ip,
    userAgent,
    securityVersion: user.securityVersion, // 🚀 Sync with Panic Button state
    deviceName: validation.sessionData?.dev || "rotated",
    lastPasswordCheck: user.lastPasswordCheck || validation.sessionData?.lpc,
  });
};
const revokeAllTokens = async (userId, context = {}) => {
  if (!userId) throw new InternalServerError("User ID required");

  return Tracing.withSpan("Identity.revokeAllTokens", async (span) => {
    span.setAttribute("user.id", userId);
    const count = await tokenStore.revokeAllUserTokens(userId);

    Metrics.increment("refresh.revoke.global", count);
    AuditLogger.log({
      level: "INFO",
      event: "SESSION_GLOBAL_LOGOUT",
      userId,
      details: {
        count,
        reason: context.reason || "MANUAL",
        traceId: context.traceId,
      },
    });

    return { revokedCount: count };
  });
};

const revokeSpecificSession = async ({ refreshToken, userId }) => {
  const decoded = decodeToken(refreshToken);
  if (!decoded?.jti || decoded.sub !== userId) return;

  const sessionData = await tokenStore.getRefreshToken(decoded.jti);
  await tokenStore.revokeRefreshToken(decoded.jti);

  if (sessionData?.ati) {
    await tokenStore.blacklistAccessToken(sessionData.ati, CONFIG.ACCESS_TTL);
  }
};

const issueScopedJwt = (data, ttl = 300) => {
  return jwt.sign(
    {
      sub: data.id,
      scopes: data.scopes,
      version: data.securityVersion, // 🛡️ Inherit current security version
      type: "scoped",
      jti: crypto.randomUUID(), // 🛡️ Allow tracing of specific actions
    },
    JWT_SCOPED_SECRET,
    {
      expiresIn: ttl,
      issuer: CONFIG.ISSUER,
    }
  );
};

const revokeJti = async (jti) => {
  if (!jti) return false;
  await tokenStore.blacklistAccessToken(jti, CONFIG.ACCESS_TTL);
  return true;
};

// ------------------------------------------------------------------
// PUBLIC CONTRACT
// ------------------------------------------------------------------
module.exports = {
  handlePasswordRotation,
  initiatePasswordReset,
  requestEmailVerification,
  PasswordRotationSchema,
  generateAuthTokens,
  validateAccessToken,
  validateRefreshToken,
  rotateAuthTokens,
  revokeSpecificSession,
  revokeAllTokens,
  revokeJti,
  issueScopedJwt,
  decodeToken,
};
