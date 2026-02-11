// --- 💡 Core Dependencies ---
const User = require("../model/userModel");
const AuthenticationError = require("../errors/unauthenication-error");
const InternalServerError = require("../errors/internalServerError");
const BadRequestError = require("../errors/bad-request-error");
const ForbiddenError = require("../errors/forbiddenError"); // New Error for Policy/RBAC
const mongoose = require("mongoose");
const crypto = require("crypto");
const { timingSafeEqual } = require("crypto");
// NEW Concrete Import (using your provided file)
const { CircuitBreaker } = require("./circuitBreaker"); // Adjust path as necessary
const {
  calculatePasswordRisk,
  getConfig,
} = require("../utils/securityPolicyUtils");
const Outbox = require("../model/outbox");
const hashToken = require("../utils/token-utils");
const generateOTP = require("../utils/otp-utils");
const IdempotencyService = require("./idempotencyService");
// const { getConfig } = require('../utils/configManager');

// --- 📈 Telemetry Dependencies (INTEGRATED) ---
const Logger = require("../utils/logger");
const metricsClient = require("../utils/metricsClient");
const tracingClient = require("../utils/tracingClient");
const { instrument } = require("../utils/authInstrumentation");
// --- 👑 AUDIT FACADE (RESILIENT) ---
const auditLogger = require("./auditLogger");

// --- 💡 External Dependencies (ASSUMED IMPLEMENTED)
const identityService = require("./identityService"); // Handles JWT/Token logic
const geoIpService = require("./geoIpService");
const mfaService = require("./mfaService");
const {
  otpRateLimiter,
  // resendRateLimiter,
  passwordResetLimiter,
} = require("./rateLimiter/rateLimiterInstances");

const resendRateLimiter = require("./rateLimiter/standaloneLimiters");
const passwordHistoryService = require("./passwordHistoryService");
const policyEngine = require("./policyEngine"); // New: RBAC/ABAC Engine
const systemIdentityService = require("./systemIdentityService"); // New: M2M Tokens
const complianceService = require("./complianceService"); // New: GDPR/CCPA
const webAuthnService = require("./webAuthnService"); // New: FIDO2/WebAuthn handling
const HealthMonitor = require("../utils/HealthMonitor"); // Placeholder for HealthMonitor dependency

// --- 💡 EVENT/ASYNC DEPENDENCIES (ASSUMED IMPLEMENTED)
const queueClient = require("./queueAdapters/queueClient");
const securityService = require("./securityService");
const websocketService = require("./websocketService");

// 💡 CIRCUIT BREAKER INSTANCE
const emailDispatchBreaker = new CircuitBreaker(
  // The asynchronous action to protect: sending the job to the queue
  async (jobName, payload) => queueClient.send(jobName, payload),
  {
    name: "email-dispatch-queue",
    // INTENT: Timeout of 3000ms for the action (BreakerTimeoutError)
    timeout: 3000,

    // INTENT: Replace 'maxFailures' with Sliding Window configuration
    // This configuration means:
    // "Require at least 10 calls, and trip the circuit if 50% or more fail."
    windowSize: 20, // Track the last 20 requests
    minimumRequestThreshold: 10, // Must have at least 10 requests to evaluate
    errorPercentageThreshold: 50, // Trip if 50% fail

    // INTENT: Reset timeout of 30000ms
    resetTimeout: 30000, // Time (ms) in OPEN state before trying HALF-OPEN

    // NOTE on errorFilter: The Sliding Window Breaker treats *all* errors
    // (including BreakerTimeoutError) as failures. We cannot exclude specific
    // application errors like BadRequestError from the failure count
    // without wrapping the action, which is generally safer not to do.
  },
);

// --- Breaker Instance Creation ---
// Create a new instance using the action you want to protect
/**
 * Multi-purpose Security Action
 * Logs to SIEM AND dispatches to the Queue
 */
const securityAction = async (queueName, jobPayload) => {
  // 1. Existing Logic: Log the event to your SIEM
  // We assume logToSiEM expects the data object
  await securityService.logToSiEM(jobPayload.data || jobPayload);

  // 2. New Logic: Dispatch to the Queue for the Worker/Router
  // This allows the routerProcessor to invalidate sessions
  return await queueClient.send(queueName, jobPayload);
};

const securityServiceBreaker = new CircuitBreaker(securityAction, {
  name: "security-siem-logger",
  windowSize: 100,
  minimumRequestThreshold: 20,
  errorPercentageThreshold: 40,
  resetTimeout: 30000,
  timeout: 2000,
});
/* ===========================
 * ⚙️ Configuration
 * =========================== */
const LOCKOUT_THRESHOLD = 5;
const MAX_FAILED_ATTEMPTS = 20;
const TEMPORARY_LOCKOUT_MS = 60 * 60 * 1000;
const PASSWORD_EXPIRY_DAYS = 90;

/* ===========================
 * 🔧 Helper Utilities
 * =========================== */
const getPasswordExpiryStatus = (lastUpdatedDate) => {
  const lastUpdated = lastUpdatedDate || new Date(0);
  const expiryDate = new Date(
    lastUpdated.getTime() + PASSWORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );
  return expiryDate < new Date();
};

/* ===========================
 * 🔐 Failed Attempt Handling
 * =========================== */

/**
 * @desc ZENITH-ULTRA: Record Failed Login Attempt
 * Combined Two-Tier Defense: Redis Lua Replay Guard + Atomic MongoDB Update
 */
