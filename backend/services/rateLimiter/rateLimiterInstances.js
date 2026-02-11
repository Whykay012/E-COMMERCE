"use strict";

/**
 * Rate Limiter Instances
 * ---------------------
 * COSMOS HYPER-FABRIC OMEGA Edition
 * ---------------------
 * This file initializes specific rate limiter middlewares using the 
 * centralized factory. It relies on pre-loaded LUA SHAs from the Redis 
 * initialization sequence.
 */

const { createRateLimiterFactory, ALGORITHMS } = require("./rateLimiterFactory");
const scripts = require("../../config/redisScripts"); 
const { temporarilyBlock, isBlocked } = require("../../lib/redisHelpers"); 
const { checkHealth } = require("../../lib/redisClient"); // Use the OMEGA client health check

// --- Configuration ---
// OTP: 3 attempts per 5 minutes. 30s penalty on exceed.
const OTP_WINDOW_S = 5 * 60;
const OTP_MAX = 3;
const OTP_PENALTY_S = 30;

// Resend: 1 attempt per minute.
const RESEND_WINDOW_S = 60;
const RESEND_MAX = 1;

// Password Reset: 5 attempts per hour. 24-hour ban on abuse.
const PW_RESET_WINDOW_S = 60 * 60;
const PW_RESET_MAX = 5;
const PW_RESET_PENALTY_S = 60 * 60 * 24;

// ---------------------------------------------------
// 1. Initialize the Factory
// ---------------------------------------------------
/**
 * 💡 ZENITH ARCHITECTURE:
 * We pass the 'scripts' object itself rather than individual SHAs.
 * This ensures that when redisClient.js updates scripts.FWC_SHA, 
 * the factory sees the live value instead of a stale null.
 */
const limiterCreator = createRateLimiterFactory({
  shas: scripts, 
  temporarilyBlock,
  isBlocked,
  getFabricStatus: checkHealth,
});

// ---------------------------------------------------
// 2. Create the Limiter Instances
// ---------------------------------------------------

/**
 * High-security OTP rate limiter (Sliding Window Log).
 * Protects against brute force OTP verification attempts.
 */
const otpRateLimiter = limiterCreator({
  algorithm: ALGORITHMS.SWL,
  keyPrefix: "rate:otp:",
  windowSeconds: OTP_WINDOW_S,
  max: OTP_MAX,
  penaltySeconds: OTP_PENALTY_S,
});

/**
 * Basic resend limiter (Fixed Window Counter).
 * Prevents spamming of "Resend Email" or "Resend SMS" buttons.
 */
const resendRateLimiter = limiterCreator({
  algorithm: ALGORITHMS.FWC,
  keyPrefix: "rate:resend:",
  windowSeconds: RESEND_WINDOW_S,
  max: RESEND_MAX,
});

/**
 * Password reset endpoint limiter (Sliding Window Log).
 * Heavy protection for sensitive account recovery flows.
 */
const passwordResetLimiter = limiterCreator({
  algorithm: ALGORITHMS.SWL,
  keyPrefix: "rate:pwreset:",
  windowSeconds: PW_RESET_WINDOW_S,
  max: PW_RESET_MAX,
  penaltySeconds: PW_RESET_PENALTY_S,
  blockOnExceed: { 
    enabled: true, 
    banSeconds: PW_RESET_PENALTY_S 
  }
});

// --- Export all configured rate limiters ---
module.exports = {
  otpRateLimiter,
  resendRateLimiter,
  passwordResetLimiter,
};