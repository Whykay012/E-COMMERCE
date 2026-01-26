// controllers/auth/refreshTokenController.js (OPTIMIZED WITH NEW COOKIE CONFIG)

const { StatusCodes } = require("http-status-codes");
const AuthenticationError = require("../errors/unauthenication-error"); // Assuming this path is correct

// 💡 Import the two new service functions
const { refreshUserTokens } = require('../../services/authService'); 

// Assume COOKIE_CFG is imported from a central config file
const COOKIE_CFG = require("../config/cookieConfig")

/**
 * @desc Handles refresh token rotation and issues a new Access Token/CSRF Token.
 * @route POST /api/v1/auth/refresh
 * @access Private (Requires Refresh Token in HTTP-Only Cookie)
 */
const refresh = async (req, res, next) => {
    
    // 🎯 OPTIMIZATION: Use specific cookie options for reliable clearing.
    const clearAuthCookies = () => {
        // Must clear with the options used to SET them (especially domain/path/secure)
        res.clearCookie(COOKIE_CFG.ACCESS_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);
        res.clearCookie(COOKIE_CFG.REFRESH_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);
        res.clearCookie(COOKIE_CFG.CSRF_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_CSRF);
        
        if (COOKIE_CFG.SESSION_COOKIE_NAME) {
            // Assuming SESSION_COOKIE_NAME uses the REFRESH options as a base for persistence
            res.clearCookie(COOKIE_CFG.SESSION_COOKIE_NAME, COOKIE_CFG.COOKIE_OPTIONS_REFRESH); 
        }
    };

    try {
        // 1. Get Refresh Token from secure HTTP-Only cookie
        const oldRefreshToken = req.cookies[COOKIE_CFG.REFRESH_COOKIE_NAME];
        if (!oldRefreshToken) {
            clearAuthCookies();
            throw new AuthenticationError("No refresh token provided.");
        }

        // 2. Extract Context
        const clientIp = req.headers["x-forwarded-for"]?.split(",").shift().trim() || req.ip || null;
        const userAgent = req.get("User-Agent") || "unknown";

        // 3. Delegate to Service (Validation, Revocation of Old Token, Generation of New Tokens)
        // This is where Token Rotation logic lives 
        const { accessToken, newRefreshToken, csrfToken, user } = await refreshUserTokens(oldRefreshToken, {
            ip: clientIp,
            userAgent,
            requestId: req.id,
        });

        // 4. Set New Secure Cookies
        // 🎯 OPTIMIZATION: Directly use the fully defined, secure options from COOKIE_CFG.

        // A. New Access Token (short-lived, HTTP-only)
        res.cookie(COOKIE_CFG.ACCESS_COOKIE_NAME, accessToken, COOKIE_CFG.COOKIE_OPTIONS_ACCESS);

        // B. ROTATED Refresh Token (long-lived, HTTP-only)
        res.cookie(COOKIE_CFG.REFRESH_COOKIE_NAME, newRefreshToken, COOKIE_CFG.COOKIE_OPTIONS_REFRESH);

        // C. New CSRF token (JS-readable)
        if (csrfToken) {
            res.cookie(COOKIE_CFG.CSRF_COOKIE_NAME, csrfToken, COOKIE_CFG.COOKIE_OPTIONS_CSRF);
        }
        
        // 5. Response
        return res.status(StatusCodes.OK).json({
            success: true,
            message: "Tokens refreshed successfully.",
            user: { 
                id: user.id, 
                role: user.role, 
            },
            meta: { csrfCookie: !!csrfToken },
        });

    } catch (err) {
        // Clear all cookies on failure to force re-login (mitigates token reuse attacks)
        clearAuthCookies();
        // Pass error to global handler
        return next(err);
    }
};

module.exports = refresh;