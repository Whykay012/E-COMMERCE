/**
 * services/adminRateLimitService.js
 * Zenith Omega Stack - Enterprise HA Edition
 */

const { cacheConnection } = require("../lib/redisCacheClient"); 
const { querySentinelStatus } = require("../utils/redisSentinelClient"); 
const { DomainError } = require("../errors/customErrors");
const AuditLogger = require("./auditLogger"); 
const Tracing = require("../utils/tracingClient");
const logger = require("../utils/logger");
const metrics = require("../config/metrics");

// --- Configuration & Adaptive Policy Metrics ---
let configCache = {
    KEY_EXPIRY_THRESHOLD_DAYS: 360, 
    BLOCK_TTL_SECONDS: 3600 * 24 * 365,
    
    // ADJUSTED: Threshold in GB. Matches standard container limits.
    MEMORY_PRESSURE_THRESHOLD_GB: 1.5, 
    ADAPTIVE_TTL_REDUCTION_FACTOR: 0.5, 
    
    // CRITICAL: Must match docker-compose REDIS_MASTER_NAME
    DEFAULT_MASTER_NAME: process.env.REDIS_SENTINEL_MASTER_NAME || 'my-ecom-master',
    MAX_RATE_LIMIT_SCORE_BASE: 500, 
};

const BLOCKED_KEY_PREFIX = 'blocked:';
const WHITELIST_KEY_PREFIX = 'wl:';
const BLOCK_REVIEW_TTL_SECONDS = 3600 * 24 * 30; 
const PERMANENT_BAN_REASON = 'Permanent Ban';
const EXEMPT_KEY_PREFIXES = [BLOCKED_KEY_PREFIX, WHITELIST_KEY_PREFIX]; 

const BATCH_DELETE_LUA_SCRIPT = `
    local count = redis.call('DEL', unpack(KEYS))
    return count
`;

// --- Internal Utilities ---

async function checkWriteAccess(client) {
    const info = await client.info('replication');
    // In Sentinel, if we are connected to a Replica, role will be 'slave'
    if (info.includes('role:slave')) {
        logger.error('REDIS_READ_ONLY_ACCESS_DENIED', { redisRole: 'replica' });
        throw new DomainError(
            "Write operation failed: Targeting a Read-Only Replica.", 
            503, 
            'REDIS_READ_ONLY'
        );
    }
}

function normalizeKeyIdentifier(identifier) {
    identifier = identifier.trim().toLowerCase();
    if (identifier.startsWith('ip:') || identifier.startsWith('user:') || identifier.startsWith('cidr:')) {
        return identifier;
    }
    if (identifier.includes('/') || identifier.includes('*')) {
         return `cidr:${identifier}`;
    }
    if (identifier.includes('.')) {
        return `ip:${identifier}`;
    }
    return `user:${identifier.replace(/[^a-zA-Z0-9:]/g, '')}`; 
}

// --- Adaptive Policy Mechanisms ---

async function checkMemoryPressure(client, span) {
    try {
        const info = await client.info('memory');
        const usedMemoryMatch = info.match(/used_memory:(\d+)/);
        const usedMemory = usedMemoryMatch ? parseInt(usedMemoryMatch[1]) : 0;
        const thresholdBytes = configCache.MEMORY_PRESSURE_THRESHOLD_GB * 1024 * 1024 * 1024;
        
        span.setAttributes({ 
            'redis.memory.used_gb': (usedMemory/1e9).toFixed(2),
            'redis.memory.threshold_gb': configCache.MEMORY_PRESSURE_THRESHOLD_GB 
        });

        if (usedMemory > thresholdBytes) {
            logger.warn('REDIS_MEMORY_PRESSURE_DETECTED', { usedMemoryGB: (usedMemory/1e9).toFixed(2) });
            
            AuditLogger.log({
                level: AuditLogger.LEVELS.RISK,
                event: 'REDIS_MEMORY_PRESSURE_DETECTED',
                userId: 'SYSTEM_AUTONOMOUS',
                details: { usedMemory, threshold: thresholdBytes, action: 'ADAPTIVE_TTL_ACTIVATED' }
            });
            span.addEvent("memory_pressure_active");
            return true;
        }
    } catch (e) {
        logger.error("REDIS_INTROSPECTION_FAILED", { error: e.message });
    }
    return false;
}

function enforceAdaptiveExpirationPolicy(key, ttlSeconds, isUnderPressure) {
    const maxTtlSeconds = configCache.KEY_EXPIRY_THRESHOLD_DAYS * 86400;
    if (EXEMPT_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) return ttlSeconds; 

    let effectiveMaxTtl = maxTtlSeconds;
    if (isUnderPressure) effectiveMaxTtl *= configCache.ADAPTIVE_TTL_REDUCTION_FACTOR;
    
    if (!ttlSeconds || ttlSeconds <= 0 || ttlSeconds > effectiveMaxTtl) {
        metrics.increment('policy_violation_corrected_total', 1, { reason: isUnderPressure ? 'adaptive' : 'max_ttl' });
        return effectiveMaxTtl;
    }
    return ttlSeconds; 
}

