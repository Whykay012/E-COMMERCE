// "use strict";

// const mongoose = require("mongoose");
// const crypto = require("crypto");
// const Redis = require("ioredis");

// // --- Models ---
// const Payment = require("../model/payment");
// const Order = require("../model/order");
// const User = require("../model/userModel");
// const WebhookLog = require("../model/webHookLog");
// const FraudLog = require("../model/FraudLog");

// // --- Utilities & Services ---
// const { generateOtp, verifyOtp } = require("../services/otpService");
// const {
//   evaluatePaymentRisk,
//   prometheusRegistry,
//   lockAcquisitionCounter,
// } = require("../services/risk/paymentRiskEngine");
// const GeoIPClient = require("./geoip/maxMindClient");

// // 💡 REAL DEPENDENCIES FOR RESILIENCE
// const CircuitBreaker = require("../utils/circuitBreaker");
// const { ConcurrencyLimiter } = require("../utils/concurrencyLimiter");

// const { queueJob, GENERAL_QUEUE_NAME } = require("../queue/jobQueue");
// const { InventoryService } = require("./inventoryService");
// const AuditLogger = require("./auditLogger");
// const { log: auditLog } = AuditLogger;

// const replayProtector = require("../utils/webhookReplayProtector");
// const preventReplay =
//   replayProtector.checkAndStoreFingerprint || replayProtector;

// // --- CRITICAL DEPENDENCIES FOR HIGH-VALUE CHECK ---
// const {
//   createBiometricClientService,
//   BiometricVerificationError,
// } = require("./biometricClientFactory");

// // 💡 Configuration Adapter (Maps BiometricConfig to general keys)
// const AppConfig = require("../config/appConfig");

// // --- Errors ---
// const BadRequestError = require("../errors/bad-request-error");
// const NotFoundError = require("../errors/notFoundError");
// const DomainError = require("../errors/domainError");
// const ConflictError = require("../errors/conflictError");
// const UnauthorizedError = require("../errors/unauthorizedError");
// const ExternalServiceError = require("../errors/externalServiceError");

// // --- Config & Clients ---
// const PaystackSDK = require("@paystack/paystack-sdk");
// // NOTE: Product model import removed as it wasn't used in the provided functions.
// const {
//   PAYSTACK_SECRET,
//   STRIPE_SECRET,
//   STRIPE_ENDPOINT_SECRET,
//   FLUTTERWAVE_SECRET,
// } = process.env;
// const paystack = new PaystackSDK(PAYSTACK_SECRET);

// const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// // -----------------------------------------------------------
// // 🚀 PRODUCTION GRADE: Biometric Client Initialization
// // -----------------------------------------------------------

// // 1. Instantiate Concrete Resilience Utilities using AppConfig
// const biometricLimiter = new ConcurrencyLimiter({
//   // Uses the mapped capacity from AppConfig (BiometricConfig.RATE_LIMIT_CAPACITY)
//   maxConcurrent: AppConfig.MAX_CONCURRENT_BIOMETRIC_CALLS || 25,
//   name: "BiometricLimiter",
// });

// const biometricBreaker = new CircuitBreaker(
//   async () => {
//     /* placeholder target for config */
//   },
//   {
//     // Uses the mapped timeouts and thresholds from AppConfig
//     timeout: AppConfig.BIOMETRIC_BREAKER_TIMEOUT_MS || 4000,
//     errorThreshold: AppConfig.BIOMETRIC_BREAKER_ERROR_THRESHOLD || 60,
//     resetTimeout: AppConfig.BIOMETRIC_BREAKER_RESET_MS || 30000,
//     name: "BiometricVerification",
//   },
// );

// // 2. Initialize the Biometric Client Service with Real Dependencies
// const biometricClientInstance = createBiometricClientService({
//   concurrencyLimiterInstance: biometricLimiter,
//   circuitBreakerInstance: biometricBreaker,
// });

// // -----------------------------------------------------------

// // -------------------------------
// // Signature Verification (ENTERPRISE)
// // -------------------------------
// function verifySignature(provider, rawBody, headers = {}) {
//   if (!rawBody) throw new Error("Raw body required");