const recordFailedAttempt = async (userId, clientIp, identifier) => {
  const redis = getRedisClient();
  const replayKey = `{user:${userId}}:replay:cnt`;
  const banKey = `{user:${userId}}:replay:ban`;

  try {
    // 1. REDIS LAYER (Sliding Window / Replay Guard)
    // Prevents rapid-fire brute force without hitting DB every time
    // Window: 600s, Threshold: LOCKOUT_THRESHOLD, Ban: 3600s
    const [redisCount, isRedisBanned] = await redis.replayGuard(
      replayKey,
      banKey,
      600,
      LOCKOUT_THRESHOLD,
      3600
    );

    // 2. DATABASE PREPARATION
    // Fetch current state to determine if this specific increment triggers a lock
    const user = await User.findById(userId).select("failedLoginAttempts email role");
    if (!user) return;

    const newAttempts = user.failedLoginAttempts + 1;
    let updateData = { $inc: { failedLoginAttempts: 1 } };
    let auditEvent = null;

    // 3. LOCKOUT LOGIC DETERMINATION
    if (newAttempts >= LOCKOUT_THRESHOLD || isRedisBanned === 1) {
      // Tier 1: Temporary Lockout
      updateData.$set = {
        isLocked: true,
        lockoutUntil: new Date(Date.now() + TEMPORARY_LOCKOUT_MS),
      };
      auditEvent = "ACCOUNT_LOCKED_TEMPORARY";
    } else if (newAttempts > 0 && newAttempts % MAX_FAILED_ATTEMPTS === 0) {
      // Tier 2: Permanent Lockout (Requires manual Admin unlock)
      updateData.$set = { isLocked: true, lockoutUntil: null };
      auditEvent = "ACCOUNT_LOCKED_PERMANENT";
    }

    // 4. ATOMIC DATABASE UPDATE
    // Executes increment and potential lock in a single round-trip
    await User.findByIdAndUpdate(userId, updateData);

    // 5. AUDIT & TELEMETRY
    if (auditEvent) {
      await auditLogger.dispatchLog({
        level: auditEvent === "ACCOUNT_LOCKED_PERMANENT" ? "CRITICAL" : "WARN",
        event: auditEvent,
        userId,
        details: {
          reason: isRedisBanned === 1 ? "Redis Replay Guard Triggered" : "DB Threshold Hit",
          attempts: newAttempts,
          ip: clientIp,
          identifier
        },
      });
    }

    // Performance Metrics
    metricsClient.increment("security.login.attempt.fail", 1, { 
      userId, 
      tier: auditEvent ? "locked" : "counted" 
    });

    Logger.warn("AUTH_FAILURE_RECORDED", { 
      userId, 
      attempts: newAttempts, 
      isBanned: !!isRedisBanned 
    });

  } catch (error) {
    // Fail-Safe: Log the error but don't crash the auth flow
    Logger.error("RECORD_FAILED_ATTEMPT_CRITICAL_FAIL", { 
      userId, 
      error: error.message 
    });
  }
};

/**
 * @desc RESETS security state upon successful MFA verification
 */
const resetAttempts = async (userId) => {
  await User.findByIdAndUpdate(userId, {
    $set: { 
      failedLoginAttempts: 0, 
      isLocked: false, 
      lockoutUntil: null 
    },
  });
  
  metricsClient.gauge("user.failed_attempts", 0, { userId });
  Logger.info("AUTH_STATE_RESET", { userId });
}
/**
 * @desc Core login logic with advanced security, auditing, and microservice decoupling.
 */
/* ===========================
 * 👑 Core Login (processUserLogin)
 * =========================== */

// ------------------------------------------------------------------
// LOGIN & TOKEN GENERATION
// ------------------------------------------------------------------

const generateLoginTokens = async ({
  userId,
  existingUser,
  deviceName,
  userAgent,
  clientIp,
  lastPasswordCheck,
  isSuspicious,
}) => {
  const startTime = Date.now();

  // 1. RESILIENCE: Safe Date Parsing
  // Prevents "Cannot read property 'getTime' of undefined" if field is missing
  const passwordCheckTs =
    lastPasswordCheck instanceof Date
      ? lastPasswordCheck.getTime()
      : Date.now();

  // 2. TOKEN ISSUANCE
  // identityService handles the creation of Access and Refresh tokens
  const tokens = await identityService.generateAuthTokens({
    id: userId,
    role: existingUser.role,
    deviceName,
    userAgent,
    ip: clientIp,
    lastPasswordCheck: passwordCheckTs,
    isSuspicious: !!isSuspicious, // Force boolean type
  });

  // 3. AUDIT LOGGING
  auditLogger.log({
    level: "INFO",
    event: "LOGIN_SUCCESS_FINALIZED",
    userId,
    details: {
      ip: clientIp,
      isSuspicious: !!isSuspicious,
      sessionId: tokens.sessionId,
      device: deviceName,
    },
  });

  // 4. TELEMETRY & PERFORMANCE METRICS
  metricsClient.increment("auth.login.success", {
    flow: "login",
    isSuspicious: isSuspicious ? "true" : "false",
    role: existingUser.role,
  });

  metricsClient.timing("auth.login.generation_latency", Date.now() - startTime);

  // 5. UNIFIED RESPONSE OBJECT
  return {
    user: {
      userID: userId,
      role: existingUser.role,
      username: existingUser.username,
      email: existingUser.email,
      isSuspicious: !!isSuspicious,
    },
    ...tokens,
    mfaRequired: false, // Explicitly signals the frontend to clear MFA states
  };
};

/**
 * processUserLogin
 * ------------------------------------------------------------------
 * Enterprise Login Flow with Integrated Risk Assessment & MFA
 * ------------------------------------------------------------------
 */