function calculatePredictiveBlockingScore(keyDetail) {
    if (!keyDetail || !keyDetail.value || keyDetail.type !== 'string') return 0;
    const value = parseInt(keyDetail.value);
    const ttl = keyDetail.ttl;
    if (isNaN(value) || value <= 1) return 0;

    const countRatio = Math.min(value / configCache.MAX_RATE_LIMIT_SCORE_BASE, 1);
    const ttlRatio = (ttl === -1 || ttl <= 0) ? 1 : Math.min(ttl / (configCache.KEY_EXPIRY_THRESHOLD_DAYS * 86400), 1); 
    
    let score = (countRatio * 0.7) + (ttlRatio * 0.3);
    const finalScore = Math.max(0, Math.min(100, Math.floor(score * 100)));
    
    metrics.gauge('key_predictive_score', finalScore, { key_type: keyDetail.key.split(':')[0] });
    return finalScore;
}

// --- Data Retrieval ---

async function getKeysDetails(client, keys) {
    if (keys.length === 0) return [];
    return Tracing.withSpan('Redis:getBatchDetails', async (span) => {
        const pipeline = client.pipeline();
        keys.forEach(k => { pipeline.get(k); pipeline.ttl(k); pipeline.type(k); });
        const results = await pipeline.exec();
        
        return keys.map((key, i) => {
            const [gErr, value] = results[i * 3];
            const [tErr, ttl] = results[i * 3 + 1];
            const [yErr, type] = results[i * 3 + 2];
            return {
                key,
                value: gErr ? '[ERR]' : value,
                ttl: tErr ? -3 : ttl,
                type: yErr ? 'unknown' : type,
                isExpired: (tErr || ttl < 0)
            };
        });
    });
}

// --- Public Service Functions ---

async function scanAndDetailKeys(type, cursor, pageSize) {
    return Tracing.withSpan(`Admin:scanKeys:${type}`, async (span) => {
        const client = cacheConnection;
        const isUnderPressure = await checkMemoryPressure(client, span);
        const haStatus = await querySentinelStatus(configCache.DEFAULT_MASTER_NAME); 
        
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', type === 'all' ? '*' : 'rl:*', 'COUNT', 100);
        const detailedResults = await getKeysDetails(client, keys.slice(0, pageSize));
        
        const enhancedResults = detailedResults.map(d => ({
            ...d,
            predictiveScore: calculatePredictiveBlockingScore(d)
        }));

        return { 
            nextCursor,
            keys: enhancedResults, 
            haStatus,
            dynamicConfig: { 
                memoryPressureActive: isUnderPressure,
                adaptiveFactor: configCache.ADAPTIVE_TTL_REDUCTION_FACTOR 
            }
        };
    });
}

async function deleteKeysBatch(keys, auditReason, auditUser, auditContext) {
    return Tracing.withSpan('Admin:deleteKeysBatch', async (span) => {
        if (!keys?.length || !auditReason || !auditUser) throw new DomainError('Missing params', 400);

        const client = cacheConnection;
        await checkWriteAccess(client);

        const deletedCount = await client.eval(BATCH_DELETE_LUA_SCRIPT, keys.length, ...keys);

        AuditLogger.log({
            level: AuditLogger.LEVELS.SECURITY,
            event: 'ADMIN_KEYS_BATCH_DELETED',
            userId: auditUser,
            details: { deletedCount, totalKeys: keys.length, reason: auditReason, ...auditContext }
        });

        return deletedCount;
    });
}

async function blockEntity(identifier, reason, auditUser, auditContext) { 
    return Tracing.withSpan('Admin:blockEntity', async (span) => {
        if (!identifier || !reason || !auditUser) throw new DomainError('Missing params', 400);
        
        const normalizedId = normalizeKeyIdentifier(identifier); 
        const key = `${BLOCKED_KEY_PREFIX}${normalizedId}`;
        const client = cacheConnection;
        await checkWriteAccess(client); 
        
        const isUnderPressure = await checkMemoryPressure(client, span);
        const finalTtl = enforceAdaptiveExpirationPolicy(key, configCache.BLOCK_TTL_SECONDS, isUnderPressure);

        if (reason.toLowerCase().includes(PERMANENT_BAN_REASON.toLowerCase())) {
            const auditKey = `blocked_review:${normalizedId}`;
            await client.set(auditKey, JSON.stringify({ key, reason, ttl: finalTtl }), 'EX', BLOCK_REVIEW_TTL_SECONDS); 
        }

        await client.set(key, reason, 'EX', finalTtl); 
        
        AuditLogger.log({
            level: AuditLogger.LEVELS.RISK,
            event: 'ENTITY_EXPLICITLY_BLOCKED',
            userId: auditUser,
            details: { key, reason, durationDays: (finalTtl / 86400).toFixed(1), isMemoryAdjusted: isUnderPressure, ...auditContext }
        });
        
        return true;
    });
}

module.exports = { 
    scanAndDetailKeys,
    clearRateLimitKey: (key, user, context) => deleteKeysBatch([key], `Single delete: ${key}`, user, context),
    deleteKeysBatch, 
    blockEntity, 
    enforceAdaptiveExpirationPolicy,
    calculatePredictiveBlockingScore,
};