//   switch (provider.toLowerCase()) {
//     case "paystack": {
//       const sig =
//         headers["x-paystack-signature"] || headers["X-Paystack-Signature"];
//       if (!PAYSTACK_SECRET) throw new Error("PAYSTACK_SECRET not configured");
//       const hash = crypto
//         .createHmac("sha512", PAYSTACK_SECRET)
//         .update(rawBody)
//         .digest("hex");
//       if (hash !== sig) throw new Error("Invalid Paystack signature");
//       return true;
//     }
//     case "stripe": {
//       const sig = headers["stripe-signature"] || headers["Stripe-Signature"];
//       if (!STRIPE_SECRET || !STRIPE_ENDPOINT_SECRET)
//         throw new Error("Stripe secrets not configured");
//       // Production verification logic omitted for brevity, but should use a secure library like stripe.webhooks.constructEvent
//       return true;
//     }
//     case "flutterwave": {
//       const sig = headers["verif-hash"] || headers["Verif-Hash"];
//       if (!FLUTTERWAVE_SECRET)
//         throw new Error("FLUTTERWAVE_SECRET not configured");
//       const hash = crypto
//         .createHmac("sha256", FLUTTERWAVE_SECRET)
//         .update(rawBody)
//         .digest("hex");
//       if (hash !== sig) throw new Error("Invalid Flutterwave signature");
//       return true;
//     }
//     default:
//       return true;
//   }
// }

// // -------------------------------
// // Helper Functions for Worker (Zenith Lock Management)
// // -------------------------------
// const releaseOrderLock = async (orderId, jobId) => {
//   try {
//     const result = await Order.updateOne(
//       { _id: orderId, lockToken: jobId },
//       { $set: { lockToken: null } },
//     );
//     if (result.modifiedCount > 0) {
//       // Using modifiedCount for Mongoose 5+
//       auditLog({
//         level: "INFO",
//         event: "ORDER_LOCK_RELEASED_FAILSAFE",
//         details: { orderId, jobId },
//       });
//     }
//   } catch (lockErr) {
//     auditLog({
//       level: "ERROR",
//       event: "ORDER_LOCK_RELEASE_FAILED",
//       details: { orderId, jobId, error: lockErr.message },
//     });
//   }
// };

// // -------------------------------
// // Transactional Worker Logic (SLOW PATH - ENTERPRISE WRITE CONCERN)
// // -------------------------------
// const executeAtomicOrderUpdate = async (data, context) => {
//   const { orderId, reference } = data; // Removed unused 'provider' and 'amount'
//   const session = await mongoose.startSession();

//   // 💡 Enterprise Write Concern: Ensure high consistency for critical money movement
//   session.startTransaction({
//     readConcern: { level: "majority" },
//     writeConcern: { w: "majority" },
//   });

//   let lockAcquired = false;

//   try {
//     // 1. 🔒 ORDER LOCK (Acquire lock)
//     const order = await Order.findOneAndUpdate(
//       { _id: orderId, lockToken: { $in: [null, context.jobId] } },
//       { $set: { lockToken: context.jobId } },
//       { new: true, session, runValidators: true },
//     ).session(session);

//     if (!order) {
//       const competingOrder = await Order.findOne({
//         _id: orderId,
//         lockToken: { $ne: context.jobId, $ne: null },
//       }).session(session);
//       await session.abortTransaction();

//       if (competingOrder) {
//         lockAcquisitionCounter.inc({ status: "conflict" });
//         auditLog({
//           level: "WARN",
//           event: "ORDER_LOCKED_CONFLICT",
//           details: { ...context, competingLock: competingOrder.lockToken },
//         });
//         throw new ConflictError(
//           `Order is currently locked by competing job: ${competingOrder.lockToken}`,
//         );
//       }

//       lockAcquisitionCounter.inc({ status: "not_found" });
//       throw new NotFoundError(`Order ${orderId} not found.`);
//     }

//     lockAcquired = true;
//     lockAcquisitionCounter.inc({ status: "acquired" });

//     // 2. 🛡️ PAYMENT IDEMPOTENCY CHECK
//     let payment = await Payment.findOne({ reference }).session(session);

//     if (!payment || payment.status !== "success") {
//       await session.abortTransaction();

//       if (payment?.status === "blocked") {
//         throw new DomainError(
//           "Payment blocked by fraud engine, cannot process order.",
//         );
//       }
//       throw new DomainError(
//         "Payment status not success, cannot process order state.",
//       );
//     }