const processUserLogin = async (identifier, password, context) => {
  const { ip: clientIp, userAgent, deviceName, session } = context;

  // 1. ROBUST FETCH (From your existing code)
  const user = await User.findOne({
    $or: [{ username: identifier }, { phone: identifier }, { email: identifier }],
  }).select("+password +failedLoginAttempts +isLocked +lockoutUntil +lastLoginLocation +mfaEnabled +passwordLastUpdated +isVerified +role");

  if (!user) throw new AuthenticationError("Invalid credentials provided.");

  // 2. SAFETY GUARDS (Your existing account locking logic)
  if (user.isLocked) {
     const now = new Date();
     if (user.lockoutUntil && user.lockoutUntil > now) {
        const remaining = Math.ceil((user.lockoutUntil - now) / 60000);
        throw new AuthenticationError(`Account locked. Try again in ${remaining} minutes.`);
     }
  }

  if (!user.isVerified) return { user: { userID: user._id }, accountUnverified: true };

  // 3. CREDENTIAL VERIFICATION
  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    await recordFailedAttempt(user._id, clientIp);
    throw new AuthenticationError("Invalid credentials provided.");
  }

  // 4. ADAPTIVE CONTEXT BUILDING
  // We move the "Risk Evaluation" inside the initiateMfa call 
  // to keep this controller clean.
  const userContext = {
    userId: user._id,
    email: user.email,
    isPrivileged: ["admin", "superadmin", "security"].includes(user.role),
    riskScore: user.riskScore || 0,
    lastLoginGeo: user.lastLoginLocation, 
    lastLoginAt: user.lastLoginAt,
    mfaEnabled: user.mfaEnabled 
  };

  const reqContext = { ip: clientIp, userAgent, session, traceId: uuidv4() };

  // 5. TRIGGER ADAPTIVE ENGINE
  // This handles: Impossible Travel, Zenith vs Absolute hashing, and challenge dispatch
  const mfaResult = await mfaService.initiateMfa(userContext, reqContext);

  // 6. DB UPDATES & RESPONSE
  await resetAttempts(user._id);
  await User.findByIdAndUpdate(user._id, { 
    lastLoginAt: new Date(), 
    lastLoginIp: clientIp 
  });

  return {
    user: { 
      userID: user._id, 
      role: user.role, 
      username: user.username 
    },
    ...mfaResult
  };
};

/* ===========================
 * 📝 OTP Resend Logic
 * =========================== */

/**
 * @desc Quantum Resend: High-reliability OTP regeneration with
 * idempotency, rate-limiting, and atomic outbox propagation.
 */
const resendVerificationOtp = async (token, context = {}) => {
  const { ip, userAgent } = context;

  // ---------------------------------------------------------
  // 1. IDEMPOTENCY LAYER
  // ---------------------------------------------------------
  // Prevents duplicate processing if the user double-clicks.
  const rawKey = context.idempotencyKey || `RESEND-${token.slice(-12)}-${ip}`;
  const idemKey = crypto
    .createHmac("sha256", process.env.IDEMPOTENCY_SECRET)
    .update(rawKey)
    .digest("hex");

  const completed = await IdempotencyService.getCachedResponse(
    idemKey,
    "OTP_RESEND",
  );
  if (completed) return completed.body;
  // ---------------------------------------------------------
  // 2. PRE-TRANSACTION VALIDATION & RATE LIMITING
  // ---------------------------------------------------------
  // We validate the token and check the rate limit in Redis BEFORE
  // opening a heavy Mongoose session/transaction.
  const initialUserCheck = await User.findByRawToken(token).select(
    "_id isVerified email",
  );
  if (!initialUserCheck || initialUserCheck.isVerified)
    throw new BadRequestError("Invalid state.");

  // Enforce rate limit (3 attempts per 10 mins) using Redis
  await resendRateLimiter.enforce(initialUserCheck._id.toString());

  // ---------------------------------------------------------
  // 3. ATOMIC TRANSACTION (User + Outbox)
  // ---------------------------------------------------------
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      // Re-fetch within session for ACID consistency
      const user = await User.findById(initialUserCheck._id).session(session);
      if (!user) throw new BadRequestError("User no longer exists.");

      const { otp, hashedOTP } = generateOTP();
      const rawNewToken = crypto.randomBytes(32).toString("hex");
      const hashedNewToken = hashToken(rawNewToken);

      // Update User State
      user.otp = hashedOTP;
      user.otpExpiry = new Date(
        Date.now() + (process.env.OTP_VALID_MINUTES || 10) * 60000,
      );
      user.verificationToken = hashedNewToken;
      user.verificationExpires = new Date(
        Date.now() + (process.env.TOKEN_VALID_MINUTES || 1440) * 60000,
      );
      user.lastResendAt = new Date();
      user.lastIp = ip;
      user.lastUserAgent = userAgent;

      await user.save({ session });

      // Create Outbox entry (The "Promise" to send the email)
      await Outbox.create(
        [
          {
            aggregateId: user._id,
            eventType: "OTP_RESEND",
            status: "PENDING",
            payload: { email: user.email, otp },
            idempotencyKey: idemKey,
          },
        ],
        { session },
      );

      return { userId: user._id.toString(), rawNewToken };
    });

    // ---------------------------------------------------------
    // 4. POST-COMMIT OPERATIONS
    // ---------------------------------------------------------

    // Save result to idempotency cache
    await IdempotencyService.persistResponse(
      idemKey,
      "/auth/otp-resend",
      200,
      result,
      "OTP_RESEND",
    );

    // Trigger "Fast Path": Proactively pokes the worker via Redis Pub/Sub
    // instead of waiting for the 1-minute cron poller.
    outboxWorker.triggerFastPath(context.traceId).catch(() => {});
    return result;
  } finally {
    session.endSession();
  }
};
/* ===========================
 * 📝 Account Verification Logic
 * =========================== */

