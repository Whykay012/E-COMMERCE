// --- Updated Rate Limiter Setup (rateLimiterConfig.js) ---

const { createRateLimiter } = require("./rateLimiter");
const validator = require('validator'); // 💡 NEW: Use a standard sanitization library

/**
 * Utility to robustly extract and sanitize IP address, accounting for load balancers.
 * This is crucial for accurate IP-based rate limiting in production environments, 
 * protecting against malformed headers.
 * @param {object} req - Express request object.
 * @returns {string} The sanitized, most reliable IP address.
 */
const getIp = (req) => {
    // Check for X-Forwarded-For first (common with load balancers)
    const forwarded = req.headers['x-forwarded-for'];
    let ipCandidate;

    if (forwarded) {
        // Use the first IP in the list (the client IP)
        // Ensure it's treated as a string before splitting
        const ipList = String(forwarded).split(',').map(s => s.trim());
        ipCandidate = ipList.shift();
    } else {
        // Fallback to direct connection IP
        ipCandidate = req.ip || req.connection?.remoteAddress;
    }

    // 💡 SANITIZATION STEP: Use validator to ensure the IP is a safe, routable IP string.
    // If it's IPv6, we strip the v4 mapping part if present (::ffff:127.0.0.1 -> 127.0.0.1)
    if (ipCandidate) {
        ipCandidate = ipCandidate.replace(/^::ffff:/, '');
        if (validator.isIP(ipCandidate)) {
            return ipCandidate;
        }
    }
    
    // Final fallback
    return 'unknown_sanitized';
};

/**
 * Configuration structure for all rate limiters, using environment variables
 * for runtime configuration and sensible defaults.
 */
