/**
 * 🛰️ ZENITH SECURITY ORCHESTRATOR (v4.1.0-PRO)
 * Features: Deep-Frozen State, Bit-Entropy Analysis, Risk-Based Backoff,
 * and ROLE-BASED POLICY OVERRIDES.
 */

const crypto = require("crypto");

// 1. IMMUTABLE POLICY SCHEMA (The Root of Trust)
const ROOT_SCHEMA = Object.freeze({
  COMPLEXITY: {
    MIN_ENTROPY: 60, // Bits of entropy required for "Strong" status
    MIN_LENGTH: 12,
    FORBIDDEN_PATTERNS: [/password/i, /12345/i, /qwerty/i],
  },
  RESILIENCE: {
    MAX_HISTORY: 5, // Default history for standard users
    SALT_ROUNDS: 12,
    EXPONENTIAL_BACKOFF_BASE: 2,
    MAX_LOCKOUT_MS: 86400000, // 24 Hour Cap
  },
  // 💡 UPGRADE: Role-specific overrides for high-privilege accounts
  ROLE_OVERRIDES: {
    admin: {
      RESILIENCE: { MAX_HISTORY: 24 }, // Admins cannot reuse last 24 passwords
      COMPLEXITY: { MIN_ENTROPY: 85, MIN_LENGTH: 16 }, // Admins need longer, complex passwords
    },
    moderator: {
      RESILIENCE: { MAX_HISTORY: 10 },
    },
  },
  IDENTITY: {
    SESSION_TTL: "1h",
    MFA_CHALLENGE_TTL: 300,
    JWT_ALGORITHM: "RS256",
  },
});

// 2. STATEFUL ENGINE (Private internal cache)
let _ACTIVE_POLICY = { ...ROOT_SCHEMA };

/* ===========================
 * 🧩 CORE ENGINE CAPABILITIES
 * =========================== */

/**
 * ⚡ HOT-SWAP: Injects new policies without process restart.
 */
exports.injectPolicyUpdate = (patch) => {
  _ACTIVE_POLICY = Object.freeze({
    ..._ACTIVE_POLICY,
    ...patch,
    COMPLEXITY: { ..._ACTIVE_POLICY.COMPLEXITY, ...patch.COMPLEXITY },
    RESILIENCE: { ..._ACTIVE_POLICY.RESILIENCE, ...patch.RESILIENCE },
    ROLE_OVERRIDES: {
      ..._ACTIVE_POLICY.ROLE_OVERRIDES,
      ...patch.ROLE_OVERRIDES,
    },
  });
  console.log(
    `[SECURITY_ENGINE] Policy Hot-Swapped at ${new Date().toISOString()}`
  );
};

/**
 * 🧠 BIT-ENTROPY EVALUATOR: Calculates the actual mathematical strength of a string.
 * Uses the Shannon Entropy formula: H = -Σ P_i log2(P_i)
 */
exports.calculatePasswordRisk = (password, role = "user") => {
  if (!password) return { entropy: 0, risk: "CRITICAL" };

  // Fetch the correct thresholds based on role
  const config = this.getRoleEffectiveConfig(role);

  const len = password.length;
  const frequencies = {};
  for (let char of password) {
    frequencies[char] = (frequencies[char] || 0) + 1;
  }

  const entropy =
    Object.values(frequencies).reduce((acc, freq) => {
      const p = freq / len;
      return acc - p * Math.log2(p);
    }, 0) * len;

  const meetsLength = len >= config.COMPLEXITY.MIN_LENGTH;
  const isPatternClean = !config.COMPLEXITY.FORBIDDEN_PATTERNS.some((re) =>
    re.test(password)
  );
  const score = Math.round(entropy);

  return {
    entropy: score,
    isViable:
      score >= config.COMPLEXITY.MIN_ENTROPY && meetsLength && isPatternClean,
    strength: score > 80 ? "EXCEPTIONAL" : score > 60 ? "STRONG" : "WEAK",
    recommendation:
      score < config.COMPLEXITY.MIN_ENTROPY
        ? `Role [${role}] requires higher character diversity (target: ${config.COMPLEXITY.MIN_ENTROPY}).`
        : "Policy satisfied.",
  };
};

/**
 * 📉 HEURISTIC LOCKOUT: Calculates penalty based on attack intensity.
 */
exports.getPenaltyDuration = (failedAttempts) => {
  const { EXPONENTIAL_BACKOFF_BASE, MAX_LOCKOUT_MS } =
    _ACTIVE_POLICY.RESILIENCE;

  if (failedAttempts <= 3) return 0;

  const penalty = Math.pow(EXPONENTIAL_BACKOFF_BASE, failedAttempts) * 1000;
  return Math.min(penalty, MAX_LOCKOUT_MS);
};

/**
 * 🔐 CRYPTO-STREAMS: Generates high-entropy nonces.
 */
exports.generateSecureIdentifier = (bytes = 32) => {
  return crypto.randomBytes(bytes).toString("hex");
};

/**
 * 🔍 ROLE-AWARE SELECTORS
 */

// Internal helper to merge root config with role overrides
exports.getRoleEffectiveConfig = (role) => {
  const overrides = _ACTIVE_POLICY.ROLE_OVERRIDES[role] || {};
  return {
    ..._ACTIVE_POLICY,
    COMPLEXITY: {
      ..._ACTIVE_POLICY.COMPLEXITY,
      ...(overrides.COMPLEXITY || {}),
    },
    RESILIENCE: {
      ..._ACTIVE_POLICY.RESILIENCE,
      ...(overrides.RESILIENCE || {}),
    },
  };
};

/**
 * Returns the password history count based on user role.
 * Used by passwordHistoryService.js
 */
exports.getMaxPasswordHistoryCount = (role = "user") => {
  const config = this.getRoleEffectiveConfig(role);
  return config.RESILIENCE.MAX_HISTORY;
};

exports.getConfig = (key) => _ACTIVE_POLICY[key] || _ACTIVE_POLICY;
