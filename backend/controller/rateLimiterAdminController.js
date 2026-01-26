// controllers/adminRateLimitController.js (Cosmos Hyper-Fabric - FINAL WITH UTILITIES)
// The complete controller for administrative rate limit management.
const rateLimitService = require("../services/adminRateLimitService"); 
const { DomainError } = require("../errors/customErrors"); 

// =================================================================================
// 🛡️ UTILITY FUNCTIONS: SECURITY & CONTEXT EXTRACTION
// =================================================================================

/**
 * @desc Retrieves the authenticated user ID from the request object.
 * @param {object} req - Express request object.
 * @returns {string} The authenticated user ID or a fallback constant.
 */
function getAuditUser(req) { 
    return req.auth?.sub || req.user?.id || 'SYSTEM_ADMIN_UNAUTH'; 
}

/**
 * @desc Captures the full security and transaction context for auditing.
 * @param {object} req - Express request object.
 * @returns {object} Detailed context for logging.
 */
function getAuditContext(req) { 
    return {
        // Essential security fields (Handling proxies X-Forwarded-For)
        clientIp: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
        
        // Enforce Transaction/Trace ID capture
        traceId: req.headers['x-request-id'] || req.headers['x-amzn-trace-id'] || `GEN_${Date.now()}`,
        correlationId: req.headers['x-correlation-id'] || null,
        
        source: 'AdminPanel',
        // Inject the rate limit status of the admin client itself
        adminRateLimitCurrent: req.rateLimitInfo ? req.rateLimitInfo.current : 0,
        adminRateLimitLimit: req.rateLimitInfo ? req.rateLimitInfo.limit : 0
    };
}

/**
 * @desc Parses the complex Redis INFO string into a usable object.
 * @param {string} infoString - The raw output of Redis INFO.
 * @returns {object} Simplified Redis metadata.
 */
function parseRedisInfo(infoString) {
    const lines = infoString.split('\r\n');
    const result = {};
    for (const line of lines) {
        if (line && !line.startsWith('#')) {
            const [key, value] = line.split(':');
            if (key && value) {
                // Focus on key metrics
                if (['role', 'used_memory_human', 'total_system_memory_human', 'master_link_status', 'connected_clients'].includes(key)) {
                    result[key] = value;
                }
            }
        }
    }
    return result;
}

// --- Middleware (Basic In-Memory Admin Rate Limit) ---
const adminRateLimitMiddleware = (limit = 20, windowMs = 30000) => { 
    const inMemoryStore = new Map(); 
    return (req, res, next) => {
        const clientIp = req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress;
        const now = Date.now();
        const clientData = inMemoryStore.get(clientIp) || { count: 0, lastReset: now };
        if (now - clientData.lastReset > windowMs) {
            clientData.count = 0; clientData.lastReset = now;
        }
        clientData.count += 1;
        req.rateLimitInfo = { current: clientData.count, limit, window: windowMs };
        if (clientData.count > limit) {
            return res.status(429).json({ status: "error", message: `Admin API rate limit exceeded.`, code: 'ADMIN_RATE_LIMIT_EXCEEDED' });
        }
        inMemoryStore.set(clientIp, clientData);
        next();
    };
};
// --- END UTILITY FUNCTIONS ---


// =================================================================================
// 🌐 1. PAGINATED LISTING ENDPOINT (GET /keys)
// =================================================================================
async function listRateLimitKeys(req, res, next) {
    try {
        let { cursor = '0', pageSize, type = 'all', masterName } = req.query;
        if (pageSize && (isNaN(parseInt(pageSize)) || parseInt(pageSize) < 1 || parseInt(pageSize) > 500)) {
            throw new DomainError('Invalid pageSize. Must be a number between 1 and 500.', 400, 'INVALID_PAGESIZE');
        }
        
        // Fetch keys, Redis metadata, HA status, and dynamic configuration from the service
        const { nextCursor, keys, redisInfo, haStatus, dynamicConfig } = 
            await rateLimitService.scanAndDetailKeys(type, cursor, pageSize, masterName);
            
        const parsedRedisInfo = parseRedisInfo(redisInfo);

        res.json({ 
            status: "success", 
            metadata: {
                redis: parsedRedisInfo, haStatus: haStatus, nextCursor, requestedType: type,
                dynamicConfig: dynamicConfig, adminRateLimit: req.rateLimitInfo,
            },
            results: keys.length, data: keys,
        });
        
    } catch (err) {
        // All errors flow to the centralized error handler middleware
        next(err);
    }
}

