/**
 * services/adaptiveMfaEngine.js
 * High-Availability Adaptive MFA Engine (Zenith + Absolute Unified)
 */

const crypto = require("crypto");
const { timingSafeEqual } = crypto;
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);

const mfaTokenStore = require("./redisMfaStore");
const Outbox = require("../models/Outbox");
const Tracing = require("../utils/tracingClient");
const Metrics = require("../utils/metricsClient");
const Logger = require("../utils/logger");
// Import the breaker from your authService or breaker config
const { emailDispatchBreaker } = require("./authService");
const InternalServerError = require("../errors/internal-server-error");
const UnauthorizedError = require("../errors/unauthenication-error");
const BadRequestError = require("../errors/bad-request-error");
const TooManyRequestError = require("../errors/bad-request-error");

const CFG = {
  TTL_SEC: 300, // 5 Minutes
  MAX_ATTEMPTS: 3, // Strict lockout threshold
  SHA_ALGO: "sha512",
  // Production-grade Scrypt parameters for high-risk (ABSOLUTE) users
  SCRYPT_PARAMS: { N: 131072, r: 8, p: 1 },
  NONCE_SIZE_ZENITH: 32,
  NONCE_SIZE_ABSOLUTE: 64,
};

/**
 * RESOLVE POLICY
 * Private helper to determine hashing cost based on risk factors
 */
function resolvePolicy(userContext) {
  const { isPrivileged, riskScore, isNewDevice } = userContext;

  // High Risk: Admin roles, score >= 70, or unrecognized device
  if (isPrivileged || riskScore >= 70 || isNewDevice) {
    return "ABSOLUTE"; // Memory-hard hashing (Slow/Expensive)
  }
  return "ZENITH"; // Standard fast hashing (Normal)
}

/**
 * TIMING MITIGATION
 * Prevents attackers from using API response times to guess if a nonce exists
 */
async function performTimingAttackMitigation() {
  const dummySalt = crypto.randomBytes(32);
  const dummyCode = "000000";
  // Simulate the scrypt delay even on failure to normalize response time
  await scrypt(dummyCode, dummySalt, 64, CFG.SCRYPT_PARAMS);
}

/**
 * INITIATE MFA
 * Handles nonce generation, adaptive hashing, and breaker-protected dispatch
 */
exports.initiateMfa = async (userContext, reqContext = {}) => {
  return Tracing.withSpan("mfa.initiate.adaptive", async (span) => {
    const { userId, email } = userContext;
    const { session, traceId, ip } = reqContext;

    const mode = resolvePolicy(userContext);

    // 1. NONCE & CODE GENERATION
    const nonce = crypto
      .randomBytes(
        mode === "ABSOLUTE" ? CFG.NONCE_SIZE_ABSOLUTE : CFG.NONCE_SIZE_ZENITH
      )
      .toString("base64url");

    const rawCode = crypto.randomInt(100000, 999999).toString();

    // 2. STATE PREPARATION
    let state;
    if (mode === "ZENITH") {
      const hash = crypto
        .createHash(CFG.SHA_ALGO)
        .update(rawCode)
        .digest("hex");
      state = { u: userId, m: "ZENITH", h: hash, a: 0, ip };
    } else {
      const salt = crypto.randomBytes(32);
      const proof = await scrypt(rawCode, salt, 64, CFG.SCRYPT_PARAMS);
      state = {
        u: userId,
        m: "ABSOLUTE",
        p: proof.toString("hex"),
        s: salt.toString("hex"),
        a: 0,
        ip,
      };
    }

    // 3. PERSISTENCE (REDIS SENTINEL)
    try {
      await mfaTokenStore.setMfaState(nonce, state, CFG.TTL_SEC);
    } catch (err) {
      Logger.error("MFA_REDIS_FAILURE", { userId, error: err.message });
      throw new InternalServerError("Security store unreachable.");
    }

    // 4. TRANSACTIONAL OUTBOX (MONGODB)
    // Recorded within the current DB session to ensure atomicity
    const outboxRecords = await Outbox.create(
      [
        {
          aggregateId: userId,
          traceId,
          eventType: "MFA_CHALLENGE_DISPATCH",
          payload: {
            code: rawCode,
            mode,
            target: email,
            nonce,
          },
          status: "PENDING",
        },
      ],
      { session }
    );

    const eventId = outboxRecords[0]._id;

    // 5. ASYNC DISPATCH (CIRCUIT BREAKER)
    // Non-blocking trigger. If breaker is OPEN, the Outbox Poller recovers the job.
    emailDispatchBreaker
      .fire("jobs", {
        name: "auth.mfa_relay",
        data: { eventId },
      })
      .catch((err) => {
        Logger.warn("MFA_DISPATCH_QUEUING_DELAYED", {
          eventId,
          reason: err.message,
        });
        Metrics.increment("security.mfa.dispatch_retried_later");
      });

    Metrics.increment("security.mfa.initiated", { mode });
    span.setAttributes({ "user.id": userId, mode, "request.ip": ip });

    return {
      mfaRequired: true,
      mfaMode: mode,
      mfaNonce: nonce,
      expiresIn: CFG.TTL_SEC,
    };
  });
};