/**
 * @desc Handles the final step of new user account verification (token + OTP).
 */
const verifyNewAccount = async (token, otp, context = {}) => {
  const session = await mongoose.startSession();
  const { ip, userAgent } = context;
  const rawKey = context.idempotencyKey || `VERIFY-${token.slice(-10)}-${otp}`;
  const idemKey = crypto
    .createHmac("sha256", process.env.IDEMPOTENCY_SECRET)
    .update(rawKey)
    .digest("hex");

  try {
    const cached = await IdempotencyService.getCachedResponse(
      idemKey,
      "ACCOUNT_VERIFY",
    );
    if (cached) return cached.body;

    const result = await session.withTransaction(async () => {
      const hashedToken = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");
      const user = await User.findOne({
        verificationToken: hashedToken,
        verificationExpires: { $gt: Date.now() },
      })
        .select("+otp +otpExpiry")
        .session(session);

      if (!user) throw new BadRequestError("Invalid token.");
      await otpRateLimiter.enforce(user._id.toString(), ip);

      const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");
      if (
        !timingSafeEqual(
          Buffer.from(hashedOtp, "hex"),
          Buffer.from(user.otp, "hex"),
        )
      ) {
        throw new BadRequestError("Invalid OTP.");
      }

      user.isVerified = true;
      await user.save({ session });

      const tokens = await identityService.generateAuthTokens({
        id: user._id.toString(),
        role: user.role,
        ip,
        userAgent,
      });

      await Outbox.create(
        [
          {
            aggregateId: user._id,
            eventType: "ACCOUNT_VERIFIED",
            status: "PENDING",
            payload: { userId: user._id },
            idempotencyKey: idemKey,
          },
        ],
        { session },
      );

      return { userId: user._id.toString(), ...tokens };
    });

    await IdempotencyService.persistResponse(
      idemKey,
      "/auth/verify",
      200,
      result,
      "ACCOUNT_VERIFY",
    );
    outboxWorker.triggerFastPath(context.traceId).catch(() => {});
    return result;
  } finally {
    session.endSession();
  }
};

/* ===========================
 * 🔐 Password Management
 * =========================== */

/**
 * THE ZENITH PASSWORD ROTATION (Manual Update)
 * Enforces history limits, entropy checks, and atomic outbox dispatch.
 */
const updateUserPassword = async (
  userId,
  oldPassword,
  newPassword,
  reqContext = {},
) => {
  const session = await mongoose.startSession();
  const rawKey =
    reqContext.idempotencyKey ||
    `${userId}-PWD-${new Date().toISOString().slice(0, 13)}`;
  const normalizedKey = crypto
    .createHmac("sha256", process.env.IDEMPOTENCY_SECRET)
    .update(rawKey)
    .digest("hex");

  try {
    const completed = await IdempotencyService.getCachedResponse(
      normalizedKey,
      "PASSWORD_ROTATION",
    );
    if (completed) return completed.body;

    const identity = await User.findById(userId).select("role");
    const entropy = calculatePasswordRisk(newPassword, identity.role);
    if (!entropy.isViable) throw new BadRequestError(entropy.recommendation);

    await passwordHistoryService.checkPasswordHistory(userId, newPassword);

    const result = await session.withTransaction(async () => {
      const user = await User.findById(userId)
        .select("+password +passwordLastUpdated")
        .session(session);
      if (!(await user.comparePassword(oldPassword)))
        throw new AuthenticationError("Verification failed.");

      user.password = newPassword;
      user.passwordLastUpdated = new Date();
      await user.save({ session });

      await passwordHistoryService.saveNewPasswordHash(userId, user.password, {
        session,
      });

      await Outbox.create(
        [
          {
            aggregateId: userId,
            eventType: "PASSWORD_ROTATED",
            status: "PENDING",
            payload: { userId, entropyScore: entropy.entropy },
            idempotencyKey: normalizedKey,
          },
        ],
        { session },
      );

      return { status: "SECURE", entropyScore: entropy.entropy };
    });

    await IdempotencyService.persistResponse(
      normalizedKey,
      "/auth/password-update",
      200,
      result,
      "PASSWORD_ROTATION",
    );
    outboxWorker.triggerFastPath(reqContext.traceId).catch(() => {});
    return result;
  } finally {
    session.endSession();
  }
};

/* ===========================
 * 📝 New User Registration
 * =========================== */

/**
 * THE ZENITH USER REGISTRATION (Quantum Flow)
 * Pattern: Fail-Fast Validation + Transactional Outbox + Idempotency
 */