const config = {
    // ---------------------- 1. Global IP Limiter ----------------------
    global: {
        windowSeconds: Number(process.env.RL_GLOBAL_WINDOW_SECONDS || 60),
        max: Number(process.env.RL_GLOBAL_MAX || 150), 
        keyPrefix: "rl:global",
        blockOnExceed: { enabled: false }, 
        softBanDelayMs: 0,
    },

    // ---------------------- 2. Forgot Password Limiter (Security/Email Resource Protection) ----------------------
    'forgotPassword': {
        windowSeconds: Number(process.env.RL_FORGOT_PW_WINDOW_SECONDS || 3600), // 1 hour
        max: Number(process.env.RL_FORGOT_PW_MAX || 3), // Only 3 attempts per hour per IP
        keyPrefix: "rl:forgot_pw",
        blockOnExceed: { enabled: true, banSeconds: 3600 * 2 }, // 2-hour temporary ban
        softBanDelayMs: 0,
    },

    // ---------------------- 3. Login Attempt Limiter (Security) ----------------------
    login: {
        windowSeconds: Number(process.env.RL_LOGIN_WINDOW_SECONDS || 15 * 60), // 15 minutes
        max: Number(process.env.RL_LOGIN_MAX || 5), // Only 5 attempts per window
        keyPrefix: "rl:login",
        blockOnExceed: { enabled: true, banSeconds: 60 * 15 }, 
        softBanDelayMs: 0,
    },

    // ---------------------- 4. Product Review Limiter (Post-Auth) ----------------------
    review: {
        windowSeconds: Number(process.env.RL_REVIEW_WINDOW_SECONDS || 60 * 60), 
        max: Number(process.env.RL_REVIEW_MAX || 10), 
        keyPrefix: "rl:review",
        blockOnExceed: { enabled: true, banSeconds: 60 * 60 }, 
        softBanDelayMs: 0,
    },

    // ---------------------- 5. Search/Discovery Limiter (Resource) ----------------------
    search: {
        windowSeconds: Number(process.env.RL_SEARCH_WINDOW_SECONDS || 10),
        max: Number(process.env.RL_SEARCH_MAX || 50), 
        keyPrefix: "rl:search",
        blockOnExceed: { enabled: true, banSeconds: 60 }, 
        softBanDelayMs: 0,
    },

    // ---------------------- 6. Checkout/Order Placement Limiter (CRITICAL) ----------------------
    checkout: {
        windowSeconds: Number(process.env.RL_CHECKOUT_WINDOW_SECONDS || 60),
        max: Number(process.env.RL_CHECKOUT_MAX || 2), 
        keyPrefix: "rl:checkout",
        blockOnExceed: { enabled: true, banSeconds: 60 * 30 }, 
        softBanDelayMs: 0,
    },

    // ---------------------- 7. Strict Write Limiter (Cart/Data Sync) ----------------------
    strictWrite: {
        windowSeconds: Number(process.env.RL_STRICT_WRITE_WINDOW_SECONDS || 60),
        max: Number(process.env.RL_STRICT_WRITE_MAX || 30), 
        keyPrefix: "rl:strict_write",
        blockOnExceed: { enabled: true, banSeconds: 300 }, 
        softBanDelayMs: 50, 
    },

    // ---------------------- 8. Admin Operations Limiter (Extreme Security) ----------------------
    admin: {
        windowSeconds: Number(process.env.RL_ADMIN_WINDOW_SECONDS || 300), // 5 minutes
        max: Number(process.env.RL_ADMIN_MAX || 10), // Max 10 requests every 5 minutes
        keyPrefix: "rl:admin",
        blockOnExceed: { enabled: true, banSeconds: 3600 }, // 1 hour ban for admin abuse
        softBanDelayMs: 0,
    },
    
    // ---------------------- 9. Activity Log Limiter (Heavy Read) ----------------------
    activityLog: {
        windowSeconds: Number(process.env.RL_ACTIVITY_WINDOW_SECONDS || 60),
        max: Number(process.env.RL_ACTIVITY_MAX || 60), 
        keyPrefix: "rl:activity_log",
        blockOnExceed: { enabled: true, banSeconds: 120 }, 
        softBanDelayMs: 0,
    },

    // ---------------------- 10. 💡 NEW: Inventory Write Limiter (High-Value Transactional) ----------------------
    // Protects /stock, /revert, /create, /delete. Should be User-ID based post-auth.
    inventoryWrite: {
        windowSeconds: Number(process.env.RL_INV_WRITE_WINDOW_SECONDS || 10), // Short window
        max: Number(process.env.RL_INV_WRITE_MAX || 5), // Only 5 high-value transactions per 10 seconds
        keyPrefix: "rl:inv_write",
        blockOnExceed: { enabled: true, banSeconds: 600 }, // 10-minute ban for aggressive updates
        softBanDelayMs: 0,
    },

    // ---------------------- 11. 💡 NEW: Inventory Read Limiter (Paginated/Heavy Read) ----------------------
    // Protects /audit and /inventory list endpoints. Should be User-ID based post-auth.
    inventoryRead: {
        windowSeconds: Number(process.env.RL_INV_READ_WINDOW_SECONDS || 30),
        max: Number(process.env.RL_INV_READ_MAX || 60), // 60 reads per 30 seconds
        keyPrefix: "rl:inv_read",
        blockOnExceed: { enabled: true, banSeconds: 120 }, // 2-minute ban
        softBanDelayMs: 0,
    },

        // ---------------------- 12. 💳 Payment Initialization (CRITICAL MONEY FLOW) ----------------------
    paymentInit: {
        windowSeconds: Number(process.env.RL_PAY_INIT_WINDOW_SECONDS || 60),
        max: Number(process.env.RL_PAY_INIT_MAX || 3), // Only 3 attempts per minute
        keyPrefix: "rl:payment:init",
        blockOnExceed: { enabled: true, banSeconds: 60 * 15 }, // 15 mins ban
        softBanDelayMs: 0,
    },

    // ---------------------- 13. ✅ Payment Verification ----------------------
    paymentVerify: {
        windowSeconds: Number(process.env.RL_PAY_VERIFY_WINDOW_SECONDS || 60),
        max: Number(process.env.RL_PAY_VERIFY_MAX || 5),
        keyPrefix: "rl:payment:verify",
        blockOnExceed: { enabled: true, banSeconds: 600 },
        softBanDelayMs: 0,
    },

    // ---------------------- 14. 🔐 OTP / STEP-UP AUTH (HIGH RISK) ----------------------
    stepUpOtp: {
        windowSeconds: Number(process.env.RL_STEPUP_WINDOW_SECONDS || 300), // 5 mins
        max: Number(process.env.RL_STEPUP_MAX || 5), // Only 5 OTP attempts
        keyPrefix: "rl:stepup",
        blockOnExceed: { enabled: true, banSeconds: 3600 }, // 1 hour lock
        softBanDelayMs: 0,
    },

    // ---------------------- 15. 🔗 PAYMENT PROVIDER WEBHOOKS ----------------------
    webhook: {
        windowSeconds: Number(process.env.RL_WEBHOOK_WINDOW_SECONDS || 10),
        max: Number(process.env.RL_WEBHOOK_MAX || 100),
        keyPrefix: "rl:webhook",
        blockOnExceed: { enabled: false }, // never ban providers
        softBanDelayMs: 0,
    },

    // ---------------------- 16. 📊 METRICS / OBSERVABILITY ----------------------
    metrics: {
        windowSeconds: 10,
        max: 20,
        keyPrefix: "rl:metrics",
        blockOnExceed: { enabled: false },
        softBanDelayMs: 0,
    },

};

