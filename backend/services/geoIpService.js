// geoip/geoIpService.js
// ENTERPRISE-GRADE GEOIP SERVICE
// Fully integrated with Tracing, Advanced Logging, Metrics, Adaptive Caching, and Risk Engine.

const geoIpReader = require("./maxMindReader");
const cache = require("../lib/redisCacheUtil");
const Tracing = require("../utils/tracingClient"); // Distributed Tracing Client
const Metrics = require("../utils/metricsClient"); // Distributed Telemetry Client (StatsD)
const logger = require("../utils/logger"); // Advanced Pino Logger (for operational events)
const auditLogger = require("./auditLogger"); // Conceptual Audit Logger (for security/business events)

const { BLOCKED_COUNTRIES, CHALLENGE_COUNTRIES, countryStatus } = require("./risk/policies");
const { Queue, Worker } = require("bullmq");
const Redis = require("ioredis");

// ---------------- CONFIG ----------------
const GEOIP_CACHE_TTL = Number(process.env.GEOIP_CACHE_TTL_SECONDS) || 24 * 60 * 60; // 24h
const GEOIP_STALE_TTL = Number(process.env.GEOIP_STALE_TTL_SECONDS) || 60 * 60; // 1h
const EARTH_RADIUS_KM = 6371;

// ---------------- BULLMQ SETUP ----------------
const connection = { 
    host: process.env.REDIS_HOST || '127.0.0.1', 
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null // ✅ MUST be null for BullMQ stability
};
const geoipQueueName = "geoip-refresh-queue";

const geoipQueue = new Queue(geoipQueueName, { connection });

const toRad = deg => deg * (Math.PI / 180);

const geoipWorker = new Worker(
    geoipQueueName,
    async job => {
        const { ip, traceContext } = job.data;
        if (!ip) {
            Metrics.increment("geoip.worker.job_skipped_total");
            return;
        }
        
        // 🚀 TRACING: Restore context and start span for background job
        return Tracing.context.with(Tracing.deserializeContext(traceContext), async () => {
            return Tracing.withSpan(`GeoIPWorker:refresh:${ip}`, async (span) => {
                span.setAttributes({ 'job.id': job.id, 'ip': ip });
                const cacheKey = `geoip:${ip}`;
                const start = process.hrtime.bigint();

                try {
                    // Use a unified lookup function if provided by geoIpReader
                    const raw = geoIpReader.lookupSync ? geoIpReader.lookupSync(ip) : await geoIpReader.lookup(ip);
                    const normalized = normalizeRaw(raw);
                    
                    if (normalized) {
                        await cache.set(cacheKey, normalized, GEOIP_CACHE_TTL);
                        // Stale cache item is now handled by the `cachedWithStale` in lookupLocation, 
                        // but setting a shorter-lived backup key is a valid failover strategy.
                        // I'll keep the original logic, assuming cache utility handles stale read internally.
                        await cache.set(`stale:${cacheKey}`, normalized, GEOIP_STALE_TTL);
                        
                       const durationMs = Number((process.hrtime.bigint() - start) / 1000000n); // Force BigInt math then convert to Number
                        Metrics.timing("geoip.worker.duration_ms", durationMs, { status: 'success' });
                        Metrics.increment("geoip.worker.refresh_success_total");
                        
                        span.setStatus({ code: Tracing.SpanStatusCode.OK });
                        logger.debug('GEOIP_REFRESH_SUCCESS', { ip, country: normalized.country_iso });
                    } else {
                        Metrics.increment("geoip.worker.refresh_miss_total");
                        span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: "Normalization failed" });
                        logger.warn("GEOIP_BACKGROUND_NORMALIZATION_FAILED", { ip });
                    }
                } catch (err) {
                    Metrics.increment("geoip.worker.refresh_failed_total");
                    
                    // 🚨 Advanced Logger for Operational Failure
                    logger.error("GEOIP_BACKGROUND_REFRESH_FAILED", { ip, error: err });
                    
                    // Audit Logger for the security/business failure record
                    // Assuming auditLogger is implemented to call logger.security or logger.audit
                    auditLogger.dispatchLog({
                        level: "WARN",
                        event: "GEOIP_BACKGROUND_REFRESH_FAILED",
                        details: { ip, error: err.message },
                    });
                    
                    span.recordException(err);
                    span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: err.message });
                    throw err; 
                }
            });
        });
    },
    { connection, concurrency: 5, removeOnComplete: true }
);