const registerUser = async (registrationData, context = {}) => {
  const { email, username, password, role = "user" } = registrationData;
  const entropy = calculatePasswordRisk(password, role);
  if (!entropy.isViable) throw new BadRequestError(entropy.recommendation);

  const session = await mongoose.startSession();
  const rawKey = context.idempotencyKey || `REGISTER-${email}`;
  const idemKey = crypto
    .createHmac("sha256", process.env.IDEMPOTENCY_SECRET)
    .update(rawKey)
    .digest("hex");

  try {
    const completed = await IdempotencyService.getCachedResponse(
      idemKey,
      "USER_REGISTER",
    );
    if (completed) return completed.body;

    const result = await session.withTransaction(async () => {
      const existing = await User.findOne({
        $or: [{ email }, { username }],
      }).session(session);
      if (existing) throw new BadRequestError("User already exists.");

      const { otp, hashedOTP } = generateOTP();
      const rawToken = crypto.randomBytes(32).toString("hex");

      const userArray = await User.create(
        [
          {
            email,
            username,
            password,
            role,
            isVerified: false,
            otp: hashedOTP,
            verificationToken: hashToken(rawToken),
            passwordLastUpdated: new Date(),
          },
        ],
        { session },
      );

      const newUser = userArray[0];
      await passwordHistoryService.saveNewPasswordHash(
        newUser._id,
        newUser.password,
        { session },
      );

      await Outbox.create(
        [
          {
            aggregateId: newUser._id,
            eventType: "USER_REGISTERED",
            status: "PENDING",
            payload: { email, otp, userId: newUser._id },
            idempotencyKey: idemKey,
          },
        ],
        { session },
      );

      return { userId: newUser._id, rawVerificationToken: rawToken };
    });

    await IdempotencyService.persistResponse(
      idemKey,
      "/auth/register",
      201,
      result,
      "USER_REGISTER",
    );
    outboxWorker.triggerFastPath(context.traceId).catch(() => {});
    return result;
  } finally {
    session.endSession();
  }
};
/* ===========================
 * 🔑 Password Reset Flow (Initiate & Complete)
 * =========================== */

/**
 * THE ZENITH PASSWORD RESET COMPLETION
 * Validates reset token and enforces history constraints.
 */
/**
 * @desc Finalizes the password reset flow using a secure token and history enforcement.
 */
const completePasswordReset = async (token, newPassword, context = {}) => {
  const session = await mongoose.startSession();
  const traceId = context.traceId || "internal-gen";

  try {
    const rawKey = context.idempotencyKey || `PWD-RESET-${token.slice(-12)}`;
    const idemKey = crypto
      .createHmac("sha256", process.env.IDEMPOTENCY_SECRET)
      .update(rawKey)
      .digest("hex");

    const completed = await IdempotencyService.getCachedResponse(
      idemKey,
      "PWD_RESET",
    );
    if (completed) return completed.body;

    // 🚀 1. PRE-TRANSACTION VALIDATION
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const tempUser = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select("_id");

    if (!tempUser) throw new BadRequestError("Reset token invalid or expired.");

    // 🚀 2. ENFORCE HISTORY POLICY (CPU-Bound)
    await passwordHistoryService.checkPasswordHistory(
      tempUser._id,
      newPassword,
      { traceId },
    );

    const result = await session.withTransaction(async () => {
      const user = await User.findById(tempUser._id).session(session);

      user.password = newPassword;
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      user.passwordLastUpdated = new Date();

      await user.save({ session });

      // Save to History within the same transaction
      await passwordHistoryService.saveNewPasswordHash(
        user._id,
        user.password,
        { session, traceId },
      );

      // 🚀 3. ATOMIC OUTBOX INJECTION
      await Outbox.create(
        [
          {
            aggregateId: user._id,
            traceId,
            idempotencyKey: idemKey,
            eventType: "PASSWORD_RESET",
            status: "PENDING",
            payload: { userId: user._id, revokeSessions: true },
          },
        ],
        { session },
      );

      return { success: true };
    });

    await IdempotencyService.persistResponse(
      idemKey,
      "/auth/reset/complete",
      200,
      result,
      "PWD_RESET",
    );
    outboxWorker.triggerFastPath(traceId).catch(() => {});
    return result;
  } finally {
    session.endSession();
  }
};

/* =================================================================================
 * 👑 MFA & IDENTITY FINALIZATION
 * ================================================================================= */

/**
 * @desc Finalizes the authentication flow after successful MFA verification.
 */
const completeMfaLogin = async (mfaNonce, mfaCode, context) => {
  const { ip: clientIp, userAgent, deviceName, isSuspicious } = context;
  const dbSession = await mongoose.startSession();

  try {
    dbSession.startTransaction();

    // 1. VERIFY MFA VIA ADAPTIVE ENGINE
    const mfaStatus = await mfaService.verifyMfa(mfaNonce, mfaCode);
    const userId = mfaStatus.userId;

    // 2. FETCH IDENTITY DATA
    const existingUser = await User.findById(userId)
      .select("+role +username +email +lastPasswordCheck")
      .session(dbSession)
      .lean();

    if (!existingUser)
      throw new InternalServerError("User context lost during transaction.");

    // 3. TRANSACTIONAL OUTBOX ENTRY
    await Outbox.create(
      [
        {
          aggregateId: userId,
          traceId: context.traceId,
          eventType: "MFA_AUTHENTICATION_FINALIZED",
          payload: { nonce: mfaNonce, ip: clientIp, timestamp: new Date() },
          status: "PENDING",
        },
      ],
      { session: dbSession },
    );

    // 4. GENERATE TOKENS (Inside Transaction)
    const authResult = await generateLoginTokens({
      userId,
      existingUser,
      deviceName,
      userAgent,
      clientIp,
      lastPasswordCheck: existingUser.lastPasswordCheck,
      isSuspicious: isSuspicious || false,
    });

    await dbSession.commitTransaction();
    return authResult;
  } catch (error) {
    await dbSession.abortTransaction();
    throw error;
  } finally {
    dbSession.endSession();
  }
};

/* =================================================================================
 * 🔄 SESSION MANAGEMENT & TOKEN ROTATION
 * ================================================================================= */

/**
 * @desc Rotates a Refresh Token pair using reuse-detection logic.
 */
