const mongoose = require('mongoose');
const Logger = require("../config/logger");

// Define a simple schema for tracking attempts if not already present
const ResetAttemptSchema = new mongoose.Schema({
    userId: { type: String, index: true },
    ip: { type: String, index: true },
    createdAt: { type: Date, default: Date.now, expires: '24h' } // Auto-cleanup
});

const ResetAttempt = mongoose.model('ResetAttempt', ResetAttemptSchema);

const passwordResetLimiter = {
    /**
     * Checks if a user or IP is currently rate-limited
     */
    checkAttempt: async (userId, ip) => {
        const windowMinutes = 15;
        const maxAttempts = 3;
        const lookbackLimit = new Date(Date.now() - windowMinutes * 60 * 1000);

        // Count attempts by this specific User OR this specific IP
        const attemptCount = await ResetAttempt.countDocuments({
            $or: [{ userId }, { ip }],
            createdAt: { $gt: lookbackLimit }
        });

        if (attemptCount >= maxAttempts) {
            return {
                isRateLimited: true,
                timeToWaitMinutes: windowMinutes
            };
        }

        return { isRateLimited: false };
    },

    /**
     * Records a successful attempt within the current transaction session
     */
    recordAttempt: async (userId, ip, session) => {
        await ResetAttempt.create([{ userId, ip }], { session });
        Logger.info("RESET_ATTEMPT_RECORDED", { userId, ip });
    }
};

module.exports = passwordResetLimiter;