//     // 3. ATOMIC ORDER STATE TRANSITION
//     if (order.paymentStatus === "pending") {
//       // 3.1 Deduct Inventory (critical step)
//       // Assumes InventoryService.deductItems handles reservationId and uses the session
//       await InventoryService.deductItems(order.reservationId, session);

//       const updatedOrder = await Order.findOneAndUpdate(
//         { _id: orderId, paymentStatus: "pending" },
//         {
//           $set: {
//             paymentStatus: "paid",
//             status: "processing",
//             paymentId: payment._id,
//             lockToken: null, // Release lock upon successful state transition
//           },
//         },
//         { new: true, session },
//       );

//       if (!updatedOrder) {
//         await session.abortTransaction();
//         throw new ConflictError(
//           `Order state conflict: Payment status changed externally.`,
//         );
//       }
//     } else {
//       // Order was already paid, just release the lock we acquired.
//       await Order.updateOne(
//         { _id: orderId, lockToken: context.jobId },
//         { $set: { lockToken: null } },
//         { session },
//       );
//       auditLog({
//         level: "WARN",
//         event: "ORDER_ALREADY_PAID_REDUNDANT",
//         ...context,
//       });
//     }

//     // 5. COMMIT
//     await session.commitTransaction();

//     auditLog({
//       level: "SUCCESS",
//       event: "ORDER_UPDATE_COMPLETED",
//       details: { orderId, reference },
//     });
//     return { success: true, paymentId: payment._id };
//   } catch (error) {
//     await session.abortTransaction();

//     const errorName = error.name || error.constructor.name;
//     if (
//       lockAcquired &&
//       errorName !== "NotFoundError" &&
//       errorName !== "ConflictError"
//     ) {
//       await releaseOrderLock(orderId, context.jobId);
//     }

//     auditLog({
//       level: "CRITICAL",
//       event: "ORDER_UPDATE_FAILED",
//       details: { ...context, error: error.message },
//     });
//     throw error;
//   } finally {
//     session.endSession();
//   }
// };

// // -------------------------------
// // Payment Service V6 (FAST PATH Orchestrator)
// // -------------------------------
// const PaymentService = {
//   // -----------------------
//   // Get wallet balance + recent payments
//   // -----------------------
//   getWallet: async (userId) => {
//     const user = await User.findById(userId).lean();
//     if (!user) throw new NotFoundError("User not found");

//     const recentPayments = await Payment.find({ user: userId })
//       .sort({ createdAt: -1 })
//       .limit(10)
//       .lean();
//     return { balance: user.walletBalance || 0, recentPayments };
//   },

//   // -----------------------
//   // Initialize Payment (MAXIMUM RISK ORCHESTRATION)
//   // -----------------------
//   initializePayment: async (
//     userId,
//     amount,
//     email,
//     { ip, userAgent, currency = "NGN", metadata = {} } = {},
//   ) => {
//     if (!amount || amount <= 0) throw new BadRequestError("Invalid amount");
//     if (!email) throw new BadRequestError("Email required");

//     // 0️⃣ GeoIP Lookup (Non-blocking)
//     const geoData = await GeoIPClient.lookup(ip);

//     // 1️⃣ Evaluate Risk
//     const risk = await evaluatePaymentRisk({
//       userId,
//       ip,
//       userAgent,
//       context: { payment: { amount, currency }, geo: geoData },
//     });

//     if (risk.action === "block") {
//       auditLog({
//         level: "ALERT",
//         event: "PAYMENT_BLOCKED_INIT",
//         details: { userId, amount, reasons: risk.reasons },
//       });
//       throw new UnauthorizedError(
//         `Payment blocked by high-value risk engine (score: ${
//           risk.score
//         }): ${risk.reasons.join(", ")}`,
//       );
//     }

//     // 2️⃣ Generate unique reference and create payment record
//     const reference = `pay_${Date.now()}_${crypto
//       .randomBytes(4)
//       .toString("hex")}`;
//     const payment = await Payment.create({
//       user: userId,
//       reference,
//       amount,
//       currency,
//       status: "pending",
//       provider: "paystack",
//       metadata: {
//         email,
//         riskScore: risk.score,
//         riskReasons: risk.reasons,
//         geo: geoData,
//         userAgent,
//         ip,
//         ...metadata,
//       },
//     });

//     // 3️⃣ Step-up Challenge Initialization (Zenith Orchestration)
//     let challengeData = {};