const refreshUserTokens = async (oldRefreshToken, context) => {
  const { ip: clientIp } = context;

  const validationResult =
    await identityService.validateRefreshToken(oldRefreshToken);

  if (!validationResult.isValid) {
    if (validationResult.userId) {
      await logoutAllDevices(validationResult.userId, {
        ip: clientIp,
        reason: "REUSE_DETECTED",
      });
    }
    throw new AuthenticationError("Session expired or invalid token.");
  }

  const { userId, role } = validationResult;

  const newTokens = await identityService.rotateAuthTokens({
    oldRefreshToken,
    id: userId,
    role,
    ip: clientIp,
  });

  const user = await User.findById(userId).select("username email role").lean();
  if (!user) throw new InternalServerError("Identity resolution failure.");

  return {
    accessToken: newTokens.accessToken,
    newRefreshToken: newTokens.refreshToken,
    csrfToken: newTokens.csrfToken,
    user: { id: userId, role: user.role, isSuspicious: false },
  };
};

/**
 * @desc Dispatches a logout security event to the Outbox worker via Circuit Breaker.
 */
const emitLogoutEvent = async (payload, session = null) => {
  const { userId, traceId } = payload;
  try {
    const outboxRecords = await Outbox.create(
      [
        {
          aggregateId: userId,
          traceId: traceId,
          eventType: "SECURITY_LOGOUT_AUDIT",
          payload: { ...payload, occurredAt: new Date().toISOString() },
          status: "PENDING",
        },
      ],
      { session },
    );

    const eventId = outboxRecords[0]._id;

    securityServiceBreaker
      .fire("jobs", {
        name: "auth.security_logout_relay",
        data: { eventId, ...payload },
      })
      .catch((err) =>
        Logger.warn("LOGOUT_DISPATCH_DELAYED", {
          eventId,
          reason: err.message,
        }),
      );
  } catch (err) {
    Logger.error("CRITICAL_LOGOUT_AUDIT_FAILURE", {
      userId,
      error: err.message,
    });
  }
};

const logoutUserSession = async ({ refreshToken, userId, context }) => {
  const payload = {
    refreshToken,
    userId,
    context: { ...context, type: "SINGLE_DEVICE_LOGOUT" },
  };
  await emitLogoutEvent(payload);
};

const logoutAllDevices = async (userId, context) => {
  if (!userId) throw new AuthenticationError("User ID required.");
  await identityService.revokeAllTokens(userId);
  await emitLogoutEvent({
    userId,
    context: { ...context, type: "GLOBAL_LOGOUT" },
  });
};

/* =================================================================================
 * 🛡️ WORKER LOGIC & TOKEN REVOCATION
 * ================================================================================= */

const revokeSessionAndCleanup = async (payload) => {
  const { refreshToken, userId, context: workerContext } = payload;
  const { ip: clientIp, type } = workerContext;
  let targetId = userId;

  if (!targetId && refreshToken) {
    try {
      const decoded = await identityService.decodeToken(refreshToken);
      targetId = decoded.sub;
    } catch (err) {
      /* Exception logged by wrapper */
    }
  }

  if (targetId) {
    if (type === "GLOBAL_LOGOUT" || type === "ADMIN_FORCED") {
      await identityService.revokeAllTokens(targetId);
    } else {
      await identityService.revokeSpecificSession({
        refreshToken,
        userId: targetId,
      });
    }

    // Trigger Real-Time Revocation (WebSocket Tier)
    await websocketService.notifyUserLogout({
      userId: targetId,
      sessionId: refreshToken
        ? crypto.createHash("md5").update(refreshToken).digest("hex")
        : "all",
      type: type || "SECURITY_REVOCATION",
    });

    securityService.sendLogoutEvent({ userId: targetId, ip: clientIp, type });
  } else {
    Logger.warn("LOGOUT_MISSING_TOKEN_REVOCATION_SKIPPED", {
      ip: clientIp,
      type,
    });
  }
};

/* =================================================================================
 * 🔐 WEBAUTHN / PASSWORDLESS IDENTITY
 * ================================================================================= */

const initiateWebAuthnRegistration = async (userId, username, context) => {
  return await webAuthnService.initiateWebAuthnRegistration(userId, username);
};

const registerWebAuthnCredential = async (userId, response, context = {}) => {
  const session = await mongoose.startSession();
  const traceId = context.traceId || "internal-gen";

  try {
    const rawKey = context.idempotencyKey || `WEBAUTHN-REG-${userId}`;
    const idemKey = crypto
      .createHmac("sha256", process.env.IDEMPOTENCY_SECRET)
      .update(rawKey)
      .digest("hex");

    const cached = await IdempotencyService.getCachedResponse(
      idemKey,
      "WEBAUTHN_REG",
    );
    if (cached) return cached.body;

    const result = await session.withTransaction(async () => {
      const regResult = await webAuthnService.registerWebAuthnCredential(
        userId,
        response,
      );

      await User.findByIdAndUpdate(
        userId,
        {
          $push: { credentials: regResult.credential },
          $set: { webAuthnEnabled: true },
        },
        { session },
      );

      await Outbox.create(
        [
          {
            aggregateId: userId,
            traceId,
            eventType: "WEBAUTHN_REGISTERED",
            payload: { credentialId: regResult.credential.id },
          },
        ],
        { session },
      );

      return { success: true, credentialId: regResult.credential.id };
    });

    await IdempotencyService.persistResponse(
      idemKey,
      "/webauthn/register",
      200,
      result,
      "WEBAUTHN_REG",
    );
    outboxWorker.triggerFastPath(traceId).catch(() => {});
    return result;
  } finally {
    session.endSession();
  }
};

