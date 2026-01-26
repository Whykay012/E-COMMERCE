/**
 * Utility to robustly extract IP address, accounting for load balancers.
 * This is duplicated here for self-containment, but ideally, this would be
 * imported from a shared utilities file (e.g., ../utils/network).
 * @param {object} req - Express request object.
 * @returns {string} The most reliable IP address.
 */
const getIp = (req) => {
    // Check for X-Forwarded-For first (common with load balancers)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        // Take the first IP in the list (the actual client IP)
        return forwarded.split(',').shift().trim();
    }
    // Fallback to direct IP
    return req.ip || req.connection?.remoteAddress || 'unknown';
};


// 1. Configuration and Initialization
// Use a Set for O(1) average lookup time, essential for high-throughput middleware.
const WHITELISTED_IPS = new Set(
    (process.env.RATE_LIMIT_WHITELIST || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
);

// If no IPs are configured, log a warning (optional, but good practice)
if (WHITELISTED_IPS.size === 0) {
    console.warn("RATE_LIMIT_WHITELIST is empty or unset. All requests will be subject to rate limiting.");
}


/**
 * Middleware to check if the incoming request IP is whitelisted.
 * If whitelisted, it sets req.isWhitelisted = true and logs the event.
 *
 * @param {object} req - Express Request object.
 * @param {object} res - Express Response object.
 * @param {function} next - Express next middleware function.
 */
function ipWhitelist(req, res, next) {
    // Use the robust IP extraction logic
    const clientIP = getIp(req);

    if (WHITELISTED_IPS.has(clientIP)) {
        // Mark the request as whitelisted
        req.isWhitelisted = true;

        // Log access for auditing purposes
        console.log(`[WHITELIST] Bypass granted for IP: ${clientIP} on route: ${req.originalUrl}`);
    }

    // Always call next() regardless of whitelisting status.
    // The rate limiter middleware (e.g., globalLimiter) must check req.isWhitelisted
    // and skip its logic if true.
    next();
}

module.exports = ipWhitelist;