const asyncHandler = require("../middleware/asyncHandler");
const referralService = require("../services/referralService");

// --- PRODUCTION PLACEHOLDER UTILITIES ---
// Assume these are instantiated and connected to a robust queue system (e.g., Bull/Kafka/SQS)
const {
    enqueueReferralWebhook,
    getWebhookJobStatus,
    getWebhookJobHistory,
} = require("../utils/webhookReferralSender");

const {
    enqueuePayout,
    getPayoutJobStatus,
    cancelPayoutJob,
    getPayoutDisbursementHistory,
} = require("../utils/payoutQueueManager");

// --- PRODUCTION PLACEHOLDER SERVICES ---
// AuditService is critical for tracking admin actions
const AuditService = {
    /**
     * @param {string} adminId - ID of the admin performing the action.
     * @param {string} targetId - ID of the user/entity being affected. Use 'N/A' if no specific target user.
     * @param {string} action - Descriptive action key (e.g., 'BALANCE_ADJUSTMENT').
     * @param {object} details - Contextual data related to the action.
     */
    logUserAction: (adminId, targetId, action, details) => {
        // In a real app, this would be an async call to persist to MongoDB/Splunk/etc.
        // This ensures non-blocking audit logging.
        console.log(
            `[AUDIT] Admin ${adminId} | Action: ${action} | Target: ${targetId} | Details: ${JSON.stringify(details)}`
        );
    },
};

// Custom errors
const { NotFoundError } = require("../errors/notFoundError");
const { BadRequestError } = require("../errors/bad-request-error");

/**
 * Controller class for Admin-level management of the Referral system.
 * This class handles all request validation (after middleware), service calls, and response formatting.
 */
class AdminReferralController {
    
    /**
     * ADMIN: GET /api/referrals/admin
     * Retrieves a paginated and filtered list of all referral records (the main ledger).
     */
    getAdminReferralList = asyncHandler(async (req, res) => {
        const query = {
            page: Number(req.query.page) || 1,
            limit: Number(req.query.limit) || 25,
            sortBy: req.query.sortBy || "totalEarned",
            sortOrder: req.query.sortOrder ? Number(req.query.sortOrder) : -1,
            // Enhanced filtering for production
            status: req.query.status, // e.g., 'active', 'deactivated'
            search: req.query.search, // e.g., referrer name/email/code
            startDate: req.query.startDate,
            endDate: req.query.endDate,
        };

        const result = await referralService.getAdminReferralList(query);

        return res.status(200).json({
            status: "success",
            pagination: {
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages,
                totalCount: result.totalCount,
            },
            data: result.data,
        });
    });

    /**
     * ADMIN: GET /api/referrals/admin/:userId
     * Retrieves a specific referral record by user ID.
     */
    adminGetReferralByUser = asyncHandler(async (req, res) => {
        const userId = req.params.userId;
        const doc = await referralService.getReferralForUser(userId);
        
        if (!doc) throw new NotFoundError(`Referral record for user ID ${userId} not found.`);
        
        return res.status(200).json({ status: "success", data: doc });
    });

    /**
     * ADMIN: GET /api/referrals/admin/:userId/referred
     * Retrieves a paginated list of users referred by a specific user, with filters.
     */
    adminGetReferredUsers = asyncHandler(async (req, res) => {
        const referrerId = req.params.userId;
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 25;
        const status = req.query.status; // e.g., 'pending', 'converted', 'fraudulent'

        const result = await referralService.getReferredUsersList(referrerId, { page, limit, status });

        return res.status(200).json({
            status: "success",
            pagination: {
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages,
                totalCount: result.totalCount,
            },
            data: result.data,
        });
    });

    /**
     * ADMIN: GET /api/referrals/admin/commissions
     * Retrieves a paginated list of all commission credit transactions (ledger), with filters.
     */
    adminGetCommissionHistory = asyncHandler(async (req, res) => {
        const query = {
            page: Number(req.query.page) || 1,
            limit: Number(req.query.limit) || 25,
            sortBy: req.query.sortBy || "createdAt",
            sortOrder: req.query.sortOrder ? Number(req.query.sortOrder) : -1,
            userId: req.query.userId, // Filter by specific user
            status: req.query.status, // e.g., 'pending', 'confirmed'
            eventType: req.query.eventType, // e.g., 'purchase', 'signup_bonus', 'adjustment'
        };

        const result = await referralService.getCommissionHistoryList(query);
        
        return res.status(200).json({
            status: "success",
            pagination: {
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages,
                totalCount: result.totalCount,
            },
            data: result.data,
        });
    });

