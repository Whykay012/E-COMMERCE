/**
 * controllers/auth/logoutController.js
 * ULTIMATE PEAK: High-Availability, Event-Driven Session Destruction
 */

const { StatusCodes } = require("http-status-codes");
const asyncHandler = require("../../middleware/asyncHandler");

// 💡 Services for Revocation
const { emitLogoutEvent, logoutAllDevices } = require('../../services/authService'); 
const userService = require("../../services/userService");
const auditLogger = require('../../services/auditLogger'); 

// Use the enhanced enterprise cookie config
const COOKIE_CFG = require('../config/cookieConfig'); 

// -----------------------------------------------------------
// --- Primary Logout (Single Session) ---

/**
 * @desc Logs the user out by revoking the Refresh Token/Session and clearing cookies.
 * Dispatches an event for asynchronous server-side revocation to ensure high availability.
 * @route POST /api/v1/auth/logout
 */
const logout = asyncHandler(async (req, res, next) => {
    
    // 1. EXTRACT CONTEXT & IDENTIFIERS
    const refreshToken = req.cookies[COOKIE_CFG.REFRESH_COOKIE_NAME];
    const userId = req.user?.id || req.user?.userID; 
    const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;
    const userAgent = req.headers['user-agent'] || 'Unknown';
    
    const hasIdentifiers = !!(refreshToken || userId);

    // 2. IMMEDIATE CLIENT-SIDE REVOCATION (Synchronous)
    res.clearCookie(COOKIE_CFG.ACCESS_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);
    res.clearCookie(COOKIE_CFG.REFRESH_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
    res.clearCookie(COOKIE_CFG.CSRF_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_CSRF);
    
    if (COOKIE_CFG.SESSION_COOKIE_NAME) {
        res.clearCookie(COOKIE_CFG.SESSION_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_REFRESH); 
    }

    // 3. ASYNCHRONOUS SERVER-SIDE CLEANUP (Non-Blocking)
    if (hasIdentifiers) {
        const logoutPayload = { 
            refreshToken, 
            userId,
            context: { ip: clientIp, userAgent, type: 'SINGLE_DEVICE_LOGOUT' }
        };

        emitLogoutEvent(logoutPayload)
            .then(() => {
                auditLogger.dispatchLog({
                    level: 'INFO',
                    event: 'LOGOUT_SESSION_QUEUED',
                    userId: userId,
                    details: { ip: clientIp, type: 'SINGLE_DEVICE' }
                });
            })
            .catch(error => {
                auditLogger.dispatchLog({
                    level: 'CRITICAL',
                    event: 'LOGOUT_QUEUE_EMISSION_FAILED',
                    userId: userId || 'N/A',
                    details: { error: error.message, ip: clientIp }
                });
            });
    } else {
        auditLogger.dispatchLog({
            level: 'WARN',
            event: 'LOGOUT_NO_IDENTIFIERS',
            details: { ip: clientIp, userAgent: userAgent }
        });
    }
    
    return res.status(StatusCodes.NO_CONTENT).send(); 
});

// -----------------------------------------------------------
// --- Emergency: Panic Logout (Kill Switch) ---

/**
 * @desc THE KILL SWITCH: Forcefully logs out user from ALL devices and resets security state.
 * Orchestrates physical wipe in Redis and version increment in MongoDB.
 * @route POST /api/v1/auth/panic-logout
 */
const triggerPanicLogout = asyncHandler(async (req, res) => {
  const userId = req.user?.id || req.user?.userID;
  const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;

  // 1. Block Execution: Global Panic Revocation
  // This invalidates all sessions AND increments 'securityVersion' in DB
  await userService.globalPanicRevocation(
    userId,
    userId,
    "User-initiated emergency security reset"
  );

  // 2. Clear all security cookies immediately
  res.clearCookie(COOKIE_CFG.ACCESS_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);
  res.clearCookie(COOKIE_CFG.REFRESH_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
  res.clearCookie(COOKIE_CFG.CSRF_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_CSRF);

  // 3. Audit high-priority event
  auditLogger.dispatchLog({
    level: 'SECURITY',
    event: 'PANIC_LOGOUT_TRIGGERED',
    userId: userId,
    details: { ip: clientIp, reason: 'Emergency Reset' }
  });

  res.status(StatusCodes.OK).json({
    success: true,
    message: "Global security reset successful. All devices have been logged out.",
  });
});

// -----------------------------------------------------------
// --- Global Sign-Out (Self-Service) ---

/**
 * @desc Revokes all refresh tokens and invalidates sessions across all devices for the user.
 * @route POST /api/v1/auth/logout-all
 */
const globalSignOut = asyncHandler(async (req, res, next) => {
    const userId = req.user?.id || req.user?.userID; 
    const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    if (!userId) {
        return res.status(StatusCodes.UNAUTHORIZED).json({ 
            success: false, 
            message: "Authentication required for global sign-out." 
        });
    }

    const context = { ip: clientIp, userAgent, originator: 'USER_SELF_SERVICE' };

    try {
        await logoutAllDevices(userId, context);

        auditLogger.dispatchLog({ 
            level: 'SECURITY', 
            event: 'GLOBAL_LOGOUT_INITIATED', 
            userId: userId, 
            details: { ip: clientIp, initiator: 'Self' } 
        });

        res.clearCookie(COOKIE_CFG.ACCESS_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);
        res.clearCookie(COOKIE_CFG.REFRESH_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
        res.clearCookie(COOKIE_CFG.CSRF_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_CSRF);

        return res.status(StatusCodes.ACCEPTED).json({ 
            success: true,
            message: "Global sign-out initiated. All sessions are being invalidated." 
        });

    } catch (error) {
        auditLogger.dispatchLog({ 
            level: 'CRITICAL', 
            event: 'GLOBAL_LOGOUT_FAILED', 
            userId, 
            details: { error: error.message, ip: clientIp } 
        });
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
            success: false,
            message: "Failed to initiate global sign-out." 
        });
    }
});

// -----------------------------------------------------------
// --- Admin Forced Logout ---

/**
 * @desc Allows an administrator to force-revoke all sessions for a specific user.
 * @route POST /api/v1/admin/user/:userId/force-logout
 */
const adminForceLogout = asyncHandler(async (req, res, next) => {
    const targetUserId = req.params.userId;
    const adminId = req.user?.id || req.user?.userID; 
    const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;

    if (!targetUserId) {
        return res.status(StatusCodes.BAD_REQUEST).json({ 
            success: false,
            message: "Target User ID is required." 
        });
    }

    const context = { ip: clientIp, originator: 'ADMIN_FORCE', adminId };
    
    try {
        await logoutAllDevices(targetUserId, context);

        auditLogger.dispatchLog({ 
            level: 'SECURITY', 
            event: 'ADMIN_FORCE_LOGOUT_INITIATED', 
            userId: targetUserId, 
            details: { performedBy: adminId, ip: clientIp, reason: req.body.reason || 'Not specified' } 
        });

        return res.status(StatusCodes.ACCEPTED).json({ 
            success: true,
            message: `Force-logout successfully initiated for user ID: ${targetUserId}.` 
        });

    } catch (error) {
        auditLogger.dispatchLog({ 
            level: 'CRITICAL', 
            event: 'ADMIN_LOGOUT_FAILED', 
            userId: targetUserId, 
            details: { error: error.message, performedBy: adminId, ip: clientIp } 
        });
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
            success: false,
            message: "Failed to initiate forced logout." 
        });
    }
});

module.exports = { 
    logout, 
    triggerPanicLogout,
    globalSignOut, 
    adminForceLogout 
};