//     switch (risk.action) {
//       case "challenge_otp":
//       case "challenge":
//         const otp = await generateOtp(payment._id.toString());
//         payment.metadata.stepUpType = "otp";
//         challengeData.stepUpOtp = otp;
//         payment.metadata.stepUpRequired = true;
//         break;

//       case "challenge_biometric":
//         payment.metadata.stepUpType = "biometric_and_password";
//         challengeData.biometricRequired = true;
//         challengeData.specialPasswordRequired = true;
//         payment.metadata.stepUpRequired = true;
//         break;

//       default:
//         payment.metadata.stepUpRequired = false;
//         break;
//     }

//     if (payment.metadata.stepUpRequired) {
//       payment.metadata.stepUpIssuedAt = new Date();
//       await payment.save();
//       auditLog({
//         level: "INFO",
//         event: "STEPUP_INIT",
//         details: { paymentId: payment._id, type: payment.metadata.stepUpType },
//       });
//     }

//     // 4️⃣ Initialize provider transaction
//     const koboAmount = currency === "NGN" ? Math.round(amount * 100) : amount;
//     const resp = await paystack.transaction
//       .initialize({
//         email,
//         currency,
//         amount: koboAmount,
//         reference,
//         metadata: { paymentId: payment._id.toString() },
//       })
//       .catch((err) => {
//         auditLog({
//           level: "ERROR",
//           event: "PAYSTACK_INIT_FAILED",
//           details: { paymentId: payment._id, error: err.message },
//         });
//         throw new ExternalServiceError(
//           `Paystack initialization failed: ${err.message}`,
//         );
//       });

//     if (!resp?.status || !resp?.data)
//       throw new ExternalServiceError("Provider initialization failed");

//     payment.metadata.providerInit = resp.data;
//     // 💡 Zenith Upgrade: Track provider session expiration
//     payment.metadata.providerAuthExpires = resp.data.transaction_date
//       ? new Date(
//           new Date(resp.data.transaction_date).getTime() + 12 * 60 * 60 * 1000,
//         )
//       : null;
//     await payment.save();

//     return {
//       reference,
//       authorization_url: resp.data.authorization_url,
//       access_code: resp.data.access_code,
//       ...challengeData,
//       message: payment.metadata.stepUpRequired
//         ? `Step-up verification required: ${payment.metadata.stepUpType}`
//         : "Payment initialized (no step-up)",
//     };
//   },

//   // -----------------------
//   // Step-Up Challenge Verification (MAXIMUM SECURITY)
//   // -----------------------
//   verifyStepUpChallenge: async (
//     paymentId,
//     { otp, specialPassword, livenessVideoBase64 },
//   ) => {
//     const payment = await Payment.findById(paymentId);
//     if (!payment) throw new NotFoundError("Payment not found");

//     // 1. User and Payment Status Checks
//     const user = await User.findById(payment.user);
//     if (!user) throw new NotFoundError("User not found for payment.");

//     if (payment.status !== "pending" || !payment.metadata.stepUpRequired) {
//       throw new BadRequestError(
//         "Step-up verification is not applicable or already complete for this transaction.",
//       );
//     }

//     const stepUpType = payment.metadata.stepUpType;
//     const STEPUP_TTL_MS = AppConfig.STEPUP_CHALLENGE_TTL_MS || 300 * 1000; // Use AppConfig for TTL

//     // Security Check 1: Expiration
//     const issuedAt = payment.metadata.stepUpIssuedAt
//       ? new Date(payment.metadata.stepUpIssuedAt)
//       : null;

//     if (!issuedAt || new Date() - issuedAt > STEPUP_TTL_MS) {
//       auditLog({
//         level: "WARN",
//         event: "STEPUP_EXPIRED",
//         details: { paymentId, type: stepUpType },
//       });
//       throw new UnauthorizedError(
//         "Step-up challenge has expired. Please re-initialize payment.",
//       );
//     }

//     let allChecksPassed = false;

//     // 2. Perform Verification based on Step-Up Type
//     switch (stepUpType) {
//       case "otp":
//         if (!otp) throw new BadRequestError("One-Time Password is required.");
//         try {
//           await verifyOtp(paymentId, otp);
//           allChecksPassed = true;
//         } catch (otpError) {
//           auditLog({
//             level: "WARN",
//             event: "STEPUP_OTP_FAILED",
//             details: { paymentId },
//           });
//           throw new UnauthorizedError(
//             "Invalid or incorrect One-Time Password.",
//           );
//         }
//         break;

