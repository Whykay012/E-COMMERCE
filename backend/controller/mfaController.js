// controllers/auth/mfaController.js
const { StatusCodes } = require("http-status-codes");
const { validationResult, matchedData } = require("express-validator");

// Services
const { completeMfaLogin } = require("../services/authService"); // Function to verify code and issue tokens
const auditLogger = require("../services/auditLogger"); 
const AuthenticationError = require("../errors/unauthenication-error");

const COOKIE_CFG = require("../config/cookieConfig");

// Utility: mask email (Copied from loginController for consistency)
function maskEmail(email = "") {
 const [local, domain] = String(email).split("@");
 if (!domain) return email;
 return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * @desc Validates the MFA token and completes the user login process.
 * @route POST /api/v1/auth/mfa/verify
 * @access Public (Requires mfaToken from /login)
 */
const verifyMfa = async (req, res, next) => {
    // Determine client IP for auditing and token context
    const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            const msg = errors.array().map(e => e.msg).join("; ");
            
            // 🔹 Audit: Validation failed
            auditLogger.dispatchLog({
                level: "WARN",
                event: "MFA_VALIDATION_FAILED",
                details: { ip: clientIp, path: req.path, reason: msg }
            });
            
            return res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: msg });
        }

        const { mfaToken, mfaCode } = matchedData(req, { locations: ["body"] });
        
        // 1. Call the service layer to validate the code and generate final tokens
        // This function calls mfaService.verifyMfaCode internally.
        const svcResult = await completeMfaLogin(mfaToken, mfaCode, clientIp);

        if (!svcResult || !svcResult.accessToken) {
             // 🔹 Audit: Should theoretically be caught by AuthenticationError, but acts as a safeguard
             auditLogger.dispatchLog({
                level: "CRITICAL",
                event: "MFA_COMPLETION_FAILURE",
                details: { ip: clientIp, reason: "Internal service failure after MFA verification attempt" }
            });
            return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ success: false, message: "Login failed." });
        }
        
        const { user, accessToken, refreshToken, sessionId, csrfToken, isSuspicious } = svcResult;
        
        // 🔹 Audit: Successful MFA completion
        auditLogger.dispatchLog({
            level: "INFO",
            event: "MFA_LOGIN_SUCCESS_CONTROLLER",
            userId: user?.id || user?.userID || null,
            details: { ip: clientIp, isSuspicious }
        });

        // 2. Set secure cookies
        if (accessToken) res.cookie(COOKIE_CFG.ACCESS_COOKIE_NAME, accessToken, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);
        if (refreshToken) res.cookie(COOKIE_CFG.REFRESH_COOKIE_NAME, refreshToken, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
        if (sessionId) res.cookie(COOKIE_CFG.SESSION_COOKIE_NAME, sessionId, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
        if (csrfToken) res.cookie(COOKIE_CFG.CSRF_COOKIE_NAME, csrfToken, COOKIE_CFG.COOKIE_OPTIONS_CSRF);

        const safeUser = {
            id: user.id || user.userID,
            role: user.role,
            username: user.username,
            email: user.email ? (process.env.NODE_ENV === "production" ? maskEmail(user.email) : user.email) : user.email,
            isSuspicious: !!isSuspicious,
        };

        return res.status(StatusCodes.OK).json({
            success: true,
            message: "MFA successful, login complete.",
            user: safeUser,
            meta: { csrfCookie: !!csrfToken, isSuspicious: !!isSuspicious }
        });

    } catch (err) {
        // 💡 Optimized Error Handling: Distinguish between expected auth failures and critical system errors
        if (err instanceof AuthenticationError) {
             // MFA failures (invalid code, expired token) are expected security events.
             // They are already audited within mfaService.verifyMfaCode.
            return res.status(StatusCodes.UNAUTHORIZED).json({ 
                success: false, 
                message: err.message || "MFA failed. Invalid code or session expired." 
            });
        }
        
        // Global error audit: Catches unexpected system errors
        auditLogger.dispatchLog({
            level: "CRITICAL",
            event: "MFA_VERIFICATION_SYSTEM_ERROR",
            details: { 
                ip: clientIp, 
                path: req.path, 
                error: err?.message || String(err),
                stack: process.env.NODE_ENV !== "production" ? err.stack : undefined 
            }
        });

        return next(err);
    }
};

module.exports = verifyMfa;