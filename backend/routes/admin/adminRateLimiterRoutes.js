// routes/adminRateLimitRoutes.js (COSMOS HYPER-FABRIC - FULLY ACTIVATED SECURITY)
// Defines the secured routes for the administrative rate limit management API.

const express = require('express');
const router = express.Router();

const adminRateLimitController = require('../controller/adminRateLimitController');
// 💡 ACTIVATED: Import the new middleware structure
const { authenticate, authorizePermissions } = require('../middleware/authMiddleware'); 

// --- ROUTER LEVEL MIDDLEWARE ---

// Apply administrative rate limiting to all routes in this router
router.use(adminRateLimitController.adminRateLimitMiddleware()); 

// 💡 ACTIVATED: Apply authentication to secure all routes
router.use(authenticate);

// 💡 ACTIVATED: Apply high-level authorization (only 'admin' and 'security_engineer' can access)
const restrictToAdmin = authorizePermissions(['admin', 'security_engineer']);
router.use(restrictToAdmin); 


// =====================================================================
// 🌐 CORE ADMINISTRATIVE ENDPOINTS (Fully Protected)
// =====================================================================

// 1. GET /keys - List all rate limit keys with status and predictive score
router.get('/keys', adminRateLimitController.listRateLimitKeys);

// 2. DELETE /keys/:key - Clear a single rate limit key
router.delete('/keys/:key', adminRateLimitController.clearRateLimitKey);

// 3. POST /keys/delete-batch - Delete multiple keys in a single atomic transaction
router.post('/keys/delete-batch', adminRateLimitController.deleteKeysBatch);

// 4. POST /entity/block - Explicitly block an IP or User ID for a long duration
router.post('/entity/block', adminRateLimitController.blockEntity);


// =====================================================================
// 💡 COSMOS HYPER-FABRIC UTILITY ENDPOINTS (Protected by same rules)
// =====================================================================

// 5. POST /policy/test-ttl-adjustment - Test the Adaptive Expiration Policy
router.post('/policy/test-ttl-adjustment', adminRateLimitController.testAdaptivePolicy);

// 6. POST /policy/get-scores - Calculate the Predictive Blocking Score for custom key sets
router.post('/policy/get-scores', adminRateLimitController.getPredictiveScores);


module.exports = router;