    /**
     * ADMIN: GET /api/referrals/admin/payouts
     * Retrieves a paginated list of all actual payout disbursement transactions.
     * This tracks the money *leaving* the system (vs. commissions earned).
     */
    adminGetPayoutDisbursementHistory = asyncHandler(async (req, res) => {
        const query = {
            page: Number(req.query.page) || 1,
            limit: Number(req.query.limit) || 25,
            userId: req.query.userId,
            status: req.query.status, // e.g., 'processing', 'completed', 'failed', 'cancelled'
            provider: req.query.provider, // e.g., 'stripe', 'paypal'
        };
        
        // This utility abstracts the lookup of transaction records (e.g., from a separate Payout Ledger DB)
        const result = await getPayoutDisbursementHistory(query);
        
        return res.status(200).json({
            status: "success",
            pagination: {
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages,
                totalCount: result.totalCount,
            },
            data: result.data,
        });
    });

    /**
     * ADMIN: POST /api/referrals/admin/deactivate
     * Deactivates a referral code by code string, preventing future use.
     * Body: { code } - Validation handled by middleware.
     */
    adminDeactivateReferralCode = asyncHandler(async (req, res) => {
        const { code } = req.body;
        const adminId = req.user.id; // CRITICAL: Identify the admin taking the action

        const doc = await referralService.deactivateReferralCode(code, adminId); // Pass adminId for service-level logging

        // Audit Logging of sensitive action
        await AuditService.logUserAction(adminId, doc.user.toString(), 'REFERRAL_CODE_DEACTIVATED', { code, userEmail: doc.userEmail });

        return res.status(200).json({
            status: "success",
            message: `Referral code ${code} deactivated.`,
            data: { code: doc.code, userId: doc.user },
        });
    });
    
    /**
     * ADMIN: POST /api/referrals/admin/reactivate
     * Reactivates a referral code by code string.
     * Body: { code }
     */
    adminReactivateReferralCode = asyncHandler(async (req, res) => {
        const { code } = req.body;
        const adminId = req.user.id; 

        const doc = await referralService.reactivateReferralCode(code, adminId); 

        // Audit Logging of sensitive action
        await AuditService.logUserAction(adminId, doc.user.toString(), 'REFERRAL_CODE_REACTIVATED', { code, userEmail: doc.userEmail });

        return res.status(200).json({
            status: "success",
            message: `Referral code ${code} reactivated.`,
            data: { code: doc.code, userId: doc.user },
        });
    });

    /**
     * ADMIN: PATCH /api/referrals/admin/:userId/config
     * Manually updates a user's referral configuration (e.g., custom rate override).
     * Body: { newCode?, commissionRateOverride?, status? }
     */
    adminUpdateReferralConfig = asyncHandler(async (req, res) => {
        const { userId } = req.params;
        const updateFields = req.body; // e.g., { commissionRateOverride: 0.15 }
        const adminId = req.user.id;

        if (Object.keys(updateFields).length === 0) {
             throw new BadRequestError("No fields provided for update.");
        }

        const newDoc = await referralService.updateReferralConfig(userId, updateFields, adminId);
        
        // Audit Logging of sensitive change
        await AuditService.logUserAction(adminId, userId, 'REFERRAL_CONFIG_UPDATE', { updateFields, newConfig: newDoc.config });

        return res.status(200).json({
            status: 'success',
            message: `Referral configuration updated for user ${userId}.`,
            data: newDoc,
        });
    });

    /**
     * ADMIN: PATCH /api/referrals/admin/:userId/adjust-balance
     * Manually adjusts a user's referral balance (e.g., for error correction).
     * Body: { amount: number, reason: string }
     */
    adminAdjustBalance = asyncHandler(async (req, res) => {
        const { userId } = req.params;
        const { amount, reason } = req.body;
        const adminId = req.user.id;

        // The service handles creating the ledger entry and updating the balance.
        const newDoc = await referralService.adjustReferralBalance(userId, amount, reason, adminId);
        
        // Audit Logging of sensitive financial adjustment
        await AuditService.logUserAction(adminId, userId, 'BALANCE_ADJUSTMENT', { amount, reason, newBalance: newDoc.totalEarned });

        return res.status(200).json({
            status: 'success',
            message: `Referral balance adjusted by ${amount} for user ${userId}.`,
            data: newDoc,
        });
    });

    // === Admin Queue Management Endpoints (Financial/Webhooks) ===
    
