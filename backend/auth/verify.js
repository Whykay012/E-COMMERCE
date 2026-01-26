// controllers/auth/verifyAccountController.js (ABSOLUTE PINNACLE ENTERPRISE LEVEL)

/* ===========================
 * 📦 Dependencies & Setup
 * =========================== */
const { StatusCodes } = require("http-status-codes");
const authService = require('../services/authService'); 
const COOKIE_CFG = require('../config/cookieConfig'); 
const auditLogger = require('../services/auditLogger'); // Centralized Logging/Telemetry
const { randomUUID } = require('crypto'); // Explicit dependency for UUID generation


/* ===========================
 * ⚙️ Utility Functions (Refined for Enterprise Headers)
 * =========================== */

/**
 * @desc Extracts the client IP address robustly, prioritizing vendor-specific and standard headers.
 * @param {object} req - Express request object.
 * @returns {string} The resolved client IP address or 'unknown'.
 */
const getClientIp = (req) => {
    // 1. Prioritize Cloudflare/AWS headers if present (common enterprise CDNs/Load Balancers)
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp.split(',').shift().trim();

    // 2. Check for standard X-Forwarded-For
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        // Return the left-most IP (client IP)
        return forwarded.split(',').shift().trim();
    }
    
    // 3. Fallback to X-Real-IP or direct connection IP
    return req.headers['x-real-ip']?.trim() || req.ip || 'unknown';
};


/* ===========================
 * 📝 Controller Core
 * =========================== */

/**
 * @desc Verifies a new user account using the URL token and submitted OTP.
 * @route POST /api/v1/auth/verify/:token
 * * NOTE: The validation middleware (`validateVerificationInput`) is assumed to handle 
 * structural checks (e.g., token format, OTP length) BEFORE this function.
 */
const verifyAccount = async (req, res, next) => {
    // 1. 🔑 Observability Setup: Generate a UUID if not already present from a preceding middleware
    const TRACE_ID = res.locals.traceId || randomUUID();
    res.locals.traceId = TRACE_ID; // Ensure trace ID is available downstream
    
    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'];
    const { token } = req.params;
    const { otp } = req.body; 

    // Telemetry Entry Point (Request Tracing)
    auditLogger.dispatchLog({ 
        level: 'TRACE', 
        event: 'CONTROLLER_ENTRY:VERIFY_ACCOUNT', 
        details: { traceId: TRACE_ID, ip: clientIp, endpoint: `/api/v1/auth/verify/${token ? 'TOKEN_PRESENT' : 'TOKEN_MISSING'}`, token: !!token } 
    });

    const context = { ip: clientIp, userAgent, traceId: TRACE_ID };

    try {
        // 2. Resilience Check: Ensure basic data presence before service call (quick fail)
        if (!token || !otp) {
            // This case should be rare if middleware is in place, but provides ultimate resilience.
            auditLogger.dispatchLog({ 
                level: 'WARN', 
                event: 'DATA_VALIDATION_FAILURE_CONTROLLER', 
                details: { traceId: TRACE_ID, reason: 'Token or OTP missing from request.' } 
            });
            return res.status(StatusCodes.BAD_REQUEST).json({ message: "Verification token and OTP are required." });
        }

        // 3. Service Call (Business Logic Execution)
        const result = await authService.verifyNewAccount(token, otp, context);

        // 4. Set Secure Cookies
        // The service layer guarantees that tokens and options are valid here.
        res.cookie(COOKIE_CFG.ACCESS_COOKIE_NAME, result.accessToken, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);
        res.cookie(COOKIE_CFG.REFRESH_COOKIE_NAME, result.refreshToken, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
        res.cookie(COOKIE_CFG.CSRF_COOKIE_NAME, result.csrfToken, COOKIE_CFG.COOKIE_OPTIONS_CSRF);

        // 5. Send Success Response & Telemetry
        const responseData = {
            message: "Account verified successfully. Login granted.",
            user: result.user,
            sessionId: result.sessionId,
            // Per secure standards, avoid sending tokens in the body, relying only on HTTP-only cookies.
            // If mobile clients *must* have the access token, include it only here:
            // accessToken: result.accessToken 
        };
        
        // Telemetry Exit Point
        auditLogger.dispatchLog({ 
            level: 'INFO', 
            event: 'CONTROLLER_EXIT_SUCCESS', 
            details: { traceId: TRACE_ID, userId: result.user.userID, status: StatusCodes.OK } 
        });

        // 💡 Enterprise best practice: Use StatusCodes.CREATED (201) if the verification 
        // implies the creation of a definitive session/resource, though 200 is common for verification flow.
        return res.status(StatusCodes.OK).json(responseData);
        
    } catch (error) {
        // 6. Centralized Error Delegation and Logging
        
        // Log the failure details
        auditLogger.dispatchLog({ 
            level: 'ERROR', 
            event: 'CONTROLLER_EXIT_FAILURE', 
            details: { 
                traceId: TRACE_ID, 
                error: error.message, 
                // Use error.status (if defined by a custom error class) or fallback to 500
                status: error.status || StatusCodes.INTERNAL_SERVER_ERROR 
            } 
        });
        
        // Delegate error to the global Express error handling middleware
        next(error);
    }
};

module.exports = verifyAccount;