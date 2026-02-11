"use strict";

const crypto = require("crypto");
const Logger = require("../../utils/logger");
const Tracing = require("../../utils/tracingClient");
const { packRateLimitKey } = require("../../utils/redisKey");
const { preventReplay } = require("../../utils/webhookReplayProtector");
const { getRedisClient } = require("../../lib/redisClient");

const ALGORITHMS = {
    FWC: "FWC",
    SWL: "SWL",
};

/**
 * COSMOS HYPER-FABRIC OMEGA: Rate Limiter Factory
 * ----------------------------------------------
 * Features:
 * 1. Lazy SHA Loading: Prevents boot-time crashes.
 * 2. Replay Protection: Prevents duplicate non-GET requests.
 * 3. Atomic LUA Execution: High-performance O(1) checks.
 * 4. OpenTelemetry Tracing: Deep visibility into rate-limit events.
 */
function createRateLimiterFactory({
    shas,
    temporarilyBlock,
    isBlocked,
    getFabricStatus,
}) {
    
    // Default identifier logic (IP or User ID)
    const defaultIdentifierFn = (req) => {
        if (req.user && (req.user._id || req.user.id)) {
            return `user:${(req.user._id || req.user.id).toString()}`;
        }
        const ip =
            req.headers["x-forwarded-for"]?.split(",").shift() ||
            req.ip ||
            req.connection?.remoteAddress;
        return `ip:${ip || "unknown"}`;
    };

    /**
     * Returns the configured limiter middleware instance
     */
    return function createLimiter({
        algorithm = ALGORITHMS.FWC,
        windowSeconds = 60,
        max = 120,
        keyPrefix = "rl",
        identifierFn,
        blockOnExceed = { enabled: false, banSeconds: 300 },
        softBanDelayMs = 0,
        penaltySeconds = 0,
    } = {}) {
        const getIdentifier = identifierFn || defaultIdentifierFn;

        // THE ACTUAL MIDDLEWARE
        return async (req, res, next) => {
            // 1. Redis Availability Check (Fail Open)
            let redisClient;
            try {
                redisClient = getRedisClient();
            } catch (e) {
                redisClient = null;
            }

            if (!redisClient || redisClient.status !== "ready") {
                Logger.warn("RATE_LIMITER_FAIL_OPEN_REDIS_NOT_READY");
                return next();
            }

            // 2. Correlation ID & Fabric Health
            if (!req.ingressRequestId) {
                req.ingressRequestId = crypto.randomUUID();
            }

            if (getFabricStatus && !getFabricStatus()) {
                Logger.warn("RATE_LIMITER_FAIL_OPEN_FABRIC_UNHEALTHY");
                return next();
            }

            // 3. Lazy SHA Validation (The Boot-Crash Fix)
            // We check the specific SHA inside the 'shas' object reference
            const targetSha = algorithm === ALGORITHMS.SWL ? shas.SWL_SHA : shas.FWC_SHA;
            if (!targetSha) {
                Logger.warn(`RATE_LIMITER_SHAS_NOT_READY: Bypassing ${algorithm}`);
                return next();
            }

            const span = Tracing.startSpan(`rateLimiter:${algorithm}`);

            try {
                const identifier = getIdentifier(req);
                const blockKey = identifier; // Key used for manual blocks
                const limitKey = packRateLimitKey(keyPrefix, identifier);

                req.rateLimitKey = limitKey;

                span.setAttribute("rateLimit.algorithm", algorithm);
                span.setAttribute("rateLimit.identifier", identifier);
                span.setAttribute("rateLimit.ingressRequestId", req.ingressRequestId);

                // A. GLOBAL BLOCKLIST CHECK
                if (isBlocked && await isBlocked(redisClient, blockKey)) {
                    span.setAttribute("rateLimit.result", "BLOCKED");
                    res.setHeader("Retry-After", String(blockOnExceed.banSeconds || 300));
                    return res.status(403).json({
                        status: "fail",
                        message: "Access denied: Account/IP temporarily restricted due to abuse.",
                    });
                }

                // B. REPLAY PROTECTION (Inherited from previous logic)
                const replayEnabled =
                    req.method !== "GET" &&
                    req.method !== "HEAD" &&
                    req.method !== "OPTIONS" &&
                    (req.headers["x-event-id"] || req.headers["x-webhook-id"] || req.headers["x-provider"]);

                if (replayEnabled && req.rawBody) {
                    const isReplay = await preventReplay({
                        rawBody: req.headers["x-event-id"] || req.headers["x-webhook-id"] || req.rawBody,
                        provider: req.headers["x-provider"] || "http",
                        providerId: req.headers["x-provider-id"] || "",
                        signature: req.headers["x-signature"] || "",
                        parsedPayload: req.body,
                        headers: req.headers,
                        metadata: { route: req.originalUrl, identifier, ingressRequestId: req.ingressRequestId },
                    });

                    if (isReplay) {
                        span.setAttribute("rateLimit.result", "REPLAY_BLOCKED");
                        if (temporarilyBlock) await temporarilyBlock(redisClient, `replay:${identifier}`, 600);
                        res.setHeader("Retry-After", "600");
                        return res.status(429).json({ status: "fail", code: "REPLAY_DETECTED", message: "Duplicate request detected." });
                    }
                }

                // C. LUA SCRIPT EXECUTION
                let allowed, currentCount, ttlMs;
                
                if (algorithm === ALGORITHMS.SWL) {
                    // SWL LUA returns: { 1/0, current_count, pttl }
                    const results = await redisClient.evalsha(
                        targetSha, 1, limitKey, max, windowSeconds * 1000, penaltySeconds * 1000
                    );
                    allowed = results[0];
                    currentCount = results[1];
                    ttlMs = results[2];
                } else {
                    // FWC LUA returns: { current_count, ttl_seconds }
                    const results = await redisClient.evalsha(
                        targetSha, 1, limitKey, max, windowSeconds
                    );
                    currentCount = results[0];
                    allowed = currentCount <= max ? 1 : 0;
                    ttlMs = results[1] * 1000;
                }

                const resetIn = Math.ceil(ttlMs / 1000) || windowSeconds;
                const remaining = Math.max(0, max - currentCount);

                res.setHeader("X-RateLimit-Limit", String(max));
                res.setHeader("X-RateLimit-Remaining", String(remaining));
                res.setHeader("X-RateLimit-Reset", String(resetIn));

                // D. HANDLE REJECTION
                if (allowed === 0) {
                    span.setAttribute("rateLimit.result", "EXCEEDED");
                    
                    if (blockOnExceed?.enabled && temporarilyBlock) {
                        await temporarilyBlock(redisClient, blockKey, blockOnExceed.banSeconds || 300);
                    }

                    if (softBanDelayMs > 0) {
                        await new Promise((r) => setTimeout(r, softBanDelayMs));
                    }

                    res.setHeader("Retry-After", String(resetIn));
                    return res.status(429).json({
                        status: "fail",
                        code: "RATE_LIMIT_EXCEEDED",
                        message: `Too many requests. Try again in ${resetIn} seconds.`,
                    });
                }

                span.setAttribute("rateLimit.result", "ALLOWED");
                span.end();
                return next();

            } catch (err) {
                Logger.error("RATE_LIMITER_ERROR_FAIL_OPEN", { error: err.message });
                if (span) {
                    span.recordError(err);
                    span.end();
                }
                return next();
            }
        };
    };
}

module.exports = { ALGORITHMS, createRateLimiterFactory };