// =================================================================================
// 👑 2. REMEDIATION ENDPOINT (DELETE /keys/:key)
// =================================================================================
async function clearRateLimitKey(req, res, next) {
    try {
        const { key } = req.params;
        const auditUser = getAuditUser(req); 
        const auditContext = getAuditContext(req); 
        
        if (!key || key.length === 0) {
            throw new DomainError('Rate limit key is required.', 400, 'MISSING_KEY_PARAM');
        }

        // The service layer handles the deletion and auditing
        const deletedCount = await rateLimitService.clearRateLimitKey(key, auditUser, auditContext);

        if (deletedCount === 0) {
            return res.status(404).json({ status: "failure", message: `Key '${key}' not found or already expired.`, code: 'KEY_NOT_FOUND' });
        }

        res.json({ status: "success", message: `Key '${key}' successfully deleted.`, deletedCount });

    } catch (err) {
        next(err);
    }
}

// =================================================================================
// 🚀 3. BATCH DELETION ENDPOINT (POST /keys/delete-batch)
// =================================================================================
async function deleteKeysBatch(req, res, next) {
    try {
        const { keys, auditReason } = req.body;
        const auditUser = getAuditUser(req);
        const auditContext = getAuditContext(req); 

        if (!Array.isArray(keys) || keys.length === 0 || !auditReason) {
             throw new DomainError('Payload must contain an array of keys and an auditable reason.', 400, 'INVALID_BATCH_PAYLOAD');
        }

        const deletedCount = await rateLimitService.deleteKeysBatch(keys, auditReason, auditUser, auditContext);

        res.json({
            status: "success",
            message: `Successfully processed atomic batch delete. ${deletedCount} out of ${keys.length} keys were deleted.`,
            deletedCount,
            totalRequested: keys.length,
        });

    } catch (err) {
        next(err);
    }
}

// =================================================================================
// 🧱 4. BLOCKING ENDPOINT (POST /entity/block)
// =================================================================================
async function blockEntity(req, res, next) {
    try {
        const { identifier, reason = 'Administrative Ban' } = req.body;
        const auditUser = getAuditUser(req); 
        const auditContext = getAuditContext(req);

        if (!identifier) {
            throw new DomainError('Identifier (IP or User ID) is required for blocking.', 400, 'MISSING_BLOCK_ID');
        }

        const success = await rateLimitService.blockEntity(identifier, reason, auditUser, auditContext);

        res.json({
            status: "success",
            message: `Entity '${identifier}' successfully blocked. Policy adherence enforced.`,
            success,
        });

    } catch (err) {
        next(err);
    }
}


// =================================================================================
// 💡 5. NEW ENDPOINT: Test Adaptive Expiration Policy (UTILITY)
// =================================================================================
async function testAdaptivePolicy(req, res, next) {
    try {
        const { key, requestedTtl, isUnderPressure = false } = req.body;
        
        if (!key || requestedTtl === undefined) {
            throw new DomainError('Key and requestedTtl are required for policy simulation.', 400, 'MISSING_POLICY_PARAMS');
        }

        // Direct call to the service utility for policy testing
        const finalTtl = rateLimitService.enforceAdaptiveExpirationPolicy(
            key, 
            requestedTtl, 
            isUnderPressure
        );

        res.json({
            status: "success",
            message: "TTL adjustment simulated successfully.",
            simulation: {
                requestedTtl,
                isUnderPressure,
                finalTtl,
                // Provide a factor for quick assessment of the adjustment
                adjustmentFactor: finalTtl / requestedTtl,
                policyAdherence: finalTtl === requestedTtl
            }
        });

    } catch (err) {
        next(err);
    }
}

// =================================================================================
// 💡 6. NEW ENDPOINT: Get Predictive Blocking Scores (UTILITY)
// =================================================================================
async function getPredictiveScores(req, res, next) {
    try {
        const { keys } = req.body;
        
        if (!Array.isArray(keys) || keys.length === 0) {
            throw new DomainError('An array of key details is required for scoring.', 400, 'MISSING_SCORING_INPUT');
        }

        // Direct call to the service utility for score calculation
        const scoredResults = keys.map(keyDetail => {
            if (!keyDetail.key || !keyDetail.value || !keyDetail.type) {
                return { key: 'INVALID_KEY', predictiveScore: 0, reason: 'Incomplete key detail structure.' };
            }
            
            const score = rateLimitService.calculatePredictiveBlockingScore(keyDetail);
            
            return {
                key: keyDetail.key,
                value: keyDetail.value,
                predictiveScore: score,
                // Assign an automated recommended action based on the score
                action: score > 75 ? 'ALERT_REVIEW' : score > 50 ? 'WARN_MONITOR' : 'OK'
            };
        });
        
        res.json({
            status: "success",
            message: `Scored ${keys.length} keys based on current policies.`,
            results: scoredResults,
        });

    } catch (err) {
        next(err);
    }
}


// =================================================================================
// MODULE EXPORTS
// =================================================================================
module.exports = { 
    // Core Endpoints
    listRateLimitKeys,
    clearRateLimitKey,
    deleteKeysBatch, 
    blockEntity,
    
    // Utility Endpoints
    testAdaptivePolicy,
    getPredictiveScores,
    
    // Middleware
    adminRateLimitMiddleware,
};