const verifyWebAuthnAssertion = async (userId, assertionResponse, context) => {
  const user = await User.findById(userId);
  if (!user) throw new BadRequestError("User not found.");

  const dbCredential = user.credentials.find(
    (c) => c.id === assertionResponse.id,
  );
  const verification = await webAuthnService.verifyWebAuthnAssertion(
    userId,
    assertionResponse,
    dbCredential,
  );

  if (!verification.success)
    throw new AuthenticationError("WebAuthn verification failed.");

  dbCredential.counter = verification.newCounter;
  await user.save();

  return await identityService.generateAuthTokens({
    id: userId,
    role: user.role,
    deviceName: context.deviceName || "FIDO2 Authenticator",
    ip: context.ip,
  });
};

/* =================================================================================
 * 🛰️ UTILITY & SECURITY HELPERS
 * ================================================================================= */

const issueScopedJwt = async (
  userId,
  scopes,
  ttlSeconds = 300,
  context = {},
) => {
  if (!scopes || scopes.length === 0)
    throw new BadRequestError("Scopes required.");
  return await identityService.issueScopedJwt(
    { id: userId, scopes, ip: context.ip },
    ttlSeconds,
  );
};

const checkTokenValidityAndScope = async (accessToken, requiredScopes = []) => {
  const payload = await identityService.validateAccessToken(accessToken);
  const hasRequiredScope = requiredScopes.every((scope) =>
    payload.scopes?.includes(scope),
  );
  if (!hasRequiredScope) throw new ForbiddenError("Insufficient scope.");
  return payload;
};

const revokeUserTokenById = async (jti, userId, context = {}) => {
  const success = await identityService.revokeJti(jti);
  return { success };
};

const rotateSigningKey = async (keyType) => {
  await identityService.rotateSigningKey(keyType);
  return { success: true };
};

const enforceSecurityHeaders = async (context) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(nonce).digest("base64");
  return { nonce, nonceHash: `'sha256-${hash}'` };
};

const getPermissionsForUser = async (userId) => {
  const user = await User.findById(userId).select("role permissions").lean();
  if (!user) throw new BadRequestError("User not found.");
  const permissions = policyEngine.resolvePermissions(
    user.role,
    user.permissions,
  );
  return { userId, permissions };
};
/**
 * @desc Evaluates a request against a fine-grained access policy (ABAC).
 */
// --- 1. ABAC POLICY ENGINE ---

/** @desc Evaluates a request against a fine-grained access policy (ABAC). */
const evaluateAccessPolicy = async (
  userId,
  resource,
  action,
  requestAttributes,
) => {
  // Policy Engine evaluates user roles/permissions + runtime attributes
  const policyResult = await policyEngine.evaluate(
    userId,
    resource,
    action,
    requestAttributes,
  );

  if (!policyResult.authorized) {
    // Note: Logging and Metrics are now handled by the .instrument() failure block
    // if a ForbiddenError is thrown.
    throw new ForbiddenError(`Access denied: ${policyResult.reason}`, {
      metricReason: "POLICY_VIOLATION",
    });
  }

  return { authorized: true, details: policyResult.details };
};

/** @desc Manual override to record a policy violation. */
const recordPolicyViolation = async (
  userId,
  resource,
  action,
  reason,
  context,
) => {
  // This remains for manual hooks where an error isn't necessarily thrown
  auditLogger.log({
    level: "SECURITY",
    event: "ACCESS_POLICY_VIOLATION_MANUAL",
    userId,
    details: { resource, action, ip: context.ip, reason },
  });
  return { success: true };
};

// --- 2. SERVICE-TO-SERVICE (S2S) ---

/** @desc Fetches an M2M token for a calling microservice using its credentials. */
const getSystemM2mToken = async (serviceName, serviceSecret, context = {}) => {
  const token = await systemIdentityService.getM2mToken(
    serviceName,
    serviceSecret,
  );
  return { token };
};

/** @desc Validates an M2M token (used by other microservices to secure internal calls). */
const validateM2mToken = async (m2mToken, context = {}) => {
  const authHeader = m2mToken.startsWith("Bearer ")
    ? m2mToken
    : `Bearer ${m2mToken}`;
  const payload = await systemIdentityService.validateM2mToken(authHeader);
  return payload;
};

// --- 3. HEALTH & OPERATIONS ---

let authHealthMonitorInstance = null;

/** @desc IoC Dependency Injection for the Health Monitor. */
const initialize = (dependencies) => {
  if (!dependencies || !dependencies.healthMonitor) {
    throw new Error(
      'AuthService initialization failed: Missing "healthMonitor".',
    );
  }
  authHealthMonitorInstance = dependencies.healthMonitor;
  Logger.info(
    "AuthService initialized successfully with injected dependencies.",
  );
};

/** @desc Deep Health Check (Readiness). */
const getAuthServiceHealth = async (context = {}) => {
  if (!authHealthMonitorInstance)
    return { overallStatus: "UNAVAILABLE", overallMessage: "IoC Missing." };

  const report = await authHealthMonitorInstance.getReadinessReport();
  const statusMap = {
    OK: 1,
    WARMING_UP: 0.7,
    DEGRADED: 0.5,
    INITIALIZING: 0.3,
    UNAVAILABLE: 0,
  };

  metricsClient.gauge(
    "auth.health.status",
    statusMap[report.overallStatus] || 0,
    {
      status: report.overallStatus,
      phase: report.checks?.currentStartupPhase || "unknown",
    },
  );

  return report;
};

/** @desc Shallow Health Check (Liveness). */
const getAuthServiceLiveness = async (context = {}) => {
  if (!authHealthMonitorInstance) return { overallStatus: "UNAVAILABLE" };
  return authHealthMonitorInstance.getLivenessReport();
};

