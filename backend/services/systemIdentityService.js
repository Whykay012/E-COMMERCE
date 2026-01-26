// =================================================================================
// services/systemIdentityService.js (ZENITH HYPER-FABRIC: FINAL CONSOLIDATED)
// =================================================================================

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const UnauthorizedError = require("../errors/unauthenication-error");
const InternalServerError = require("../errors/internal-server-error");
const Logger = require("../utils/logger");
const Tracing = require("../utils/tracingClient");
const Metrics = require("../utils/metrics");

// --- Configuration ---
const M2M_TOKEN_TTL_SECONDS = 300;
const EXPECTED_ISSUER = "auth-service";
const ROTATION_GRACE_PERIOD_MS = 60000; // 60s overlap for signing

// --- Module State ---
let CURRENT_KEY_ID = "zenith-m2m-key-2025";
const M2M_PUBLIC_KEYS_CACHE = new Map(); // kid -> Public Key

// ⭐ Point 1: Grace Period Cache (Private Keys)
// Stores [Private Key, Expiry] to allow signing with "old" keys during rotation
const M2M_SIGNING_KEYS_ACTIVE = new Map();

const M2M_CLIENT_STORE = {
  "payments-processor": {
    secret: "super-secure-payments-secret",
    scopes: ["payment:*", "fraud:check"], // ⭐ Point 2: Wildcards
    issuer: EXPECTED_ISSUER,
    securityVersion: 1,
  },
  "data-miner": {
    secret: "data-miner-secret-456",
    scopes: ["user:read-basic", "audit:write"],
    issuer: EXPECTED_ISSUER,
    securityVersion: 1,
  },
};

/**
 * @desc Generates/Fetches RSA Keypair and updates caches.
 */
const fetchSigningKeyPair = async (keyId) => {
  return Tracing.withSpan("m2m.generateKeyPair", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    M2M_PUBLIC_KEYS_CACHE.set(keyId, publicKey);
    // Set no expiry on the "Current" private key
    M2M_SIGNING_KEYS_ACTIVE.set(keyId, { key: privateKey, expires: null });
    return privateKey;
  });
};

const initialize = async () => {
  if (M2M_SIGNING_KEYS_ACTIVE.size === 0) {
    await fetchSigningKeyPair(CURRENT_KEY_ID);
    Logger.info("SYSTEM_IDENTITY_INITIALIZED", { keyId: CURRENT_KEY_ID });
  }
};

/**
 * @desc ⭐ POINT 1 IMPLEMENTED: Graceful Rotation
 * Prevents race conditions by keeping the old private key active for 60s.
 */
const rotateSigningKey = async (newKeyId) => {
  const oldKeyId = CURRENT_KEY_ID;

  // 1. Mark old key for expiration
  const oldEntry = M2M_SIGNING_KEYS_ACTIVE.get(oldKeyId);
  if (oldEntry) {
    oldEntry.expires = Date.now() + ROTATION_GRACE_PERIOD_MS;
  }

  // 2. Generate and set the NEW current key
  await fetchSigningKeyPair(newKeyId);
  CURRENT_KEY_ID = newKeyId;

  // 3. Cleanup Task: Remove expired private keys from memory
  setTimeout(() => {
    M2M_SIGNING_KEYS_ACTIVE.delete(oldKeyId);
    Logger.info("M2M_OLD_PRIVATE_KEY_PURGED", { oldKeyId });
  }, ROTATION_GRACE_PERIOD_MS);

  Logger.alert("M2M_KEY_ROTATION_STARTED", { oldKeyId, newKeyId });
};

/**
 * @desc ⭐ POINT 3 IMPLEMENTED: Tracing & Metrics
 */
const getM2mToken = async (clientId, clientSecret) => {
  return Tracing.withSpan("m2m.getM2mToken", async (span) => {
    await initialize();
    const clientInfo = M2M_CLIENT_STORE[clientId];

    if (!clientInfo || clientInfo.secret !== clientSecret) {
      span.setAttribute("auth.success", false);
      Metrics.increment("m2m.auth.fail", 1, { clientId });
      throw new UnauthorizedError("Invalid client credentials.");
    }

    const payload = {
      sub: clientId,
      aud: "internal-api",
      scopes: clientInfo.scopes,
      version: clientInfo.securityVersion || 0,
      type: "m2m",
    };

    const token = jwt.sign(
      payload,
      M2M_SIGNING_KEYS_ACTIVE.get(CURRENT_KEY_ID).key,
      {
        algorithm: "RS256",
        expiresIn: M2M_TOKEN_TTL_SECONDS,
        issuer: EXPECTED_ISSUER,
        keyid: CURRENT_KEY_ID,
      }
    );

    Metrics.increment("m2m.token.issued", 1, { clientId });
    return token;
  });
};

const validateM2mToken = async (authHeader) => {
  return Tracing.withSpan("m2m.validateToken", async (span) => {
    try {
      const m2mToken = authHeader.replace("Bearer ", "");
      const decodedHeader = jwt.decode(m2mToken, { complete: true })?.header;

      if (!decodedHeader?.kid) throw new UnauthorizedError("JWT missing kid.");

      const publicKey = M2M_PUBLIC_KEYS_CACHE.get(decodedHeader.kid);
      if (!publicKey) throw new UnauthorizedError("Public key not found.");

      const payload = jwt.verify(m2mToken, publicKey, {
        algorithms: ["RS256"],
        audience: "internal-api",
        issuer: EXPECTED_ISSUER,
      });

      // Panic Button Check
      const clientInfo = M2M_CLIENT_STORE[payload.sub];
      if (clientInfo && payload.version < clientInfo.securityVersion) {
        throw new UnauthorizedError("M2M token revoked by security version.");
      }

      return payload;
    } catch (error) {
      Metrics.increment("m2m.validation.fail", 1, { error: error.name });
      throw new UnauthorizedError(`M2M Denied: ${error.message}`);
    }
  });
};

/**
 * @desc ⭐ POINT 2 IMPLEMENTED: Wildcard Scope Hierarchy
 */
const checkScopes = (payload, requiredScopes) => {
  const granted = payload.scopes || [];
  const required = Array.isArray(requiredScopes)
    ? requiredScopes
    : [requiredScopes];

  const hasAccess = required.every((req) =>
    granted.some((grant) => {
      if (grant === req) return true; // Exact match
      if (grant.endsWith(":*")) {
        // Wildcard match
        const prefix = grant.slice(0, -2);
        return req.startsWith(prefix);
      }
      return false;
    })
  );

  if (!hasAccess) throw new UnauthorizedError("Insufficient M2M scopes.");
  return true;
};

module.exports = {
  initialize,
  getM2mToken,
  validateM2mToken,
  checkScopes,
  rotateSigningKey,
  getCurrentKeyId: () => CURRENT_KEY_ID,
};
