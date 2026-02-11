// =================================================================================
// services/systemIdentityService.js (ZENITH HYPER-FABRIC: FINAL CONSOLIDATED)
// =================================================================================

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const UnauthorizedError = require("../errors/unauthenication-error");
const Logger = require("../utils/logger");
const Tracing = require("../utils/tracingClient");
const Metrics = require("../utils/metricsClient");

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
    secret: process.env.M2M_PAYMENTS_SECRET || "super-secure-payments-secret",
    scopes: ["payment:*", "fraud:check"],
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
 * @desc Generates RSA Keypair and syncs to memory caches.
 * @param {string} keyId - Unique identifier for the key version.
 */
const fetchSigningKeyPair = async (keyId) => {
  return Tracing.withSpan("m2m.generateKeyPair", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    M2M_PUBLIC_KEYS_CACHE.set(keyId, publicKey);
    M2M_SIGNING_KEYS_ACTIVE.set(keyId, { key: privateKey, expires: null });
    return privateKey;
  });
};

/**
 * @desc Rotates keys and cleans up BOTH private and public caches.
 * @param {string} newKeyId - The new ID (usually a timestamp or UUID).
 */
const rotateSigningKey = async (newKeyId) => {
  const oldKeyId = CURRENT_KEY_ID;

  const oldEntry = M2M_SIGNING_KEYS_ACTIVE.get(oldKeyId);
  if (oldEntry) {
    oldEntry.expires = Date.now() + ROTATION_GRACE_PERIOD_MS;
  }

  await fetchSigningKeyPair(newKeyId);
  CURRENT_KEY_ID = newKeyId;

  // ⭐ CRITICAL FIX: Clean up both sides of the pair to prevent memory leaks
  setTimeout(() => {
    M2M_SIGNING_KEYS_ACTIVE.delete(oldKeyId);
    M2M_PUBLIC_KEYS_CACHE.delete(oldKeyId); // Don't leave old public keys in RAM forever
    Logger.info("M2M_KEY_PAIR_PURGED", { oldKeyId });
  }, ROTATION_GRACE_PERIOD_MS + 5000); // 5s extra buffer

  Logger.warn("M2M_KEY_ROTATION_COMPLETED", { oldKeyId, newKeyId });
};

/**
 * @desc Issues a signed JWT for M2M communication.
 */
const getM2mToken = async (clientId, clientSecret) => {
  return Tracing.withSpan("m2m.getM2mToken", async (span) => {
    if (M2M_SIGNING_KEYS_ACTIVE.size === 0) await fetchSigningKeyPair(CURRENT_KEY_ID);
    
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

    // Use the CURRENT key for signing
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

/**
 * @desc Validates the token against the public key cache.
 */
const validateM2mToken = async (authHeader) => {
  return Tracing.withSpan("m2m.validateToken", async (span) => {
    try {
      if (!authHeader?.startsWith("Bearer ")) throw new UnauthorizedError("Malformed Header.");
      
      const m2mToken = authHeader.split(" ")[1];
      const decoded = jwt.decode(m2mToken, { complete: true });
      
      if (!decoded?.header?.kid) throw new UnauthorizedError("JWT missing kid.");

      const publicKey = M2M_PUBLIC_KEYS_CACHE.get(decoded.header.kid);
      if (!publicKey) {
        // Option: In a cluster, if not in RAM, try fetching from Redis/DB here
        throw new UnauthorizedError("Key version expired or invalid.");
      }

      const payload = jwt.verify(m2mToken, publicKey, {
        algorithms: ["RS256"],
        audience: "internal-api",
        issuer: EXPECTED_ISSUER,
      });

      // Versioning (The Panic Button)
      const clientInfo = M2M_CLIENT_STORE[payload.sub];
      if (clientInfo && payload.version < clientInfo.securityVersion) {
        throw new UnauthorizedError("M2M token version revoked.");
      }

      return payload;
    } catch (error) {
      span.recordError(error);
      Metrics.increment("m2m.validation.fail", 1, { type: error.name });
      throw new UnauthorizedError(`M2M Denied: ${error.message}`);
    }
  });
};

/**
 * @desc Wildcard Scope Validation (e.g., 'user:*' grants 'user:read')
 */
const checkScopes = (payload, requiredScopes) => {
  const granted = payload.scopes || [];
  const required = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];

  const hasAccess = required.every((req) =>
    granted.some((grant) => {
      if (grant === req) return true; 
      if (grant.endsWith(":*")) {
        return req.startsWith(grant.slice(0, -2));
      }
      return false;
    })
  );

  if (!hasAccess) throw new UnauthorizedError("Insufficient M2M scopes.");
  return true;
};

module.exports = {
  getM2mToken,
  validateM2mToken,
  checkScopes,
  rotateSigningKey,
  getCurrentKeyId: () => CURRENT_KEY_ID,
};