// --- 4. DEVELOPER UTILITIES ---

/** @desc Administrator utility to generate a token for another user. */
const impersonateUser = async (adminId, targetId, context) => {
  if (adminId === targetId)
    throw new BadRequestError("Cannot impersonate self.");

  const targetUser = await User.findById(targetId)
    .select("role lastPasswordCheck")
    .lean();
  if (!targetUser) throw new BadRequestError("Target user not found.");

  const tokens = await identityService.generateAuthTokens({
    id: targetId,
    role: targetUser.role,
    isSuspicious: false,
    ip: context.ip,
    lastPasswordCheck: targetUser.lastPasswordCheck.getTime(),
    impersonatorId: adminId,
  });

  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
};

/** @desc Test utility for generating tokens with mock claims. */
const generateTestToken = async (claims, context = {}) => {
  const token = await identityService.generateTestToken(claims);
  return { token };
};

// --- 5. COMPLIANCE (GDPR/CCPA) ---

/** @desc Triggers user data anonymization across the aggregate via Outbox. */
const anonymizeUserSessionHistory = async (userId, context) => {
  const session = await mongoose.startSession();
  const { traceId, reason } = context;

  try {
    const result = await session.withTransaction(async () => {
      // 1. Authoritative mutation
      await User.findByIdAndUpdate(
        userId,
        {
          $set: {
            lastLoginIp: null,
            lastLoginLocation: null,
            complianceAnonymizedAt: new Date(),
          },
        },
        { session },
      );

      // 2. Canonical Outbox event for downstream propagation
      await Outbox.create(
        [
          {
            aggregateId: userId,
            traceId,
            eventType: "USER_DATA_ANONYMIZATION_REQUESTED",
            payload: {
              userId,
              reason: reason || "GDPR_ERASURE",
              requestedAt: new Date(),
            },
          },
        ],
        { session },
      );

      return { success: true };
    });

    outboxWorker.triggerFastPath(traceId).catch(() => {});
    return result;
  } finally {
    session.endSession();
  }
};

/** @desc Retrieves immutable audit record. */
const getAuditLogForUser = async (userId, dateRange, context = {}) => {
  const logs = await auditLogger.getLogsByUserId(userId, dateRange);
  return { userId, logs, count: logs.length };
};

/* ===========================
 * 🚀 Exports
 * =========================== */

module.exports = {
  // Core Flows
  processUserLogin: instrument("login.core", processUserLogin),
  registerUser: instrument("user.register", registerUser),
  verifyNewAccount: instrument("account.verify", verifyNewAccount),
  resendVerificationOtp: instrument("otp.resend", resendVerificationOtp),
  updateUserPassword: instrument("password.update", updateUserPassword),
  // Password Management
  // Reset & MFA
  completePasswordReset: instrument(
    "password.reset_complete",
    completePasswordReset,
  ),
  completeMfaLogin: instrument("mfa.complete", completeMfaLogin),

  // Tokens & Sessions
  refreshUserTokens: instrument("token.refresh", refreshUserTokens),
  logoutUserSession: instrument("logout.single", logoutUserSession),
  logoutAllDevices: instrument("logout.global", logoutAllDevices),
  revokeSessionAndCleanup: instrument(
    "worker.revocation",
    revokeSessionAndCleanup,
  ),

  // Advanced Auth
  issueScopedJwt: instrument("token.issue_scoped", issueScopedJwt),
  checkTokenValidityAndScope: instrument(
    "token.validate_deep",
    checkTokenValidityAndScope,
  ),
  revokeUserTokenById: instrument("token.revoke_jti", revokeUserTokenById),
  rotateSigningKey: instrument("token.rotate_key", rotateSigningKey),

  // WebAuthn
  initiateWebAuthnRegistration: instrument(
    "webauthn.init_reg",
    initiateWebAuthnRegistration,
  ),
  registerWebAuthnCredential: instrument(
    "webauthn.register",
    registerWebAuthnCredential,
  ),
  verifyWebAuthnAssertion: instrument(
    "webauthn.verify",
    verifyWebAuthnAssertion,
  ),

  // Helpers
  enforceSecurityHeaders: instrument(
    "security.csp_headers",
    enforceSecurityHeaders,
  ),
  getPermissionsForUser: instrument(
    "policy.permissions",
    getPermissionsForUser,
  ),
  // Lifecycle
  initialize,

  // ABAC & Policy
  evaluateAccessPolicy: instrument("policy.evaluate", evaluateAccessPolicy),
  recordPolicyViolation: instrument(
    "policy.record_violation",
    recordPolicyViolation,
  ),

  // Service to Service
  getSystemM2mToken: instrument("s2s.get_token", getSystemM2mToken),
  validateM2mToken: instrument("s2s.validate_token", validateM2mToken),

  // Monitoring & Ops
  monitorTokenIssuanceRate, // Exported as-is or could be wrapped for trace visibility
  getAuthServiceHealth: instrument(
    "ops.health_readiness",
    getAuthServiceHealth,
  ),
  getAuthServiceLiveness: instrument(
    "ops.health_liveness",
    getAuthServiceLiveness,
  ),

  // Dev Utilities
  impersonateUser: instrument("dev.impersonate", impersonateUser),
  generateTestToken: instrument("dev.test_token", generateTestToken),

  // Compliance
  anonymizeUserSessionHistory: instrument(
    "compliance.anonymize",
    anonymizeUserSessionHistory,
  ),
  getAuditLogForUser: instrument("compliance.audit_log", getAuditLogForUser),

  //breaker
  emailDispatchBreaker,
  recordFailedAttempt,
  resetAttempts,
  generateLoginTokens,
};
