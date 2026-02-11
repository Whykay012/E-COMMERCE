"use strict";

/**
 * COSMOS HYPER-FABRIC: Unified Security & Rate Limit Management
 * -----------------------------------------------------------
 * This router combines automated predictive analytics with manual 
 * override capabilities (Block/Unblock) for the Redis Cluster.
 */

const express = require('express');
const router = express.Router();

// Controllers and Dashboard Services
const adminRateLimitController = require('../controller/adminRateLimitController');
const { getBlockedUsers } = require("../services/rateLimiter/rateLimiterDashboard");
const { getRedisClient } = require("../utils/redisClient");

// 💡 ACTIVATED: Authentication & Authorization
const { authenticate, authorizePermissions } = require('../middleware/authMiddleware'); 

// --- 1. ROUTER LEVEL MIDDLEWARE ---

// Protect the Admin Panel itself from being brute-forced
router.use(adminRateLimitController.adminRateLimitMiddleware()); 

// Ensure only authenticated Security Engineers/Admins can proceed
router.use(authenticate);
router.use(authorizePermissions(['admin', 'security_engineer']));

// =====================================================================
// 🌐 COMMAND & CONTROL: MANUAL OVERRIDES (Manual Block/Unblock)
// =====================================================================

/**
 * @route   GET /api/admin/ratelimit/security/blocked-users
 * @desc    Fetch real-time blocklist data for the dashboard
 */
router.get("/security/blocked-users", async (req, res) => {
    try {
        const data = await getBlockedUsers();
        res.status(200).json({
            status: "success",
            count: data.length,
            data
        });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

/**
 * @route   DELETE /api/admin/ratelimit/security/unblock/:identifier
 * @desc    Manually remove an identifier (IP/User) from the blocklist
 */
router.delete("/security/unblock/:identifier", async (req, res) => {
    try {
        const redis = getRedisClient();
        const { identifier } = req.params;
        
        // Remove the specific blocklist key
        await redis.del(`blocklist:${identifier}`);
        
        res.status(200).json({ 
            status: "success", 
            message: `Identifier ${identifier} unblocked successfully.` 
        });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

/**
 * @route   POST /api/admin/ratelimit/entity/block
 * @desc    Explicitly ban an IP or User ID for a custom duration
 */
router.post('/entity/block', adminRateLimitController.blockEntity);


// =====================================================================
// 🛰️ ANALYTICS & BATCH OPERATIONS (COSMOS Analytics)
// =====================================================================

// List all rate limit keys (live counters) with predictive scores
router.get('/keys', adminRateLimitController.listRateLimitKeys);

// Clear a specific rate limit counter (e.g., reset a user's attempt count)
router.delete('/keys/:key', adminRateLimitController.clearRateLimitKey);

// Atomic batch deletion for cluster cleanup
router.post('/keys/delete-batch', adminRateLimitController.deleteKeysBatch);


// =====================================================================
// 🧪 HYPER-FABRIC UTILITIES (Policy Testing)
// =====================================================================

// Test the Adaptive Expiration Policy logic
router.post('/policy/test-ttl-adjustment', adminRateLimitController.testAdaptivePolicy);

// Custom score calculation for audit logs
router.post('/policy/get-scores', adminRateLimitController.getPredictiveScores);


module.exports = router;