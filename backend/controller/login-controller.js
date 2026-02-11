const { StatusCodes } = require("http-status-codes");
const { validationResult, matchedData } = require("express-validator");
const asyncHandler = require("../../middleware/asyncHandler");

// Services
const { processUserLogin } = require("../../services/authService");
const auditLogger = require("../../services/auditLogger");
const AuthenticationError = require("../../errors/unauthenication-error");

const COOKIE_CFG = require("../config/cookieConfig");

/**
 * Utility: mask email for privacy in production
 */
function maskEmail(email = "") {
  const [local, domain] = String(email).split("@");
  if (!domain) return email;
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * @desc ZENITH LOGIC: Identity Identification & Adaptive MFA Trigger
 * @route POST /api/v1/auth/login
 * @access Public
 */
const login = asyncHandler(async (req, res, next) => {
  // 1. INPUT VALIDATION & AUDIT
  const errors = validationResult(req);
  const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;
  const userAgent = req.get("User-Agent") || "unknown";

  if (!errors.isEmpty()) {
    const msg = errors.array().map(e => e.msg).join("; ");
    
    auditLogger.dispatchLog({
      level: "WARN",
      event: "LOGIN_VALIDATION_FAILED",
      details: { ip: clientIp, path: req.path, reason: msg }
    });
    
    return res.status(StatusCodes.BAD_REQUEST).json({ success: false, message: msg });
  }

  const { identifier, password, deviceName } = matchedData(req, { locations: ["body"] });

  try {
    // 2. SERVICE ORCHESTRATION
    // This calls the Adaptive Engine (Impossible Travel, Scrypt Hashing, etc.)
    const svcResult = await processUserLogin(identifier, password, {
      ip: clientIp,
      userAgent,
      deviceName: deviceName || `${req.headers["sec-ch-ua-platform"] || "browser"}`,
      requestId: req.id
    });

    if (!svcResult) {
      throw new Error("Empty service response during login orchestration");
    }

    const { 
      user, 
      mfaRequired, 
      mfaMode,    // ZENITH or ABSOLUTE
      mfaNonce,   // The temporary session identifier
      expiresIn, 
      passwordExpired, 
      accountUnverified,
      isSuspicious,
      accessToken, 
      refreshToken, 
      sessionId, 
      csrfToken 
    } = svcResult;

    const userId = user?.id || user?._id || user?.userID || null;

    // 3. HANDLE SPECIAL FLOWS (Hard-stops)

    // A. Password Expiry Flow
    if (passwordExpired) {
      auditLogger.dispatchLog({
        level: "SECURITY",
        event: "LOGIN_FAILED_PASSWORD_EXPIRED",
        userId,
        details: { ip: clientIp }
      });
      return res.status(StatusCodes.FORBIDDEN).json({
        success: false,
        code: "PASSWORD_EXPIRED",
        message: "Password expired — please reset your password.",
        next: { resetPasswordUrl: process.env.PASSWORD_RESET_URL || null },
      });
    }

    // B. Unverified Account Flow
    if (accountUnverified) {
      auditLogger.dispatchLog({
        level: "INFO",
        event: "LOGIN_FAILED_ACCOUNT_UNVERIFIED",
        userId,
        details: { ip: clientIp }
      });
      return res.status(StatusCodes.FORBIDDEN).json({
        success: false,
        code: "ACCOUNT_UNVERIFIED",
        message: "Account verification required.",
      });
    }

    // C. Adaptive MFA Challenge Flow (Zenith/Absolute)
    if (mfaRequired) {
      auditLogger.dispatchLog({
        level: "SECURITY",
        event: "LOGIN_MFA_CHALLENGE_ISSUED",
        userId,
        details: { ip: clientIp, mfaMode, isSuspicious }
      });

      return res.status(StatusCodes.ACCEPTED).json({
        success: true,
        message: "Multi-factor authentication required",
        data: {
          mfaRequired: true,
          mfaToken: mfaNonce, // Used by verifyMfa endpoint
          mfaMode: mfaMode,   // Tells UI to show Zenith or Absolute UI
          expiresIn: expiresIn,
          recipient: maskEmail(user.email),
          isSuspicious: !!isSuspicious
        }
      });
    }

    // 4. FINAL SUCCESS (Normal login without MFA)
    auditLogger.dispatchLog({
      level: "INFO",
      event: "LOGIN_SUCCESS_FINAL",
      userId,
      details: { ip: clientIp, userAgent, isSuspicious }
    });

    // Set Enterprise-grade Security Cookies
    if (accessToken) res.cookie(COOKIE_CFG.ACCESS_COOKIE_NAME, accessToken, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);
    if (refreshToken) res.cookie(COOKIE_CFG.REFRESH_COOKIE_NAME, refreshToken, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
    if (sessionId) res.cookie(COOKIE_CFG.SESSION_COOKIE_NAME, sessionId, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
    if (csrfToken) res.cookie(COOKIE_CFG.CSRF_COOKIE_NAME, csrfToken, COOKIE_CFG.COOKIE_OPTIONS_CSRF);

    const safeUser = {
      id: userId,
      role: user.role,
      username: user.username || user.name || null,
      email: user.email ? (process.env.NODE_ENV === "production" ? maskEmail(user.email) : user.email) : user.email,
    };

    return res.status(StatusCodes.OK).json({
      success: true,
      message: "Login successful",
      user: safeUser,
      meta: { csrfCookie: !!csrfToken, isSuspicious: !!isSuspicious }
    });

  } catch (err) {
    // 💡 OPTIMIZED ERROR HANDLING
    if (err instanceof AuthenticationError) {
      // Logic for locked accounts or invalid creds is handled in processUserLogin
      return res.status(StatusCodes.UNAUTHORIZED).json({ 
        success: false, 
        message: err.message || "Authentication failed." 
      });
    }

    // System Crash / Critical Error Audit
    auditLogger.dispatchLog({
      level: "CRITICAL",
      event: "LOGIN_SYSTEM_ERROR",
      details: { 
        ip: clientIp, 
        error: err.message, 
        stack: process.env.NODE_ENV !== "production" ? err.stack : undefined 
      }
    });

    return next(err);
  }
});

module.exports = login;