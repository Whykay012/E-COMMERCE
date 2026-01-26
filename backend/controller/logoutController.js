// controllers/auth/logoutController.js (ULTIMATE PEAK - FINAL OPTIMIZED)

const { StatusCodes } = require("http-status-codes");
// 💡 Importing all necessary service functions
const { emitLogoutEvent, logoutAllDevices } = require('../../services/authService'); 
const auditLogger = require('../../services/auditLogger'); 

// Use the enhanced cookie config
const COOKIE_CFG = require('../config/cookieConfig'); 

// -----------------------------------------------------------
// --- Primary Logout (Single Session) ---

/**
 * @desc Logs the user out by revoking the Refresh Token/Session and clearing cookies,
 * and dispatches an event for asynchronous server-side revocation and cleanup.
 * @route POST /api/v1/auth/logout
 */
const logout = async (req, res, next) => {
    
    // 1. Extract necessary identifiers and context
    const refreshToken = req.cookies[COOKIE_CFG.REFRESH_COOKIE_NAME];
    const userId = req.user?.id; 
    const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const hasIdentifiers = refreshToken || userId;

    // 2. IMMEDIATE CLIENT-SIDE REVOCATION (Synchronous and Non-Negotiable)
    // 🎯 OPTIMIZATION: Use specific cookie options for reliable deletion.
    res.clearCookie(COOKIE_CFG.ACCESS_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);
    res.clearCookie(COOKIE_CFG.REFRESH_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
    res.clearCookie(COOKIE_CFG.CSRF_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_CSRF);
    
    // NOTE: If using the SESSION_COOKIE_NAME, it typically requires a generic secure option set
    if (COOKIE_CFG.SESSION_COOKIE_NAME) {
        // Assuming SESSION_COOKIE_NAME uses the REFRESH options as a base for persistence
        res.clearCookie(COOKIE_CFG.SESSION_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_REFRESH); 
    }

    // 3. EFFICIENT SERVER-SIDE DECOUPLING (Emit Event/Job)
    if (hasIdentifiers) {
        
        // Prepare payload for the background job
        const logoutPayload = { 
            refreshToken, 
            userId,
            context: { ip: clientIp, userAgent, type: 'SINGLE_DEVICE_LOGOUT' }
        };

        // 🚀 NON-BLOCKING: Emit the event/job to the queue.
        emitLogoutEvent(logoutPayload)
            .then(() => {
                // LOG SUCCESSFUL EMISSION
                auditLogger.dispatchLog({
                    level: 'INFO',
                    event: 'LOGOUT_SESSION_QUEUED',
                    userId: userId,
                    details: { ip: clientIp, type: 'SINGLE_DEVICE' }
                });
            })
            .catch(error => {
                // LOG CRITICAL FAILURE (Queue service down)
                auditLogger.dispatchLog({
                    level: 'CRITICAL',
                    event: 'LOGOUT_QUEUE_EMISSION_FAILED',
                    userId: userId || 'N/A',
                    details: { error: error.message, ip: clientIp }
                });
            });
    } else {
        // Log if a client attempts to log out without any session identifiers
        auditLogger.dispatchLog({
            level: 'WARN',
            event: 'LOGOUT_NO_IDENTIFIERS',
            details: { ip: clientIp, userAgent: userAgent }
        });
    }
    
    // 4. FINAL RESPONSE (Always 204 for successful client-side action)
    return res.status(StatusCodes.NO_CONTENT).send(); 
};

// --- Advanced Logout: Global Sign-Out (Self-Service) ---

/**
 * @desc Allows a user to revoke all their refresh tokens and invalidate sessions across all devices.
 * @route POST /api/v1/auth/logout-all
 * @access Private
 */
const globalSignOut = async (req, res, next) => {
    const userId = req.user?.id; 
    const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    if (!userId) {
        return res.status(StatusCodes.UNAUTHORIZED).send({ message: "Authentication required for global sign-out." });
    }

    const context = { ip: clientIp, userAgent, originator: 'USER_SELF_SERVICE' };

    try {
        // logoutAllDevices queues the job and returns immediately
        await logoutAllDevices(userId, context);

        // ENHANCEMENT: Log Successful Action (using SECURITY level for sensitive action)
        auditLogger.dispatchLog({ 
            level: 'SECURITY', 
            event: 'GLOBAL_LOGOUT_INITIATED', 
            userId: userId, 
            details: { ip: clientIp, initiator: 'Self' } 
        });

        // 🎯 OPTIMIZATION: Use specific cookie options for reliable deletion.
        res.clearCookie(COOKIE_CFG.ACCESS_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);
        res.clearCookie(COOKIE_CFG.REFRESH_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
        res.clearCookie(COOKIE_CFG.CSRF_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_CSRF);

        // Success response
        return res.status(StatusCodes.ACCEPTED).send({ message: "Global sign-out initiated successfully. All other devices will be logged out shortly." });

    } catch (error) {
        // Log Critical Failure
        auditLogger.dispatchLog({ 
            level: 'CRITICAL', 
            event: 'GLOBAL_LOGOUT_FAILED', 
            userId, 
            details: { error: error.message, ip: clientIp } 
        });
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).send({ message: "Failed to initiate global sign-out." });
    }
};

// --- Advanced Logout: Admin Forced Logout ---

/**
 * @desc Allows an administrator to force a user to revoke all sessions.
 * @route POST /api/v1/admin/user/:userId/force-logout
 * @access Private/AdminOnly
 */
const adminForceLogout = async (req, res, next) => {
    const targetUserId = req.params.userId;
    const adminId = req.user?.id; 
    const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    if (!targetUserId) {
        return res.status(StatusCodes.BAD_REQUEST).send({ message: "Target User ID is required." });
    }

    const context = { ip: clientIp, userAgent, originator: 'ADMIN_FORCE', adminId };
    
    try {
        await logoutAllDevices(targetUserId, context);

        // ENHANCEMENT: Log Successful Action (using SECURITY level for sensitive action)
        auditLogger.dispatchLog({ 
            level: 'SECURITY', 
            event: 'ADMIN_FORCE_LOGOUT_INITIATED', 
            userId: targetUserId, 
            details: { performedBy: adminId, ip: clientIp, reason: req.body.reason || 'N/A' } 
        });

        return res.status(StatusCodes.ACCEPTED).send({ message: `Forced logout initiated for user ${targetUserId}.` });

    } catch (error) {
        // Log Critical Failure
        auditLogger.dispatchLog({ 
            level: 'CRITICAL', 
            event: 'ADMIN_LOGOUT_FAILED', 
            userId: targetUserId, 
            details: { error: error.message, performedBy: adminId, ip: clientIp } 
        });
        return res.status(StatusCodes.INTERNAL_SERVER_ERROR).send({ message: "Failed to initiate forced logout." });
    }
};

module.exports = { 
    logout, 
    globalSignOut, 
    adminForceLogout 
};