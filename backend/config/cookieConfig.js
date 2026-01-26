// config/cookieConfig.js (ENTERPRISE-GRADE IMPLEMENTATION - FINAL/OPTIMIZED)

/**
 * Configuration object defining cookie names, security options, and expiry settings.
 * It uses environment variables for flexible, secure runtime configuration.
 */

// --- Environment Variables (Centralized Config) ---
// Use default values for development if environment variables are missing
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || (IS_PRODUCTION ? 'yourdomain.com' : 'localhost');

// Define Max Age in milliseconds (or retrieve from ENV)
const REFRESH_TOKEN_MAX_AGE_MS = process.env.REFRESH_TOKEN_MAX_AGE_DAYS 
    ? parseInt(process.env.REFRESH_TOKEN_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000 // Convert days to ms
    : 7 * 24 * 60 * 60 * 1000; // Default: 7 days

const ACCESS_TOKEN_MAX_AGE_MS = process.env.ACCESS_TOKEN_MAX_AGE_MINUTES
    ? parseInt(process.env.ACCESS_TOKEN_MAX_AGE_MINUTES) * 60 * 1000 // Convert minutes to ms
    : 15 * 60 * 1000; // Default: 15 minutes

// --- Cookie Names (For use in controllers) ---
const ACCESS_COOKIE_NAME = 'accessToken';
const REFRESH_COOKIE_NAME = 'refreshToken';
const CSRF_COOKIE_NAME = 'csrfToken';
const SESSION_COOKIE_NAME = 'sessionId'; // Used if you also track server-side sessions

// ----------------------------------------------------------------------------------
// --- BASE COOKIE OPTIONS (Secure & HTTP-Only Template) ---
// This serves as the foundation for the most secure cookies (like Refresh Token).

const COOKIE_OPTIONS_BASE = {
    httpOnly: true,         // Prevents client-side JavaScript access (Mitigates XSS)
    secure: IS_PRODUCTION,  // Must be true in production to ensure cookie is only sent over HTTPS
    signed: true,           // Recommended: Use a secure signature to prevent client tampering
    sameSite: 'strict',     // Essential for robust CSRF protection
    path: '/',              // Accessible across the entire domain
    domain: COOKIE_DOMAIN,  // Explicitly set domain for multi-subdomain/cross-domain access
};

// ----------------------------------------------------------------------------------
// --- Specific Cookie Option Sets ---

/**
 * 1. REFRESH TOKEN OPTIONS: Persistent, HTTP-Only, Strict Security
 */
const COOKIE_OPTIONS_REFRESH = {
    ...COOKIE_OPTIONS_BASE,
    maxAge: REFRESH_TOKEN_MAX_AGE_MS, // Persistence
};

/**
 * 2. ACCESS TOKEN OPTIONS: Short-lived, HTTP-Only, Lax/Strict SameSite
 * Uses 'lax' in production for better UX on initial page load from an external link.
 */
const COOKIE_OPTIONS_ACCESS = {
    ...COOKIE_OPTIONS_BASE,
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
    // Use 'lax' in production to allow the token to be sent on top-level navigation from third-party sites.
    // Use 'strict' in development/localhost for maximum local security.
    sameSite: IS_PRODUCTION ? 'lax' : 'strict', 
};

/**
 * 3. CSRF TOKEN OPTIONS: JS-Readable, Short-lived
 * The token itself is used by the client and must be sent in a custom header (Double Submit Cookie pattern).
 */
const COOKIE_OPTIONS_CSRF = {
    ...COOKIE_OPTIONS_ACCESS,
    httpOnly: false,        // CRITICAL: Must be false for client-side JS to read
    sameSite: 'strict',     // Should always be strict as it's paired with a custom header check
    // Note: maxAge is the same as the access token, as the two are intrinsically linked.
};


// ----------------------------------------------------------------------------------
// 📤 MODULE EXPORTS
// ----------------------------------------------------------------------------------

module.exports = {
    // 💡 Cookie Names (Flat export for easy destructuring in controllers)
    ACCESS_COOKIE_NAME,
    REFRESH_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    SESSION_COOKIE_NAME,

    // 🍪 Specific Options Sets (Used in res.cookie/res.clearCookie)
    COOKIE_OPTIONS_REFRESH,
    COOKIE_OPTIONS_ACCESS,
    COOKIE_OPTIONS_CSRF,
    
    // ⚙️ Environment Variables & Config Values (Exported for utility/audit logs)
    CONFIG: {
        IS_PRODUCTION,
        COOKIE_DOMAIN,
        REFRESH_TOKEN_MAX_AGE_MS,
        ACCESS_TOKEN_MAX_AGE_MS,
    }
};