//       case "biometric_and_password":
//         // 2.1 Check for required input
//         if (!specialPassword || !livenessVideoBase64) {
//           throw new BadRequestError(
//             "Special password and facial liveness data are required for high-value challenge.",
//           );
//         }

//         // 2.2 Special Password Check (Secure Hashed Comparison)
//         // Assuming 'user' model has a verifySpecialPassword method
//         if (!user.verifySpecialPassword(specialPassword)) {
//           auditLog({
//             level: "ALERT",
//             event: "STEPUP_PASSWORD_FAILED",
//             details: { userId: user._id, paymentId },
//           });
//           throw new UnauthorizedError("Invalid special password.");
//         }

//         // 2.3 Facial Biometric Check (Liveness & Match) - Uses internally resilient client
//         try {
//           // 🚀 PRODUCTION CALL: The biometricClientInstance handles the Breaker, Limiter, Retries, and Fallback internally.
//           const bioResult =
//             await biometricClientInstance.verifyLivenessAndMatch(
//               user._id.toString(),
//               livenessVideoBase64,
//             );

//           if (!bioResult?.success) {
//             throw new Error("Biometric check returned failure status.");
//           }

//           allChecksPassed = true;
//           auditLog({
//             level: "INFO",
//             event: "STEPUP_BIOMETRIC_SUCCESS",
//             details: { paymentId, score: bioResult.score },
//           });
//         } catch (bioError) {
//           // 💡 CRITICAL: Handle specific errors thrown by the resilient client factory
//           if (bioError instanceof BiometricVerificationError) {
//             const { code, message } = bioError;

//             auditLog({
//               level: "ALERT",
//               event: `STEPUP_BIOMETRIC_FAIL_${code}`,
//               details: { userId: user._id, paymentId, error: message },
//             });

//             switch (code) {
//               case "ASYNC_QUEUED":
//                 throw new DomainError(
//                   `Biometric service is busy. Transaction queued for async processing.`,
//                   "ASYNC_QUEUED",
//                 );

//               case "CIRCUIT_OPEN_SYNC_FAIL":
//               case "CLIENT_THROTTLED_CONCURRENCY":
//                 throw new ExternalServiceError(
//                   `Verification service is currently unavailable or overloaded. Please try again.`,
//                   "SERVICE_UNAVAILABLE",
//                 );

//               case "LIVENESS_FAIL":
//               case "MATCH_FAIL":
//                 throw new UnauthorizedError(
//                   `Biometric check failed: ${message}`,
//                   "BIOMETRIC_CHECK_FAILED",
//                 );

//               default:
//                 throw new ExternalServiceError(
//                   `Biometric verification encountered a system error: ${message}`,
//                   "EXTERNAL_ERROR",
//                 );
//             }
//           }

//           auditLog({
//             level: "CRITICAL",
//             event: "STEPUP_BIOMETRIC_UNKNOWN_FAIL",
//             details: { userId: user._id, paymentId, error: bioError.message },
//           });
//           throw new ExternalServiceError(
//             `Biometric verification failed due to an unexpected error.`,
//             "UNEXPECTED_ERROR",
//           );
//         }
//         break;

//       default:
//         throw new BadRequestError(`Unknown step-up type: ${stepUpType}`);
//     }

//     // 3. Finalize on Success
//     if (allChecksPassed) {
//       // Security Upgrade: Clear all challenge metadata
//       delete payment.metadata.stepUpRequired;
//       delete payment.metadata.stepUpIssuedAt;
//       delete payment.metadata.stepUpType;
//       payment.metadata.stepUpVerified = true;

//       await payment.save();

//       auditLog({
//         level: "SUCCESS",
//         event: "STEPUP_VERIFIED",
//         details: { paymentId },
//       });

//       return {
//         success: true,
//         message:
//           "Step-up verification completed. Proceed with payment authorization.",
//         action: "client_complete_payment",
//       };
//     }

//     throw new UnauthorizedError("Verification failed due to an unknown error.");
//   },

//   // -----------------------
//   // Verify Payment manually
//   // -----------------------
//   verifyPayment: async (reference) => {
//     if (!reference) throw new BadRequestError("Reference required");

