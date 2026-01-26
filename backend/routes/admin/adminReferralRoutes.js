const express = require('express');
const router = express.Router();

// --- CORE MIDDLEWARE IMPORTS ---
const { authenticate, adminOnly } = require('../../middleware/authMiddleware');
const { validate } = require('../../valiidators/validation'); // Joi validation middleware
const { globalLimiter } = require('../../middleware/rateLimiter'); // Global IP Rate Limiter

// --- VALIDATION SCHEMA IMPORTS ---
const { 
    referralListQuerySchema, 
    deactivateCodeSchema,
    reactivateCodeSchema, // <--- Added: Required for reactivate
    updateConfigSchema,   // <--- Added: Required for config update
    payoutEnqueueSchema,
    webhookEnqueueSchema,
    adjustBalanceSchema,
    jobIdParamSchema,
    IdParamSchema
} = require('../../validators/referralValidators'); // Ensures all required schemas from the updated file are imported

// --- CONTROLLER IMPORTS ---
const AdminReferralController = require('../../controller/adminReferralController');


// Apply common security middleware for all referral admin routes
// NOTE: adminOnly middleware replaces the redundant _adminCheck() in the controller.
router.use(authenticate, adminOnly, globalLimiter);


/* ===========================================================
 * LISTING, DETAILS & HISTORY
 * =========================================================== */

/**
 * GET /api/referrals/admin
 * Retrieves a paginated and filtered list of all referral records.
 */
router.get(
    '/', 
    validate(referralListQuerySchema, 'query'),
    AdminReferralController.getAdminReferralList
);

/**
 * GET /api/referrals/admin/:userId
 * Retrieves a specific referral record for a user.
 */
router.get(
    '/:userId', 
    validate(IdParamSchema, 'params'),
    AdminReferralController.adminGetReferralByUser
);

/**
 * GET /api/referrals/admin/:userId/referred
 * Retrieves a paginated list of users referred by a specific user.
 */
router.get(
    '/:userId/referred', 
    validate(IdParamSchema, 'params'),
    AdminReferralController.adminGetReferredUsers
);

/**
 * GET /api/referrals/admin/commissions
 * Retrieves a paginated list of all commission credit transactions (ledger).
 */
router.get(
    '/commissions', 
    validate(referralListQuerySchema, 'query'), // Reuse/adapt list schema for history
    AdminReferralController.adminGetCommissionHistory
);

/**
 * GET /api/referrals/admin/payouts
 * Retrieves a paginated list of all actual payout disbursement transactions (ledger).
 */
router.get(
    '/payouts', 
    validate(referralListQuerySchema, 'query'), // Reuse/adapt list schema for history
    AdminReferralController.adminGetPayoutDisbursementHistory
);


/* ===========================================================
 * ADMINISTRATIVE ACTIONS
 * =========================================================== */

/**
 * POST /api/referrals/admin/deactivate
 * Deactivates a referral code by code string (Soft Deactivation).
 */
router.post(
    '/deactivate', 
    validate(deactivateCodeSchema, 'body'),
    AdminReferralController.adminDeactivateReferralCode
);

/**
 * POST /api/referrals/admin/reactivate
 * Reactivates a referral code by code string.
 */
router.post(
    '/reactivate', 
    validate(reactivateCodeSchema, 'body'), // <--- New Route
    AdminReferralController.adminReactivateReferralCode
);

/**
 * PATCH /api/referrals/admin/:userId/config
 * Manually updates a user's referral configuration (e.g., custom rate override).
 */
router.patch(
    '/:userId/config',
    validate(IdParamSchema, 'params'),
    validate(updateConfigSchema, 'body'), // <--- New Route
    AdminReferralController.adminUpdateReferralConfig
);

/**
 * PATCH /api/referrals/admin/:userId/adjust-balance
 * Manually adjusts a user's total referral balance for audit purposes.
 */
router.patch(
    '/:userId/adjust-balance',
    validate(IdParamSchema, 'params'),
    validate(adjustBalanceSchema, 'body'),
    AdminReferralController.adminAdjustBalance
);


/* ===========================================================
 * QUEUE MANAGEMENT & STATUS (CRITICAL FOR SCALE)
 * =========================================================== */

// --- PAYOUT JOBS ---

/**
 * POST /api/referrals/admin/:userId/payout
 * Force immediate payout (manual/adhoc) - enqueues payout job. Returns 202 Accepted.
 */
router.post(
    '/:userId/payout',
    validate(IdParamSchema, 'params'),
    validate(payoutEnqueueSchema, 'body'),
    AdminReferralController.adminEnqueuePayout
);

/**
 * GET /api/referrals/admin/jobs/payout/:jobId
 * Retrieves the status of a specific payout job.
 */
router.get(
    '/jobs/payout/:jobId',
    validate(jobIdParamSchema, 'params'),
    AdminReferralController.adminGetPayoutJobStatus
);

/**
 * DELETE /api/referrals/admin/jobs/payout/:jobId
 * Attempts to cancel a pending or scheduled payout job.
 */
router.delete(
    '/jobs/payout/:jobId',
    validate(jobIdParamSchema, 'params'), // <--- New Route
    AdminReferralController.adminCancelPayoutJob
);

/**
 * GET /api/referrals/admin/jobs/payout/history
 * Retrieves a paginated list of all payout jobs (active, waiting, completed, failed) from the queue.
 */
router.get(
    '/jobs/payout/history',
    validate(referralListQuerySchema, 'query'), // <--- New Route
    AdminReferralController.adminGetPayoutQueueHistory
);

// --- WEBHOOK JOBS ---

/**
 * POST /api/referrals/admin/webhook
 * Force send webhook for a specific referral event (manual trigger). Returns 202 Accepted.
 */
router.post(
    '/webhook',
    validate(webhookEnqueueSchema, 'body'),
    AdminReferralController.adminEnqueueWebhook
);

/**
 * GET /api/referrals/admin/jobs/webhook/:jobId
 * Retrieves the status of a specific webhook job.
 */
router.get(
    '/jobs/webhook/:jobId',
    validate(jobIdParamSchema, 'params'),
    AdminReferralController.adminGetWebhookJobStatus
);

/**
 * GET /api/referrals/admin/jobs/webhook/history
 * Retrieves a paginated list of all webhook jobs (active, waiting, completed, failed) from the queue.
 */
router.get(
    '/jobs/webhook/history',
    validate(referralListQuerySchema, 'query'), // <--- New Route
    AdminReferralController.adminGetWebhookQueueHistory
);

/**
 * GET /api/referrals/admin/jobs/webhook/:jobId/history
 * Retrieves the attempt history for a specific webhook job.
 */
router.get(
    '/jobs/webhook/:jobId/history',
    validate(jobIdParamSchema, 'params'), // <--- New Route
    AdminReferralController.adminGetWebhookJobHistory
);


/* ===========================================================
 * EXPORTS
 * =========================================================== */
module.exports = router;