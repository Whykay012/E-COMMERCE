// middleware/rateLimiter.js
const { getRedisClient } = require("../lib/redisClient");
const { temporarilyBlock } = require("../services/rateLimiters/rateLimiterUtils");

const REPLAY_WINDOW_SEC = 60;      // example window
const REPLAY_BAN_THRESHOLD = 5;    // max allowed
const TEMP_BAN_SEC = 300;          // temporary block duration

/**
 * Rate limiter + replay protection middleware
 */
module.exports = async function rateLimiter(req, res, next) {
    try {
        const redis = getRedisClient();

        // Build keys (per user/IP)
        const identifier = req.user?.id || req.ip || "unknown";
        const replayCounterKey = `replay:${identifier}`;
        const banKey = `ban:${identifier}`;

        const [replayCount, banned] = await redis.replayGuard(
            replayCounterKey,
            banKey,
            REPLAY_WINDOW_SEC,
            REPLAY_BAN_THRESHOLD,
            TEMP_BAN_SEC
        );

        if (banned) {
            return res.status(429).json({
                status: "fail",
                message: "Too many requests. Temporarily blocked.",
            });
        }

        req.replayCount = replayCount; // optional, for logging/metrics
        next();
    } catch (err) {
        console.error("Rate limiter failed (fail-open)", err);
        next(); // fail-open: allow request if Redis fails
    }
};
