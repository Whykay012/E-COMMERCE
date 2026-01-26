// services/rateLimiters/rateLimiterInstances.js
/**
 * Rate Limiter Instances
 * ---------------------
 * This file creates and exports configured rate limiter middleware instances
 * for sensitive flows such as OTP, resend, and password reset endpoints.
 *
 * Each limiter is based on the centralized factory: createRateLimiter()
 * from rateLimiterFactory.js. Do NOT include Redis, replay, or Lua logic here.
 */

const { createRateLimiter, ALGORITHMS } = require("./rateLimiterFactory");

// --- OTP Rate Limiter Configuration ---
const OTP_WINDOW_S = 5 * 60; // 5 minutes
const OTP_MAX = 3; // 3 OTP attempts
const OTP_PENALTY_S = 30; // Block for 30s if limit is exceeded

/**
 * High-security OTP rate limiter (Sliding Window Log).
 * Protects against brute force OTP requests.
 */
const otpRateLimiter = createRateLimiter({
  algorithm: ALGORITHMS.SWL,
  keyPrefix: "rate:otp:",
  windowSeconds: OTP_WINDOW_S,
  max: OTP_MAX,
  penaltySeconds: OTP_PENALTY_S,
  // identifierFn: (req) => req.user?.id // Optional user-based identifier
});

// --- Resend Rate Limiter Configuration ---
const RESEND_WINDOW_S = 60; // 1 minute
const RESEND_MAX = 1; // 1 resend per minute

/**
 * Basic resend limiter (Fixed Window Counter).
 * Prevents spamming resend actions such as email or SMS.
 */
const resendRateLimiter = createRateLimiter({
  algorithm: ALGORITHMS.FWC,
  keyPrefix: "rate:resend:",
  windowSeconds: RESEND_WINDOW_S,
  max: RESEND_MAX,
});

// --- Password Reset Rate Limiter Configuration ---
const PW_RESET_WINDOW_S = 60 * 60; // 1 hour
const PW_RESET_MAX = 5; // Max 5 reset requests per hour
const PW_RESET_PENALTY_S = 60 * 60 * 24; // 24-hour block for extreme abuse

/**
 * Password reset endpoint limiter.
 * Protects against flooding and link abuse.
 */
const passwordResetLimiter = createRateLimiter({
  algorithm: ALGORITHMS.SWL,
  keyPrefix: "rate:pwreset:",
  windowSeconds: PW_RESET_WINDOW_S,
  max: PW_RESET_MAX,
  penaltySeconds: PW_RESET_PENALTY_S,
  // identifierFn: (req) => req.body.email || req.ip // Optional: IP/email based
});

// --- Export all configured rate limiters ---
module.exports = {
  otpRateLimiter,
  resendRateLimiter,
  passwordResetLimiter,
};