// ---------------- NORMALIZATION ----------------
function normalizeRaw(raw) {
    if (!raw || !Number.isFinite(raw.latitude) || !Number.isFinite(raw.longitude)) return null;
    return {
        latitude: raw.latitude,
        longitude: raw.longitude,
        city: raw.city_name || "Unknown City",
        country: raw.country_name || "Unknown Country",
        country_iso: raw.country_iso || "UNK",
        timezone: raw.time_zone || "UTC",
    };
}

// ---------------- GEO LOOKUP (Adaptive + Stale Refresh) ----------------
async function lookupLocation(ip) {
    // 🚀 TRACING: Start a new span for the primary lookup operation
    return Tracing.withSpan(`GeoIPService:lookup:${ip}`, async (span) => {
        
        span.setAttributes({ 'ip.address': ip });
        if (!ip || ip.length < 7 || ip === "127.0.0.1" || ip === "::1") {
            Metrics.increment("geoip.lookup.skipped_local_total");
            span.setStatus({ code: Tracing.SpanStatusCode.OK, message: "Skipped local/invalid IP" });
            return null;
        }

        const cacheKey = `geoip:${ip}`;
        const start = process.hrtime.bigint();

        try {
            const { value: result, stale } = await cache.cachedWithStale(
                cacheKey,
                GEOIP_CACHE_TTL,
                async () => {
                    const lookupStart = process.hrtime.bigint();
                    const raw = geoIpReader.lookupSync ? geoIpReader.lookupSync(ip) : await geoIpReader.lookup(ip);
                    const normalized = normalizeRaw(raw);
                    
                    const lookupDurationMs = Number((process.hrtime.bigint() - lookupStart) / 1000000n);
                    Metrics.timing("geoip.direct_lookup.latency_ms", lookupDurationMs, { result: normalized ? 'hit' : 'miss' });
                    span.addEvent("direct_db_lookup", { cached: false, duration_ms: lookupDurationMs });
                    return normalized;
                },
                GEOIP_STALE_TTL
            );
            
            span.setAttributes({ 'cache.stale': stale, 'cache.hit': !!result });

            // Trigger background refresh if stale
            if (stale) {
                Metrics.increment("geoip.lookup.stale_total");
                Metrics.cacheMiss("geoip.lookup.stale"); // Semantic metric for cache utility
                
                // 🚀 TRACING: Capture context to propagate to the BullMQ job
                const traceContext = Tracing.serializeContext(Tracing.getCurrentContext());
                
                // Adaptive Delay Logic
                const hitCountKey = `geoip_hits:${ip}`;
                const hits = await cache.client.incr(hitCountKey); 
                await cache.client.expire(hitCountKey, 24 * 60 * 60);

                const adaptiveDelaySec = Math.max(
                    GEOIP_CACHE_TTL / (Math.log(hits + 1) * 2), 
                    300 
                );
                
                const jobId = `refresh:${ip}`;
                
                await geoipQueue.add(ip, { ip, traceContext }, { // Pass tracing context
                    jobId: jobId, 
                    delay: adaptiveDelaySec * 1000, 
                    priority: Math.min(hits, 10),
                    // Use advanced logger for scheduling event
                    onAdd: () => logger.debug('GEOIP_REFRESH_QUEUED', { ip, delaySec: adaptiveDelaySec, hits: hits }) 
                });
                Metrics.increment("geoip.queue.refresh_scheduled_total", { delay_sec: adaptiveDelaySec.toFixed(0) });
                span.addEvent("refresh_scheduled", { delay: adaptiveDelaySec });
            }

            const end = process.hrtime.bigint();
            const ms = Number(end - start) / 1e6;
            Metrics.timing("geoip.lookup.latency_ms", ms);
            Metrics.increment("geoip.lookups_total");

            if (result) {
                const cacheStatus = stale ? 'stale' : 'hit';
                Metrics.increment(`geoip.cache.${cacheStatus}_total`);
                if (!stale) Metrics.cacheHit("geoip.lookup"); // Semantic metric for cache utility

                span.setAttributes({ 'country.iso': result.country_iso, 'cache.status': cacheStatus });
                Metrics.increment("geoip.lookup.success_total");
                Metrics.increment("geoip.lookups_by_country_total", { country: result.country_iso });
            } else {
                span.setAttributes({ 'cache.status': 'miss' });
                Metrics.increment("geoip.lookup.miss_total");
                Metrics.cacheMiss("geoip.lookup.hard"); // Semantic metric for cache utility
            }
            span.setStatus({ code: Tracing.SpanStatusCode.OK });
            return result;
        } catch (err) {
            const end = process.hrtime.bigint();
            const ms = Number(end - start) / 1e6;
            Metrics.timing("geoip.lookup.latency_ms", ms, { status: 'fail' });
            Metrics.increment("geoip.lookup.fail_total");

            span.recordException(err);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: err.message });
            
            // 🚨 Advanced Logger for Operational Failure
            logger.error("GEOIP_LOOKUP_OPERATIONAL_FAILED", { ip, error: err });
            
            // Audit Logger for the security/business failure record
            auditLogger.dispatchLog({ level: "ERROR", event: "GEOIP_LOOKUP_FAILED", details: { ip, error: err.message } });
            return null;
        }
    });
}