/**
 * VERIFY MFA
 * Atomic verification with rate-limiting and brute-force protection
 */
exports.verifyMfa = async (nonce, providedCode) => {
  return Tracing.withSpan("mfa.verify.adaptive", async (span) => {
    // 1. ATOMIC FETCH & INCREMENT
    // mfaTokenStore handles the INCR of the 'a' (attempts) field in Redis
    const state = await mfaTokenStore.atomicIncrementAndFetch(nonce);

    // 2. SECURITY CHECKS
    if (!state) {
      await performTimingAttackMitigation();
      throw new UnauthorizedError("MFA Session expired or invalid.");
    }

    if (state.a > CFG.MAX_ATTEMPTS) {
      Logger.warn("MFA_BRUTE_FORCE_DETECTED", {
        userId: state.u,
        attempts: state.a,
      });
      Metrics.increment("security.mfa.lockout", { userId: state.u });
      throw new TooManyRequestsError("Too many attempts. MFA session locked.");
    }

    let valid = false;

    // 3. POLICY-BASED CRYPTOGRAPHIC VERIFICATION
    if (state.m === "ZENITH") {
      const inputHash = crypto
        .createHash(CFG.SHA_ALGO)
        .update(providedCode)
        .digest("hex");
      valid = timingSafeEqual(
        Buffer.from(state.h, "hex"),
        Buffer.from(inputHash, "hex")
      );
    } else {
      // Memory-hard verification for ABSOLUTE mode
      const test = await scrypt(
        providedCode,
        Buffer.from(state.s, "hex"),
        64,
        CFG.SCRYPT_PARAMS
      );
      valid = timingSafeEqual(Buffer.from(state.p, "hex"), test);
    }

    // 4. RESULT HANDLING
    if (!valid) {
      Metrics.increment("security.mfa.failed", { mode: state.m });
      throw new UnauthorizedError(
        `Invalid code. ${CFG.MAX_ATTEMPTS - state.a} attempts remaining.`
      );
    }

    // Success: Token is valid. We destroy the nonce immediately.
    await mfaTokenStore.destroy(nonce);

    Metrics.increment("security.mfa.success", { mode: state.m });
    Logger.info("MFA_VERIFIED", { userId: state.u, mode: state.m });

    return { userId: state.u, status: "VERIFIED" };
  });
};

/**
 * CLEANUP SESSION
 * Used by the background Outbox worker to purge Redis after a finalized login
 */
exports.cleanupSession = async (nonce) => {
  if (!nonce) return;
  return await mfaTokenStore.destroy(nonce);
};