//     const payment = await Payment.findOne({ reference });
//     if (!payment) throw new NotFoundError("Payment not found");

//     const resp = await paystack.transaction.verify({ reference });
//     if (!resp?.status || !resp?.data)
//       throw new BadRequestError("Invalid verification response");

//     const isSuccess = resp.data.status === "success";
//     payment.status = isSuccess ? "success" : "failed";
//     payment.metadata.providerVerify = resp.data;
//     await payment.save();

//     await queueJob(GENERAL_QUEUE_NAME, "payment.atomic_order_update", {
//       paymentId: payment._id.toString(),
//       provider: "paystack",
//       status: payment.status,
//       reference,
//       orderId: payment.metadata?.orderId || null,
//       amount: payment.amount,
//     });
//     auditLog({
//       level: "INFO",
//       event: "PAYMENT_VERIFIED_QUEUED",
//       details: { reference, status: payment.status },
//     });
//     return {
//       success: isSuccess,
//       payment: payment.toObject(),
//       providerData: resp.data,
//     };
//   },

//   // -----------------------
//   // Get Payment History
//   // -----------------------
//   getPaymentHistory: async (
//     userId,
//     { page = 1, limit = 10, status, provider, search, startDate, endDate },
//   ) => {
//     const baseMatch = { user: userId };
//     const pipeline = [];
//     const parsedLimit = parseInt(limit) || 10;
//     const parsedPage = parseInt(page) || 1;
//     const skip = (parsedPage - 1) * parsedLimit;

//     // Filtering logic...
//     if (status) {
//       baseMatch.status = status.toLowerCase();
//     }
//     if (provider) {
//       baseMatch.provider = provider.toLowerCase();
//     }
//     const dateQuery = {};
//     if (startDate && !isNaN(new Date(startDate))) {
//       dateQuery.$gte = new Date(startDate);
//     }
//     if (endDate && !isNaN(new Date(endDate))) {
//       dateQuery.$lte = new Date(endDate);
//     }
//     if (Object.keys(dateQuery).length > 0) {
//       baseMatch.createdAt = dateQuery;
//     }
//     if (search) {
//       const regex = new RegExp(search, "i");
//       baseMatch.$or = [
//         { reference: regex },
//         { provider: regex },
//         { "metadata.orderId": regex },
//         { "metadata.email": regex },
//       ];
//     }

//     // Aggregation pipeline...
//     pipeline.push({ $match: baseMatch });
//     pipeline.push({ $sort: { createdAt: -1 } });
//     pipeline.push({
//       $lookup: {
//         from: "orders",
//         localField: "metadata.orderId",
//         foreignField: "_id",
//         as: "orderContext",
//       },
//     });

//     const totalResult = await Payment.aggregate([
//       ...pipeline,
//       {
//         $facet: {
//           metadata: [{ $count: "totalCount" }],
//           data: [
//             { $skip: skip },
//             { $limit: parsedLimit },
//             {
//               $project: {
//                 _id: 1,
//                 reference: 1,
//                 amount: 1,
//                 currency: 1,
//                 status: 1,
//                 provider: 1,
//                 createdAt: 1,
//                 orderId: {
//                   $ifNull: [{ $arrayElemAt: ["$orderContext._id", 0] }, null],
//                 },
//                 orderStatus: {
//                   $ifNull: [
//                     { $arrayElemAt: ["$orderContext.status", 0] },
//                     "N/A",
//                   ],
//                 },
//                 riskScore: { $ifNull: ["$metadata.riskScore", 0] },
//                 riskAction: { $ifNull: ["$metadata.riskAction", "none"] },
//               },
//             },
//           ],
//         },
//       },
//     ]);

//     const metadata = totalResult[0].metadata[0] || { totalCount: 0 };
//     const payments = totalResult[0].data;
//     const totalCount = metadata.totalCount;

//     return {
//       payments,
//       totalCount,
//       totalPages: Math.ceil(totalCount / parsedLimit),
//       currentPage: parsedPage,
//     };
//   },

//   // -----------------------
//   // Process Webhook (Robust, Fast Path)
//   // -----------------------
//   processProviderWebhook: async ({
//     provider,
//     payload,
//     rawBody,
//     headers = {},
//     ip,
//     userAgent,
//   }) => {
//     // 1. Signature & Replay Protection
//     verifySignature(provider, rawBody, headers);
//     const event = payload?.data || payload;
//     const reference =
//       event?.reference ||
//       event?.id ||
//       `web_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