// ---------------- DISTANCE ----------------
function calculateDistance(lat1, lon1, lat2, lon2) {
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) {
        Metrics.increment("distance.calculation_invalid_total");
        return Infinity;
    }
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(EARTH_RADIUS_KM * c * 1000) / 1000;
}

// ---------------- RISK ENGINE ----------------
async function assessRisk({ userId, ip, userAgent, lastKnownLocation, thresholds = {}, context = {} }) {
    // 🚀 TRACING: Start a span for the entire risk assessment
    return Tracing.withSpan(`RiskEngine:assess`, async (span) => {
        span.setAttributes({ 'user.id': userId, 'ip.address': ip, 'risk.context': context.type || 'general' });
        
        if (!ip) {
            // Using the new semantic logger for security/audit contract enforcement
            logger.security("RISK_ASSESSMENT_INVALID_INPUT", { userId: userId || 'N/A', eventCode: 'RISK_INVALID_IP', reason: "Missing IP" });
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: "Invalid input" });
            return { score: 0, reasons: ["invalid_input"], action: "allow", geo: null }; 
        }
        
        Metrics.increment("risk.assessment_total", 1, { context: context.type || 'general' });
        const start = process.hrtime.bigint();
        
        const cfg = {
            impossibleTravelKm: thresholds.impossibleTravelKm ?? Number(process.env.RISK_IMPOSSIBLE_TRAVEL_KM || 500),
            blockCountries: thresholds.blockCountries ?? BLOCKED_COUNTRIES,
            challengeCountries: thresholds.challengeCountries ?? CHALLENGE_COUNTRIES,
            challengeScoreThreshold: thresholds.challengeScoreThreshold ?? 30,
            blockScoreThreshold: thresholds.blockScoreThreshold ?? 80,
        };

        let score = 0;
        const reasons = [];
        // The nested lookupLocation call will create its own sub-span automatically
        const geo = await lookupLocation(ip); 
        
        if (!geo) { 
            reasons.push("geo_unknown"); 
            score += 5; 
            Metrics.increment("risk.reason.geo_unknown");
        }
        else {
            span.setAttributes({ 'country.iso': geo.country_iso });
            const { status, code } = countryStatus(geo.country_iso);
            
            // 1. Blocked Country Check
            if (status === "blocked") { 
                reasons.push(`blocked_country:${code}`); 
                score = 100; 
                // Using semantic security logger for critical security events
                logger.security("RISK_BLOCK_COUNTRY_TRIGGERED", { 
                    userId: userId || 'N/A', 
                    eventCode: 'GEO_BLOCK', 
                    ip, geo, 
                    reason: `Country ${code} is blocked` 
                }); 
                Metrics.increment("risk.action.block_total", 1, { reason: "country" });
                span.setAttributes({ 'risk.action': 'block', 'risk.reason': `country:${code}` });
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: "Blocked country" });
                return { score, reasons, action: "block", geo }; 
            }
            
            // 2. Challenge Country Check
            if (status === "challenge") { 
                reasons.push(`challenge_country:${code}`); 
                score += 30; 
                Metrics.increment("risk.reason.challenge_country");
            }
        }

        // 3. Impossible Travel Check
        if (lastKnownLocation && geo && Number.isFinite(lastKnownLocation.latitude) && Number.isFinite(lastKnownLocation.longitude)) {
            const dist = calculateDistance(lastKnownLocation.latitude, lastKnownLocation.longitude, geo.latitude, geo.longitude);
            span.setAttributes({ 'geo.distance_km': dist });
            if (dist > cfg.impossibleTravelKm) { 
                reasons.push(`impossible_travel:${dist}km`); 
                score += 50; 
                Metrics.increment("risk.reason.impossible_travel");
            }
            else if (dist > cfg.impossibleTravelKm * 0.5) { 
                reasons.push(`fast_travel:${dist}km`); 
                score += 20; 
                Metrics.increment("risk.reason.fast_travel");
            }
        }

        // 4. User Agent Check
        if (userAgent && /HeadlessChrome|PhantomJS|curl|wget|bot/i.test(userAgent)) { 
            reasons.push("suspicious_user_agent"); 
            score += 20; 
            Metrics.increment("risk.reason.suspicious_agent");
        }

        // 5. High Value Transaction Check
        if (context.payment?.amount && Number(context.payment.amount) > (context.payment.highValueThreshold || 500)) { 
            reasons.push("high_value_transaction"); 
            score += 20; 
            Metrics.increment("risk.reason.high_value_tx");
        }

        score = Math.min(100, Math.max(0, score));

        let action = "allow";
        if (score >= cfg.blockScoreThreshold) action = "block";
        else if (score >= cfg.challengeScoreThreshold) action = "challenge";

        if (action !== "allow") {
            // Using semantic security/audit logger for business-critical decision
            logger.security("RISK_ASSESSMENT_TRIGGERED", { 
                userId: userId || 'N/A', 
                eventCode: `RISK_${action.toUpperCase()}`, 
                ip, 
                score, 
                reasons, 
                action,
            });
            Metrics.increment(`risk.action.${action}_total`);
            
            // 🚨 Advanced Logger for high-level operational risk action
            logger.warn("RISK_ACTION_TAKEN", { userId, ip, score, action }); 
        } else {
            Metrics.increment(`risk.action.allow_total`);
            // Audit log for allowed high-risk transactions for compliance
            if (score > 10) { 
                 logger.audit("RISK_ASSESSMENT_ALLOWED", { 
                    entityId: userId || 'N/A', 
                    action: 'RISK_ALLOW', 
                    score, 
                    reasons 
                });
            }
        }
        
        // 🚀 TRACING: Final span attributes and status
        span.setAttributes({ 'risk.score': score, 'risk.action': action });
        span.setStatus({ code: Tracing.SpanStatusCode.OK });

