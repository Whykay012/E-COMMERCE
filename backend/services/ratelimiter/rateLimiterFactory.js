const crypto = require("crypto");
const Logger = require("../../utils/logger");
const Tracing = require("../../utils/tracingClient");
const { packRateLimitKey } = require("../utils/redisKey");
const { preventReplay } = require("../utils/preventReplay");

const ALGORITHMS = {
    FWC: "FWC",
    SWL: "SWL",
};

function createRateLimiterFactory({
    shas,
    redisClient,
    temporarilyBlock,
    isBlocked,
    getFabricStatus,
}) {
    if (!redisClient) throw new Error("RateLimiter Factory requires a Redis client.");
    if (!shas || !shas.FWC || !shas.SWL) {
        throw new Error("Missing pre-loaded SHAs for FWC/SWL.");
    }

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
        const scriptSha = shas[algorithm];
        const getIdentifier = identifierFn || defaultIdentifierFn;

        const rateLimiterMiddleware = async (req, res, next) => {
            // 🔗 CORRELATION ROOT (created once)
            if (!req.ingressRequestId) {
                req.ingressRequestId = crypto.randomUUID();
            }

            // 🚨 FAIL-OPEN IF REDIS FABRIC IS UNHEALTHY
            if (getFabricStatus && !getFabricStatus()) {
                Logger.warn("RATE_LIMITER_FAIL_OPEN_FABRIC_UNHEALTHY", {
                    route: req.originalUrl,
                    ingressRequestId: req.ingressRequestId,
                });
                return next();
            }

            const span = Tracing.startSpan(`rateLimiter:${algorithm}`);

            try {
                const identifier = getIdentifier(req);
                const blockKey = identifier;
                const limitKey = packRateLimitKey(keyPrefix, identifier);

                // 🔗 CORRELATION PROPAGATION
                req.rateLimitKey = limitKey;

                span.setAttribute("rateLimit.algorithm", algorithm);
                span.setAttribute("rateLimit.identifier", identifier);
                span.setAttribute("rateLimit.key", limitKey);
                span.setAttribute("rateLimit.ingressRequestId", req.ingressRequestId);
                span.setAttribute("rateLimit.max", max);

                Logger.info("RATE_LIMIT_CHECK", {
                    ingressRequestId: req.ingressRequestId,
                    rateLimitKey: limitKey,
                    identifier,
                    route: req.originalUrl,
                });

                // A. BLOCKLIST CHECK
                if (await isBlocked(redisClient, blockKey)) {
                    span.setAttribute("rateLimit.result", "BLOCKED");

                    res.setHeader(
                        "Retry-After",
                        String(blockOnExceed.banSeconds || 300)
                    );

                    return res.status(429).json({
                        status: "fail",
                        message: "Temporarily blocked due to abusive activity.",
                    });
                }

                // 🔁 REPLAY PROTECTION (NON-SAFE METHODS ONLY)
                const replayEnabled =
                    req.method !== "GET" &&
                    req.method !== "HEAD" &&
                    req.method !== "OPTIONS" &&
                    (req.headers["x-event-id"] ||
                        req.headers["x-webhook-id"] ||
                        req.headers["x-provider"]);

                if (replayEnabled && req.rawBody) {
                    const eventId =
                        req.headers["x-event-id"] ||
                        req.headers["x-webhook-id"] ||
                        "";

                    const isReplay = await preventReplay({
                        rawBody: eventId || req.rawBody,
                        provider: req.headers["x-provider"] || "http",
                        providerId: req.headers["x-provider-id"] || "",
                        signature: req.headers["x-signature"] || "",
                        parsedPayload: req.body,
                        headers: req.headers,
                        metadata: {
                            route: req.originalUrl,
                            identifier,
                            ingressRequestId: req.ingressRequestId,
                            rateLimitKey: limitKey,
                        },
                    });

                    if (isReplay) {
                        span.setAttribute("rateLimit.replayDetected", true);
                        span.setAttribute("rateLimit.result", "REPLAY_BLOCKED");

                        Logger.warn("REPLAY_BLOCKED_AT_RATE_LIMITER", {
                            ingressRequestId: req.ingressRequestId,
                            identifier,
                            rateLimitKey: limitKey,
                            eventId,
                        });

                        const replayBlockKey = `replay:${identifier}:${req.route?.path || "unknown"}`;
                        await temporarilyBlock(redisClient, replayBlockKey, 600);

                        res.setHeader("Retry-After", "600");
                        return res.status(429).json({
                            status: "fail",
                            code: "REPLAY_DETECTED",
                            message: "Duplicate request detected",
                        });
                    }
                }

                let currentCount, ttlSeconds, allowed;
                let results;

                // B. LUA RATE LIMIT EXECUTION
                if (algorithm === ALGORITHMS.SWL) {
                    const windowMs = windowSeconds * 1000;
                    results = await redisClient.evalsha(
                        scriptSha,
                        1,
                        limitKey,
                        max,
                        windowMs,
                        penaltySeconds
                    );

                    allowed = results[0];
                    currentCount = results[1];
                    ttlSeconds = results[2];
                } else {
                    results = await redisClient.evalsha(
                        scriptSha,
                        1,
                        limitKey,
                        max,
                        windowSeconds
                    );

                    currentCount = results[0];
                    ttlSeconds = results[1];
                }

                const exceeded = currentCount > max;
                const remaining = Math.max(0, max - currentCount);
                const resetIn = ttlSeconds > 0 ? ttlSeconds : windowSeconds;

                res.setHeader("X-RateLimit-Limit", String(max));
                res.setHeader("X-RateLimit-Remaining", String(remaining));
                res.setHeader("X-RateLimit-Reset", String(resetIn));

                if (exceeded) {
                    span.setAttribute("rateLimit.result", "EXCEEDED");

                    Logger.warn("RATE_LIMIT_EXCEEDED", {
                        ingressRequestId: req.ingressRequestId,
                        rateLimitKey: limitKey,
                        currentCount,
                        max,
                        resetIn,
                    });

                    if (blockOnExceed?.enabled) {
                        await temporarilyBlock(
                            redisClient,
                            blockKey,
                            blockOnExceed.banSeconds || 300
                        );
                    }

                    if (softBanDelayMs > 0) {
                        await new Promise((r) => setTimeout(r, softBanDelayMs));
                    }

                    res.setHeader("Retry-After", String(resetIn));
                    return res.status(429).json({
                        status: "fail",
                        code: "RATE_LIMIT_EXCEEDED",
                        message: `Rate limit exceeded. Try again in ${resetIn} seconds.`,
                    });
                }

                span.setAttribute("rateLimit.result", "ALLOWED");
                span.end();
                return next();

            } catch (err) {
                Logger.critical("RATE_LIMITER_CRITICAL_FAILURE_FAIL_OPEN", {
                    error: err.message,
                    ingressRequestId: req.ingressRequestId,
                });

                if (span) {
                    span.recordError(err);
                    span.end();
                }
                return next();
            }
        };

        return rateLimiterMiddleware;
    };
}

module.exports = { ALGORITHMS, createRateLimiterFactory };