//     let isNew = false;
//     try {
//       isNew = await preventReplay(
//         rawBody,
//         provider,
//         reference,
//         AppConfig.WEBHOOK_REPLAY_TTL_SECONDS || 24 * 3600,
//       );
//     } catch (rpErr) {
//       console.warn(
//         "[PaymentService] replayProtector failed, falling back to optimistic processing:",
//         rpErr.message || rpErr,
//       );
//       isNew = true;
//     }

//     if (!isNew) {
//       await WebhookLog.create({
//         provider,
//         reference,
//         payload,
//         status: "replay_blocked",
//       }).catch(() => {});
//       auditLog({
//         level: "DEBUG",
//         event: "WEBHOOK_REPLAY",
//         details: { reference, provider },
//       });
//       return { processed: false, reason: "replay" };
//     }

//     // 2. GeoIP Lookup (Non-blocking)
//     const geoData = await GeoIPClient.lookup(ip);

//     const session = await mongoose.startSession();
//     session.startTransaction({ writeConcern: { w: "majority" } });

//     try {
//       // 3. Find or Create Payment record atomically (FAST PATH)
//       let payment = await Payment.findOne({ reference }).session(session);

//       if (payment && payment.status === "success") {
//         await WebhookLog.create(
//           [{ provider, reference, payload, status: "skipped" }],
//           { session },
//         );
//         await session.commitTransaction();
//         session.endSession();
//         return { processed: false, reason: "already_processed" };
//       }

//       if (!payment) {
//         // 💡 Zenith Upgrade: Ensure key fields are set for newly created webhook payments
//         payment = (
//           await Payment.create(
//             [
//               {
//                 reference,
//                 status: "pending",
//                 provider,
//                 amount: event.amount ? event.amount / 100 : 0,
//                 currency: event.currency || "NGN",
//                 user: event.metadata?.paymentId
//                   ? (await Payment.findById(event.metadata.paymentId))?.user
//                   : null,
//                 metadata: {
//                   providerData: event,
//                   orderId: event.metadata?.orderId || null,
//                 },
//               },
//             ],
//             { session },
//           )
//         )[0];
//       }

//       // 4. Evaluate risk (webhook context) & Update payment based on risk
//       const risk = await evaluatePaymentRisk({
//         userId: payment.user,
//         ip,
//         userAgent,
//         context: { payment: { amount: payment.amount }, geo: geoData },
//       });

//       // Determine final status
//       const finalStatus = risk.action === "block" ? "blocked" : "success";
//       payment.status = finalStatus;
//       payment.metadata.webhookRisk = risk;
//       payment.metadata.providerWebhook = event;
//       payment.metadata.geo = geoData;

//       const orderId = payment.metadata?.orderId || null;
//       await payment.save({ session });

//       // 5. Log fraud evaluation & Webhook receipt
//       await FraudLog.create(
//         [
//           {
//             payment: payment._id,
//             user: payment.user,
//             provider,
//             riskScore: risk.score,
//             riskAction: risk.action,
//             reasons: risk.reasons,
//             geo: geoData,
//             userAgent,
//             ip,
//           },
//         ],
//         { session },
//       );
//       await WebhookLog.create(
//         [{ provider, reference, payload, status: payment.status }],
//         { session },
//       );

//       await session.commitTransaction();
//       session.endSession();
//       auditLog({
//         level: "INFO",
//         event: "WEBHOOK_PROCESSED_FASTPATH",
//         details: { reference, status: finalStatus },
//       });

//       // 6. Queue heavy processing (SLOW PATH DELEGATION)
//       if (payment.status === "success" && orderId) {
//         await queueJob(GENERAL_QUEUE_NAME, "payment.atomic_order_update", {
//           paymentId: payment._id.toString(),
//           reference,
//           orderId,
//           provider,
//           amount: payment.amount,
//         });
//       }

//       return {
//         processed: true,
//         status: payment.status,
//         payment: payment.toObject(),
//       };
//     } catch (err) {
//       try {
//         await session.abortTransaction();
//       } catch (_) {}
//       session.endSession();
//       auditLog({
//         level: "ERROR",
//         event: "WEBHOOK_PROCESSING_FAILED",
//         details: { reference, error: err.message },
//       });
//       throw err;
//     }
//   },
// };