const durationMs = Number((process.hrtime.bigint() - start) / 1000000n); // Force BigInt math then convert to Number
        Metrics.timing("risk.assessment.duration_ms", durationMs, { action: action });
        Metrics.gauge("risk.last_score", score, { user: userId, action: action });

        return { score, reasons, action, geo };
    });
}

// ---------------- HELPERS ----------------
function isCountryAllowed(iso) {
    if (!iso || iso === "UNK") return { allowed: false, reason: "unknown_origin" };
    const { status } = countryStatus(iso);
    return { allowed: status !== "blocked", reason: status };
}

// ---------------- INTEGRATION HOOKS ----------------
async function evaluateLoginRisk(opts) { return assessRisk({ ...opts, context: { ...opts.context, type: 'login' } }); }
async function evaluatePaymentRisk(opts) { return assessRisk({ ...opts, context: { ...opts.context, type: 'payment' } }); }


// ---------------- LIFECYCLE MANAGEMENT ----------------

/**
 * @desc Initializes all core enterprise services (Tracing, Metrics, Logging)
 */
async function initialize() {
    await Tracing.initialize(); 
    logger.initialize();
    Metrics.initialize();
    logger.info("GEOIP_SERVICE_INITIALIZING");
}

async function shutdown() {
    logger.info("GEOIP_SERVICE_SHUTTING_DOWN");

    // 1. Stop processing NEW jobs first
    await geoipWorker.close();
    await geoipQueue.close();

    // 2. Now that work is stopped, flush telemetry
    Metrics.shutdown(); 
    await Tracing.shutdown(); 
    await logger.shutdown(); 

    logger.info("GEOIP_SERVICE_SHUTDOWN_COMPLETE");
}

// ---------------- EXPORT ----------------
module.exports = {
    lookupLocation,
    calculateDistance,
    assessRisk,
    evaluateLoginRisk,
    evaluatePaymentRisk,
    isCountryAllowed,
    initialize, 
    shutdown,
    // Expose BullMQ elements for external service management
    queue: geoipQueue,
    worker: geoipWorker, 
   
};