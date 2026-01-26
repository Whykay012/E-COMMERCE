// controllers/user.referral.controller.js
// Handles all public, authenticated user, and core business logic endpoints.

const asyncHandler = require("../middleware/asyncHandler");
const referralService = require("../services/referralService");

// Custom errors
const BadRequestError = require("../errors/bad-request-error");
const ConflictError = require("../errors/conflictError");

class UserReferralController {
    // === User Endpoints ===

    /**
     * POST /api/referrals/generate
     * Generates a referral code for the authenticated user (201 Created).
     */
    createReferralForUser = asyncHandler(async (req, res) => {
        const userId = req.user?.id;
        if (!userId) throw new BadRequestError("Authentication required.");

        const doc = await referralService.generateReferralForUser(userId);
        return res.status(201).json({
            status: "success",
            message: "Referral code generated or retrieved.",
            data: doc,
        });
    });

    /**
     * GET /api/referrals/me
     * Retrieves the authenticated user's referral info (204 No Content if not found).
     */
    getMyReferral = asyncHandler(async (req, res) => {
        const userId = req.user?.id;
        if (!userId) throw new BadRequestError("Authentication required.");

        const doc = await referralService.getReferralForUser(userId);
        // Use 204 No Content for a successful lookup that yields no data
        if (!doc) return res.status(204).json({ status: "success", data: null });

        return res.status(200).json({
            status: "success",
            data: doc,
        });
    });

    /**
     * POST /api/referrals/validate
     * Validates the existence and active status of a referral code.
     */
    validateReferralCode = asyncHandler(async (req, res) => {
        const { code } = req.body;
        if (!code) throw new BadRequestError("Referral code is required.");

        const doc = await referralService.validateReferralCode(code);
        // Note: The service layer should throw NotFoundError if the code is invalid/inactive.
        return res.status(200).json({
            status: "success",
            data: {
                code: doc.code,
                referrerUserId: doc.user,
                isActive: !!doc.isActive,
            },
        });
    });

    /**
     * PATCH /api/referrals/code
     * Allows authenticated user to set/update a custom referral code.
     */
    updateReferralCode = asyncHandler(async (req, res) => {
        const userId = req.user?.id;
        const { newCode } = req.body;
        if (!userId) throw new BadRequestError("Authentication required.");
        if (!newCode) throw new BadRequestError("newCode is required.");

        const result = await referralService.updateReferralCode(userId, newCode);
        return res.status(200).json({
            status: "success",
            message: "Custom referral code updated.",
            data: result,
        });
    });

    // === Core Business Logic Endpoints ===

    /**
     * POST /api/referrals/signup
     * Link a newly registered user to the referrer using the code.
     * Body: { code, referredUserId }
     */
    processNewReferralSignup = asyncHandler(async (req, res) => {
        const { code, referredUserId } = req.body;
        const idempotencyKey = req.headers['x-idempotency-key'];

        if (!code) throw new BadRequestError("Referral code is required in body.");
        if (!referredUserId) throw new BadRequestError("Referred user ID is required in body.");
        if (!idempotencyKey) throw new BadRequestError("X-Idempotency-Key header is required.");

        // The service handles the idempotency check and concurrency lock
        const result = await referralService.processNewReferralSignup(code, referredUserId, idempotencyKey);

        // If the service returns a specific status code for a conflict (e.g., 409 Conflict),
        if (result.status === 409) {
            throw new ConflictError(result.message);
        }

        // Use status 201 for initial creation, or the service-returned status for idempotent responses
        return res.status(result.status || 201).json({
            status: "success",
            message: result.message,
            data: result.data || null,
        });
    });

    /**
     * POST /api/referrals/record
     * Record referral commission for an order/transaction.
     * Body: { orderRef, referredUserId? }
     */
    creditOrderReferralCommission = asyncHandler(async (req, res) => {
        const { orderRef, referredUserId } = req.body;
        if (!orderRef) throw new BadRequestError("orderRef is required.");

        // We use referredUserId from the body if provided, otherwise assume the authenticated user (internal service token).
        const userToCredit = referredUserId || req.user?.id;
        if (!userToCredit) throw new BadRequestError("A user ID for crediting must be provided (referredUserId or via auth token).");

        const result = await referralService.creditOrderReferralCommission(orderRef, userToCredit);

        // Use 202 Accepted because this involves queueing a job to the worker
        return res.status(result.status || 202).json({
            status: "success",
            message: result.message,
            data: {
                orderRef: result.orderRef,
                commission: result.commission,
                referrerUserId: result.referrerUserId,
            },
        });
    });
}

// Export the instantiated class for use in user-facing Express routes
module.exports = new UserReferralController();