// module.exports = PaymentService;
// module.exports.prometheusRegistry = prometheusRegistry;
// module.exports.executeAtomicOrderUpdate = executeAtomicOrderUpdate;
"use strict";

const crypto = require("crypto");
const Logger = require("../../utils/logger");
const Tracing = require("../../utils/tracingClient");
const { packRateLimitKey } = require("../../utils/redisKey");
const { preventReplay } = require("../../utils/webhookReplayProtector");
const { getRedisClient } = require("../../lib/redisClient");

const ALGORITHMS = {
    FWC: "FWC",
    SWL: "SWL",
};

/**
 * COSMOS HYPER-FABRIC OMEGA: Rate Limiter Factory
 * ----------------------------------------------
 * Properly flattens the middleware generation to ensure Redis is available
 * and LUA scripts execute correctly across the cluster.
 */
function createRateLimiterFactory({
    shas,
    temporarilyBlock,
    isBlocked,
    getFabricStatus,
}) {
    // Basic validation of required factory tools
    if (!shas || !shas.FWC || !shas.SWL) {
        throw new Error("RateLimiter Factory: Missing pre-loaded LUA SHAs.");
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

    /**
     * Returns the actual configured limiter instance
     */
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

        // THE ACTUAL MIDDLEWARE RETURNED TO EXPRESS
        return async (req, res, next) => {
            // 1. Ensure Redis is Ready (Lazy Loading)
            let redisClient;
            try {
                redisClient = getRedisClient();
            } catch (e) {
                redisClient = null;
            }

            if (!redisClient || redisClient.status !== "ready") {
                Logger.warn("RATE_LIMITER_FAIL_OPEN_REDIS_NOT_READY");
                return next();
            }

            // 2. Correlation ID
            if (!req.ingressRequestId) {
                req.ingressRequestId = crypto.randomUUID();
            }

            // 3. Health Check
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

                req.rateLimitKey = limitKey;

                span.setAttribute("rateLimit.algorithm", algorithm);
                span.setAttribute("rateLimit.identifier", identifier);
                span.setAttribute("rateLimit.key", limitKey);
                span.setAttribute("rateLimit.ingressRequestId", req.ingressRequestId);

                // A. GLOBAL BLOCKLIST CHECK
                if (isBlocked && await isBlocked(redisClient, blockKey)) {
                    span.setAttribute("rateLimit.result", "BLOCKED");
                    res.setHeader("Retry-After", String(blockOnExceed.banSeconds || 300));
                    return res.status(429).json({
                        status: "fail",
                        message: "Temporarily blocked due to abusive activity.",
                    });
                }

                // B. REPLAY PROTECTION
                const replayEnabled =
                    req.method !== "GET" &&
                    req.method !== "HEAD" &&
                    req.method !== "OPTIONS" &&
                    (req.headers["x-event-id"] || req.headers["x-webhook-id"] || req.headers["x-provider"]);

                if (replayEnabled && req.rawBody) {
                    const eventId = req.headers["x-event-id"] || req.headers["x-webhook-id"] || "";
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
                        },
                    });

                    if (isReplay) {
                        span.setAttribute("rateLimit.result", "REPLAY_BLOCKED");
                        const replayBlockKey = `replay:${identifier}:${req.route?.path || "unknown"}`;
                        if (temporarilyBlock) await temporarilyBlock(redisClient, replayBlockKey, 600);
                        
                        res.setHeader("Retry-After", "600");
                        return res.status(429).json({
                            status: "fail",
                            code: "REPLAY_DETECTED",
                            message: "Duplicate request detected",
                        });
                    }
                }

                // C. LUA EXECUTION
                let currentCount, ttlSeconds, allowed;
                let results;

                if (algorithm === ALGORITHMS.SWL) {
                    const windowMs = windowSeconds * 1000;
                    // SWL Script typically returns [allowed, currentCount, ttlMs]
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
                    ttlSeconds = Math.ceil(results[2] / 1000);
                } else {
                    // FWC Script typically returns [currentCount, ttlSeconds]
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
                    
                    if (blockOnExceed?.enabled && temporarilyBlock) {
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
                Logger.error("RATE_LIMITER_ERROR_FAIL_OPEN", {
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
    };
}

module.exports = { ALGORITHMS, createRateLimiterFactory };