    /**
     * ADMIN: POST /api/referrals/admin/:userId/payout
     * Force immediate payout (manual/adhoc) - enqueues payout job.
     * Body validation (amount, currency, reason, provider) handled by middleware.
     */
    adminEnqueuePayout = asyncHandler(async (req, res) => {
        const { userId } = req.params;
        const { amount, currency, reason, provider, providerAccountId, delay = 0 } = req.body;
        const adminId = req.user.id;

        const recipient = providerAccountId || `user:${userId}`;

        const job = await enqueuePayout({
            recipient,
            amount: Number(amount),
            reason,
            provider,
            providerAccountId,
            currency,
            delay: Number(delay),
            metadata: { adminId, source: 'manual_admin_trigger', userId } // Pass audit context to the job
        });

        // Audit Logging of sensitive action (Initiation)
        await AuditService.logUserAction(adminId, userId, 'PAYOUT_ENQUEUE', { amount, currency, jobDetails: { jobId: job.id, recipient } });

        // Use 202 Accepted for asynchronous processing
        return res.status(202).json({
            status: "accepted",
            message: "Payout request accepted and queued for processing.",
            data: { jobId: job.id, queueName: job.queue?.name },
        });
    });

    /**
     * ADMIN: GET /api/referrals/admin/jobs/payout/:jobId
     * Retrieves the current status of a specific payout job from the queue manager.
     */
    adminGetPayoutJobStatus = asyncHandler(async (req, res) => {
        const { jobId } = req.params;
        
        const status = await getPayoutJobStatus(jobId);

        if (!status) throw new NotFoundError(`Payout job ID ${jobId} not found in queue system.`);
        
        return res.status(200).json({
            status: "success",
            data: status, // Contains job status, progress, results, and error details
        });
    });
    
    /**
     * ADMIN: DELETE /api/referrals/admin/jobs/payout/:jobId
     * Attempts to cancel a pending or scheduled payout job.
     */
    adminCancelPayoutJob = asyncHandler(async (req, res) => {
        const { jobId } = req.params;
        const adminId = req.user.id;
        
        const result = await cancelPayoutJob(jobId, adminId);
        
        if (!result.cancelled) {
             throw new BadRequestError(result.message || `Cannot cancel job ID ${jobId}. It may already be completed or running.`);
        }
        
        await AuditService.logUserAction(adminId, 'N/A', 'PAYOUT_CANCELLED', { jobId });
        
        return res.status(200).json({
            status: "success",
            message: `Payout job ID ${jobId} has been successfully cancelled.`,
            data: { jobId, status: 'cancelled' },
        });
    });


    /**
     * ADMIN: POST /api/referrals/admin/webhook
     * Force send webhook for a specific referral event (manual trigger).
     */
    adminEnqueueWebhook = asyncHandler(async (req, res) => {
        const { webhookUrl, payload, keyId, eventType } = req.body;
        const adminId = req.user.id;

        let job;
        if (webhookUrl && payload && keyId) {
            // Target specific external partner webhook
            job = await enqueueReferralWebhook({ url: webhookUrl, payload, keyId, metadata: { adminId } });
        } else if (eventType && payload) {
            // Trigger an internal event for all subscribers of that event type
            job = await enqueueReferralWebhook(eventType, payload, { adminId });
        }
        else {
            throw new BadRequestError("Missing required webhook parameters (either webhookUrl/payload/keyId or eventType/payload).");
        }
        
        // Audit Logging
        await AuditService.logUserAction(adminId, 'N/A', 'WEBHOOK_ENQUEUE', { eventType: eventType || 'AdHoc', jobId: job.id });

        return res.status(202).json({
            status: 'accepted',
            message: job.message || `Webhook event accepted and queued for delivery.`,
            data: { jobId: job.id, queueName: job.queue?.name }
        });
    });

    /**
     * ADMIN: GET /api/referrals/admin/jobs/webhook/:jobId
     * Retrieves the current status of a specific webhook job from the queue manager.
     */
    adminGetWebhookJobStatus = asyncHandler(async (req, res) => {
        const { jobId } = req.params;
        
        const status = await getWebhookJobStatus(jobId);

        if (!status) throw new NotFoundError(`Webhook job ID ${jobId} not found in queue system.`);
        
        return res.status(200).json({
            status: "success",
            data: status, // Contains job status, attempts, results, and error details
        });
    });

    /**
     * ADMIN: GET /api/referrals/admin/jobs/webhook/:jobId/history
     * Retrieves the attempt history for a specific webhook job.
     */
    adminGetWebhookJobHistory = asyncHandler(async (req, res) => {
        const { jobId } = req.params;
        
        const history = await getWebhookJobHistory(jobId);

        if (!history) throw new NotFoundError(`Webhook job ID ${jobId} not found in queue system.`);
        
        return res.status(200).json({
            status: "success",
            data: history, // Contains log of all attempts, responses, and failures
        });
    });
}

// Export the instantiated class for use in Express routes
module.exports = new AdminReferralController();