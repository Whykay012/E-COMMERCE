/**
 * services/tokenRevocationService.js
 * ZENITH APEX - Extreme-Reliability Security State Orchestrator
 * Logic: Atomic LUA Sharding, Deterministic TTLs, and SHA-Optimized Purge.
 */

const { cacheConnection: redis } = require("../lib/redisCacheClient");
const { scriptHashes } = require("../lib/redisInitialization"); // ⭐ SHA-Optimized Script Hashes
const Logger = require("../utils/logger");
const Tracing = require("../utils/tracingClient");
const Metrics = require("../utils/metricsClient");

/**
 * @constant ZENITH_NS
 * Isolated Security Namespaces for Virtual Memory Segmentation
 */
const ZENITH_NS = {
  JTI_DENY: "zenith:auth:jti_bl:",
  SESS_META: "zenith:auth:sess:",
  AUTH_CHAL: "zenith:auth:chal:",
  SEC_LOCK: "zenith:auth:lockout:",
};

/**
 * @desc ZENITH ATOMIC BLACKLIST
 * Prevents "Replay Attacks" by committing the JTI to an O(1) Deny-List.
 */
exports.blacklistToken = async (jti, exp) => {
  if (!jti || !exp) return;

  return await Tracing.withSpan("identity.apex_blacklist", async (span) => {
    const timer = Date.now();
    try {
      const ttl = exp - Math.floor(Date.now() / 1000);
      if (ttl <= 0) return;

      const key = `${ZENITH_NS.JTI_DENY}${jti}`;
      const result = await redis.set(key, "1", "EX", ttl, "NX");

      if (!result) {
        Logger.warn("JTI_ALREADY_REVOKED", { jti });
      }

      // Telemetry Alignment
      Metrics.timing("security.jti_blacklist_ms", Date.now() - timer);
      Metrics.increment("security.token_revoked", 1);

      span.setAttributes({ "security.jti": jti, "security.ttl": ttl });
      return result;
    } catch (error) {
      Metrics.increment("security.blacklist_error", 1);
      Logger.error("APEX_BLACKLIST_CRITICAL_FAIL", { err: error.message, jti });
    }
  });
};

/**
 * @desc THE NUCLEAR PURGE (SHA-1 OPTIMIZED LUA)
 * Uses EVALSHA for sub-millisecond execution and atomicity.
 */
exports.purgeAllUserState = async (userId) => {
  return await Tracing.withSpan("identity.apex_nuclear_purge", async (span) => {
    const timer = Date.now();
    try {
      /**
       * ⭐ ZENITH APEX OPTIMIZATION:
       * Using evalsha instead of eval to execute pre-loaded logic.
       * Keys: 1. Challenge, 2. Session Root, 3. Lockout Root
       * ARGV[1]: The pattern for sharded sub-sessions.
       */
      const purgedCount = await redis.evalsha(
        scriptHashes.NUCLEAR_WIPE,
        3,
        `${ZENITH_NS.AUTH_CHAL}${userId}`,
        `${ZENITH_NS.SESS_META}${userId}`,
        `${ZENITH_NS.SEC_LOCK}${userId}`,
        `${ZENITH_NS.SESS_META}${userId}:`
      );

      const duration = Date.now() - timer;

      // Zenith Apex Telemetry
      Metrics.timing("security.nuclear_purge_ms", duration);
      Metrics.increment("security.artifacts_destroyed", purgedCount);

      Logger.critical("IDENTITY_NUCLEAR_WIPE_EXECUTED", {
        userId,
        artifactsDestroyed: purgedCount,
        duration,
      });

      span.setAttributes({
        "purge.user_id": userId.toString(),
        "purge.count": purgedCount,
        "purge.status": "SUCCESS",
      });

      return true;
    } catch (error) {
      /**
       * FALLBACK LOGIC:
       * If Redis is flushed or the script hash is missing (NOSCRIPT),
       * we log a warning. Note: The initSecurityScripts should be
       * re-run on Redis reconnection.
       */
      Metrics.increment("security.purge_failure", 1);
      Logger.error("APEX_PURGE_SYSTEM_FAILURE", {
        userId,
        err: error.message,
        code: error.message.includes("NOSCRIPT") ? "EVALSHA_MISS" : "REDIS_ERR",
      });
      return false;
    }
  });
};

/**
 * @desc APEX JTI VERIFICATION
 * Ultra-low latency check for middleware layers.
 */
exports.isTokenBlacklisted = async (jti) => {
  if (!jti) return false;
  return await Tracing.withSpan("identity.verify_jti", async (span) => {
    try {
      const isBlacklisted =
        (await redis.exists(`${ZENITH_NS.JTI_DENY}${jti}`)) === 1;

      if (isBlacklisted) {
        Metrics.increment("security.blocked_request_jti", 1);
      }

      return isBlacklisted;
    } catch (error) {
      // Fail-open strategy: Secondary protection provided by DB securityVersion
      Logger.error("REDIS_AVAILABILITY_INCIDENT", { jti, err: error.message });
      return false;
    }
  });
};
