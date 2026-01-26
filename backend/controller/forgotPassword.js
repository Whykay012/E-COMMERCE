const mongoose = require("mongoose");
const { StatusCodes } = require("http-status-codes");
const asyncHandler = require("../middleware/asyncHandler");
const logger = require("../config/logger");

// 🛡️ Import the unified service we just merged
const { initiatePasswordReset } = require("../services/passwordResetService"); 

/**
 * @description Controller for POST /api/auth/forgot-password
 */
const forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;
    
    // 1. Prepare context for the service (Tracing & Rate Limiting)
    const context = {
        ip: req.ip,
        traceId: req.header('x-trace-id') || 'internal-' + Date.now(),
        userAgent: req.get('user-agent')
    };

    // 2. Start the Session for Atomic Reliability
    const session = await mongoose.startSession();
    session.startTransaction();

    // 🕒 Security Timing: Start clock to prevent timing attacks
    const startTime = Date.now();

    try {
        // 3. Call the Zenith-merged Service
        // We pass 'email' as the identifier, context for metrics, and the session for atomicity
        await initiatePasswordReset(email, context, session);

        // 4. Commit everything together (Token save + Outbox record)
        await session.commitTransaction();
        
    } catch (error) {
        // Rollback ensures no orphaned Outbox messages if the DB fails
        await session.abortTransaction();
        
        logger.error("FORGOT_PASSWORD_CONTROLLER_ERROR", { 
            email, 
            error: error.message 
        });
        
        // Note: If the error is a 'BadRequestError' (Rate Limit), we could 
        // handle it specifically, but for security, we often return the same 200.
    } finally {
        session.endSession();
    }

    // 5. 🛡️ Enumeration Protection: Force a fixed response window
    const elapsed = Date.now() - startTime;
    const buffer = Math.max(0, 1000 - elapsed);

    setTimeout(() => {
        return res.status(StatusCodes.OK).json({
            message: "If an account exists, a password reset link has been sent."
        });
    }, buffer);
});

module.exports = { forgotPassword };