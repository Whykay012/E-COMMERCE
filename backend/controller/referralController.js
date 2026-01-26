// controllers/referral.controller.js
// Combined & Optimized Production Referral Controller

const asyncHandler = require("../middleware/asyncHandler");
const referralService = require("../services/referralService");

// Utilities for queueing external jobs
const { enqueueReferralWebhook } = require("../utils/webhookQueueManager");
const { enqueuePayout } = require("../utils/payoutQueueManager");

// Custom errors (rethrow to global error handler for precise status codes)
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const ConflictError = require("../errors/conflictError");
const InternalServerError = require("../errors/internalServerError");
const ForbiddenError = require("../errors/forbiddenError"); // Added for explicit admin checks

class ReferralController {
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
* NOTE: Idempotency Key is correctly read from headers (Option 2 best practice).
* Body: { code, referredUserId }
* Header: X-Idempotency-Key
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
 // we should map it here. Assuming the service throws ConflictError if key already processed.
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
* Note: This is typically called by an internal service, but still requires auth/service key.
* Body: { orderRef, referredUserId? }
*/
creditOrderReferralCommission = asyncHandler(async (req, res) => {
 const { orderRef, referredUserId } = req.body;
 if (!orderRef) throw new BadRequestError("orderRef is required.");
 
 // We use referredUserId from the body if provided, otherwise assume the authenticated user (though usually it's an internal service token).
 const userToCredit = referredUserId || req.user?.id;
 if (!userToCredit) throw new BadRequestError("A user ID for crediting must be provided (referredUserId or via auth token).");

 const result = await referralService.creditOrderReferralCommission(orderRef, userToCredit);
 
 // Use 202 Accepted because this involves queueing a job to the worker (referralCommissionWorker)
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

// === Admin Endpoints ===

// Middleware check is omitted here, but required in the route definition!
_adminCheck = (req) => {
 if (!req.user || !req.user.isAdmin) {
   throw new ForbiddenError("Admin access required.");
 }
};

/**
* ADMIN: GET /api/referrals/admin
* Retrieves paginated list of all referral records. (Requires Admin Middleware)
*/
getAdminReferralList = asyncHandler(async (req, res) => {
 this._adminCheck(req);
 const page = Number(req.query.page) || 1;
 const limit = Number(req.query.limit) || 25;
 const sortBy = req.query.sortBy || "totalEarned";
 const sortOrder = req.query.sortOrder ? Number(req.query.sortOrder) : -1;

 const result = await referralService.getAdminReferralList({ page, limit, sortBy, sortOrder });
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
 this._adminCheck(req);
 const userId = req.params.userId;
 const doc = await referralService.getReferralForUser(userId);
 if (!doc) throw new NotFoundError("Referral record not found.");
 return res.status(200).json({ status: "success", data: doc });
});

/**
* ADMIN: GET /api/referrals/admin/:userId/referred
* Retrieves a paginated list of users referred by a specific user.
*/
adminGetReferredUsers = asyncHandler(async (req, res) => {
 this._adminCheck(req);
 const referrerId = req.params.userId;
 const page = Number(req.query.page) || 1;
 const limit = Number(req.query.limit) || 25;

 const result = await referralService.getReferredUsersList(referrerId, { page, limit });
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
* Retrieves a paginated list of all commission credit transactions (ledger).
*/
adminGetCommissionHistory = asyncHandler(async (req, res) => {
 this._adminCheck(req);
 const page = Number(req.query.page) || 1;
 const limit = Number(req.query.limit) || 25;
 const sortBy = req.query.sortBy || "createdAt";
 const sortOrder = req.query.sortOrder ? Number(req.query.sortOrder) : -1;

 const result = await referralService.getCommissionHistoryList({ page, limit, sortBy, sortOrder });
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
* Deactivates a referral code by code string.
* Body: { code }
*/
adminDeactivateReferralCode = asyncHandler(async (req, res) => {
 this._adminCheck(req);
 const { code } = req.body;
 if (!code) throw new BadRequestError("code is required.");

 const doc = await referralService.deactivateReferralCode(code);
 return res.status(200).json({
 status: "success",
 message: "Referral code deactivated.",
 data: { code: doc.code, userId: doc.user },
 });
});

// === Admin Queue Management Endpoints ===

/**
* ADMIN: POST /api/referrals/admin/:userId/payout
* Force immediate payout (manual/adhoc) - enqueues payout job.
*/
adminEnqueuePayout = asyncHandler(async (req, res) => {
 this._adminCheck(req);
 const { userId } = req.params;
 const { amount, currency, reason, provider, providerAccountId, delay = 0 } = req.body;

 if (typeof amount !== 'number' || !recipient || !currency || !reason || !provider) {
 throw new BadRequestError("amount, recipient,currency, reason and provider are required.");
 }

 // We normalize the recipient identifier for the payout system
 const recipient = providerAccountId || `user:${userId}`;

 const job = await enqueuePayout({
 recipient,
 amount: Number(amount),
 reason,
 provider,
 providerAccountId,
 currency,
 delay: Number(delay) || 0,
 });

 // Send an immediate 202 Accepted response. 
        // We tell the client the job is accepted and processing will happen shortly.
        console.log(`[Controller] Responding to client for Payout ID: ${payoutId}`);
 return res.status(202).json({
 status: "success",
 message: "Payout enqueued for processing.",
 payoutId: payoutId, // Return the unique ID for client tracking
 queueName: job.queue.name,
 jobId: job.id,
 data: { jobId: job.id, payoutId: job.id },
 });
});

/**
* ADMIN: POST /api/referrals/admin/webhook
* Force send webhook for a specific referral event (manual trigger).
*/
adminEnqueueWebhook = asyncHandler(async (req, res) => {
 this._adminCheck(req);
 const { webhookUrl, payload, keyId, eventType } = req.body;
 
 // We combine validation from both options
 if (!webhookUrl && (!eventType || !payload)) throw new BadRequestError("webhookUrl/keyId or eventType/payload are required.");
 
 // Use Option 1's signature for targeted webhook:
 if (webhookUrl && payload && keyId) {
  const job = await enqueueReferralWebhook({ url: webhookUrl, payload, keyId });
  return res.status(202).json({
   status: "success",
   message: "Targeted webhook enqueued.",
   data: { jobId: job.id },
  });
 }

 // Fallback/alternative using Option 2's structure (assuming enqueueReferralWebhook supports it):
 if (eventType && payload) {
  const result = await enqueueReferralWebhook(eventType, payload);
  return res.status(202).json({
   status: 'success',
   message: `Webhook event '${eventType}' accepted and queued for delivery.`,
   data: result
  });
 }
 
 throw new BadRequestError("Invalid webhook parameters provided.");
});
}

// Export the instantiated class for use in Express routes
module.exports = new ReferralController();