// =============================================================================
// Rate Limiter Instantiations
// =============================================================================

// Instantiations of the new Inventory-specific limiters
const inventoryWriteLimiter = createRateLimiter({
    ...config.inventoryWrite,
    // Defaults to req.user.id if available, fallback to IP (ideal for admin routes)
});

const inventoryReadLimiter = createRateLimiter({
    ...config.inventoryRead,
    // Defaults to req.user.id if available, fallback to IP
});

// Reuse/existing instantiations (for completeness)
const globalLimiter = createRateLimiter({ ...config.global, identifierFn: (req) => `ip:${getIp(req)}` });
const loginLimiter = createRateLimiter({ ...config.login, identifierFn: (req) => `ip:${getIp(req)}` });
const forgotPasswordLimiter = createRateLimiter({ ...config.forgotPassword, identifierFn: (req) => `ip:${getIp(req)}` });
const searchLimiter = createRateLimiter({ ...config.search, identifierFn: (req) => `ip:${getIp(req)}` });
const adminLimiter = createRateLimiter({ ...config.admin, identifierFn: (req) => `ip:${getIp(req)}` });

// Limiters that rely on req.user?.id by default (no custom identifierFn needed here)
const reviewLimiter = createRateLimiter({ ...config.review });
const checkoutLimiter = createRateLimiter({ ...config.checkout });
const strictWriteLimiter = createRateLimiter({ ...config.strictWrite });
const activityLogLimiter = createRateLimiter({ ...config.activityLog });
// =============================================================================
// 💳 Payment-Specific Rate Limiters (Enterprise)
// =============================================================================

// Uses user ID when authenticated, falls back to IP
const paymentInitLimiter = createRateLimiter({
    ...config.paymentInit,
    identifierFn: (req) => `pay:init:${req.user?.id || getIp(req)}`
});

const paymentVerifyLimiter = createRateLimiter({
    ...config.paymentVerify,
    identifierFn: (req) => `pay:verify:${req.user?.id || getIp(req)}`
});

const stepUpOtpLimiter = createRateLimiter({
    ...config.stepUpOtp,
    identifierFn: (req) => `pay:stepup:${req.user?.id || getIp(req)}`
});

// Webhooks must be IP-based (providers don’t send user IDs)
const webhookLimiter = createRateLimiter({
    ...config.webhook,
    identifierFn: (req) => `webhook:${getIp(req)}`
});

// Metrics protection
const metricsLimiter = createRateLimiter({
    ...config.metrics,
    identifierFn: () => "metrics"
});


module.exports = { 
    globalLimiter, 
    loginLimiter, 
    reviewLimiter, 
    searchLimiter, 
    checkoutLimiter,
    strictWriteLimiter,
    adminLimiter,
    forgotPasswordLimiter, 
    activityLogLimiter,

    // Inventory
    inventoryWriteLimiter, 
    inventoryReadLimiter,

    // 💳 Payment
    paymentInitLimiter,
    paymentVerifyLimiter,
    stepUpOtpLimiter,
    webhookLimiter,
    metricsLimiter,

    getIp 
};