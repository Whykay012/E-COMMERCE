const jwt = require('jsonwebtoken');
const tokenStore = require('./redisTokenStore');
const { UnauthorizedError } = require('../errors');
const { Logger, Metrics } = require('../utils/telemetry');




const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ISSUER = 'auth-service';

/**
 * @desc Peak-level Refresh Token Validation
 * Performs a 3-tier check: Signature -> Expiry -> Redis Whitelist
 */
const validateRefreshToken = async (token) => {
    if (!token) return { isValid: false, error: 'Token missing' };

    try {
        // 1. Verify Signature and Structure
        const payload = jwt.verify(token, JWT_REFRESH_SECRET, { 
            issuer: ISSUER,
            algorithms: ['HS256'] 
        });

        // 2. State Check: Verify the JTI exists in the Redis Whitelist
        const sessionData = await tokenStore.getRefreshToken(payload.jti);
        
        if (!sessionData) {
            Metrics.security('refresh_token.missing_in_store', { jti: payload.jti });
            return { isValid: false, error: 'Session not found or expired' };
        }

        // 3. Identity Check: Ensure token sub matches stored userId
        if (sessionData.u !== payload.sub) {
            Logger.security('REFRESH_TOKEN_IDENTITY_MISMATCH', { 
                tokenUser: payload.sub, 
                storedUser: sessionData.u 
            });
            return { isValid: false, error: 'Identity mismatch' };
        }

        return { 
            isValid: true, 
            jti: payload.jti, 
            userId: payload.sub, 
            sessionData 
        };

    } catch (err) {
        Metrics.increment('auth.refresh_validation.fail', 1, { reason: err.name });
        return { isValid: false, error: err.message };
    }
};

module.exports = { validateRefreshToken };