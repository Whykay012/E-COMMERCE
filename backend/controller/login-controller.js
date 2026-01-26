// controllers/auth/loginController.js
const { StatusCodes } = require("http-status-codes");
const { validationResult, matchedData } = require("express-validator");

// Services
const { processUserLogin } = require("../../services/authService");
const auditLogger = require("../../services/auditLogger"); // Enterprise-grade audit logger
// New Import: Necessary to distinguish expected security errors from system errors
const AuthenticationError = require("../../errors/unauthenication-error"); 

const COOKIE_CFG = require("../config/cookieConfig");

// Utility: mask email
function maskEmail(email = "") {
 const [local, domain] = String(email).split("@");
 if (!domain) return email;
 return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * @desc Handles user login (MFA, expired password, secure cookies)
 * @route POST /api/v1/auth/login
 * @access Public
 */
const login = async (req, res, next) => {
 try {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
   const msg = errors.array().map(e => e.msg).join("; ");

   // 🔹 Audit: Validation failed
   auditLogger.dispatchLog({
    level: "WARN",
    event: "LOGIN_VALIDATION_FAILED",
    details: { ip: req.ip, path: req.path, reason: msg, identifier: matchedData(req)?.identifier || null }
   });

   return res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: msg });
  }

  const { identifier, password, deviceName } = matchedData(req, { locations: ["body"] });
  const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;
  const userAgent = req.get("User-Agent") || "unknown";

  const svcResult = await processUserLogin(identifier, password, {
   ip: clientIp,
   userAgent,
   deviceName: deviceName || `${req.headers["sec-ch-ua-platform"] || "browser"}`,
   requestId: req.id || undefined,
  });

  if (!svcResult) {
   auditLogger.dispatchLog({
    level: "CRITICAL",
    event: "LOGIN_UNKNOWN_FAILURE",
    details: { identifier, ip: clientIp, userAgent }
   });
   return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ success: false, message: "Login failed" });
  }

  const { user, accessToken, refreshToken, sessionId, mfaRequired, mfaType, mfaToken, isSuspicious, passwordExpired, accountUnverified, csrfToken } = svcResult;
    
    const userId = user?.id || user?._id || user?.userID || null;

  // Handle special flows
  if (passwordExpired) {
        auditLogger.dispatchLog({
            level: "SECURITY",
            event: "LOGIN_FAILED_PASSWORD_EXPIRED",
            userId: userId,
            details: { ip: clientIp }
        });
   return res.status(StatusCodes.FORBIDDEN).json({
    success: false,
    code: "PASSWORD_EXPIRED",
    message: "Password expired — please reset your password.",
    next: { resetPasswordUrl: process.env.PASSWORD_RESET_URL || null },
   });
  }

  if (accountUnverified) {
        auditLogger.dispatchLog({
            level: "INFO",
            event: "LOGIN_FAILED_ACCOUNT_UNVERIFIED",
            userId: userId,
            details: { ip: clientIp }
        });
   return res.status(StatusCodes.FORBIDDEN).json({
    success: false,
    code: "ACCOUNT_UNVERIFIED",
    message: "Account verification required. Check your email for a verification link.",
   });
  }

  if (mfaRequired) {
        auditLogger.dispatchLog({
            level: "SECURITY",
            event: "LOGIN_MFA_INITIATED_CONTROLLER",
            userId: userId,
            details: { ip: clientIp, userAgent, mfaType, isSuspicious }
        });
   return res.status(StatusCodes.ACCEPTED).json({
    success: true,
    mfaRequired: true,
    mfaType,
    mfaToken, 
    message: "Multi-factor authentication required",
   });
  }

  // Final Success: Normal login flow (Tokens are issued)
    auditLogger.dispatchLog({
        level: "INFO",
        event: "LOGIN_SUCCESS_CONTROLLER_FINAL", 
        userId: userId,
        details: { ip: clientIp, userAgent, isSuspicious }
    });

  // Set cookies
  if (accessToken) res.cookie(COOKIE_CFG.ACCESS_COOKIE_NAME, accessToken, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);
  if (refreshToken) res.cookie(COOKIE_CFG.REFRESH_COOKIE_NAME, refreshToken, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
  if (sessionId) res.cookie(COOKIE_CFG.SESSION_COOKIE_NAME, sessionId, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
  if (csrfToken) res.cookie(COOKIE_CFG.CSRF_COOKIE_NAME, csrfToken, COOKIE_CFG.COOKIE_OPTIONS_CSRF);

  const safeUser = user
   ? {
     id: user.id || user._id || user.userID,
     role: user.role,
     username: user.username || user.name || null,
     email: user.email ? (process.env.NODE_ENV === "production" ? maskEmail(user.email) : user.email) : user.email,
     isSuspicious: !!isSuspicious,
    }
   : null;

  return res.status(StatusCodes.OK).json({
   success: true,
   message: "Login successful",
   user: safeUser,
   meta: { csrfCookie: !!csrfToken, isSuspicious: !!isSuspicious }
  });

 } catch (err) {
    // 💡 OPTIMIZED ERROR HANDLING: Differentiate between expected auth failures and critical system errors
    if (err instanceof AuthenticationError) {
        // Expected authentication failure (e.g., wrong password, locked account, user not found)
        // These events are already audited within authService.js (e.g., LOGIN_FAILURE_PASSWORD).
        return res.status(StatusCodes.UNAUTHORIZED).json({ 
            success: false, 
            message: err.message || "Authentication failed." 
        });
    }

    // Global error audit: Catches unexpected errors (e.g., DB connection failure, unhandled promise)
    auditLogger.dispatchLog({
        level: "CRITICAL",
        event: "LOGIN_FAILURE_SYSTEM_ERROR", // Specific event name for clarity
        details: { 
            ip: req.ip, 
            path: req.path, 
            error: err?.message || String(err), 
            stack: process.env.NODE_ENV !== "production" ? err.stack : undefined 
        }
    });

  return next(err); // Re-throw to the global Express error handler (if one exists)
 }
};

module.exports = login;