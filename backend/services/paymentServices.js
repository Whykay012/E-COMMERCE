"use strict";

const mongoose = require("mongoose");
const crypto = require("crypto");
const Redis = require("ioredis");

// --- Models ---
const Payment = require("../model/payment");
const Order = require("../model/order");
const User = require("../model/userModel");
const WebhookLog = require("../model/webHookLog");
const FraudLog = require("../model/FraudLog");

// --- DTOs ---
const PaymentDTO = require("../dtos/paymentDto");

// --- Utilities & Services ---
const { generateOtp, verifyOtp } = require("../services/otpService");
const {
  evaluatePaymentRisk,
  prometheusRegistry,
  lockAcquisitionCounter,
} = require("../services/risk/paymentRiskEngine");
const GeoIPClient = require("./geoip/maxMindClient");

// 💡 REAL DEPENDENCIES FOR RESILIENCE
const CircuitBreaker = require("../utils/circuitBreaker");
const { ConcurrencyLimiter } = require("../utils/concurrencyLimiter");

const { queueJob, GENERAL_QUEUE_NAME } = require("../queue/jobQueue");
const { InventoryService } = require("./inventoryService");
const AuditLogger = require("./auditLogger");
const { log: auditLog } = AuditLogger;

const replayProtector = require("../utils/webhookReplayProtector");
const preventReplay =
  replayProtector.checkAndStoreFingerprint || replayProtector;

// --- CRITICAL DEPENDENCIES FOR HIGH-VALUE CHECK ---
const {
  createBiometricClientService,
  BiometricVerificationError,
} = require("./biometricClientFactory");

// 💡 Configuration Adapter
const AppConfig = require("../config/appConfig");

// --- Errors ---
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const DomainError = require("../errors/domainError");
const ConflictError = require("../errors/conflictError");
const UnauthorizedError = require("../errors/unauthorizedError");
const ExternalServiceError = require("../errors/externalServiceError");

// --- Config & Clients ---
const PaystackSDK = require("@paystack/paystack-sdk");
const {
  PAYSTACK_SECRET,
  STRIPE_SECRET,
  STRIPE_ENDPOINT_SECRET,
  FLUTTERWAVE_SECRET,
} = process.env;
const paystack = new PaystackSDK(PAYSTACK_SECRET);

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// -----------------------------------------------------------
// 🚀 BIOMETRIC RESILIENCE INITIALIZATION
// -----------------------------------------------------------

const biometricLimiter = new ConcurrencyLimiter({
  maxConcurrent: AppConfig.MAX_CONCURRENT_BIOMETRIC_CALLS || 25,
  name: "BiometricLimiter",
});

const biometricBreaker = new CircuitBreaker(async () => {}, {
  timeout: AppConfig.BIOMETRIC_BREAKER_TIMEOUT_MS || 4000,
  errorThreshold: AppConfig.BIOMETRIC_BREAKER_ERROR_THRESHOLD || 60,
  resetTimeout: AppConfig.BIOMETRIC_BREAKER_RESET_MS || 30000,
  name: "BiometricVerification",
});

const biometricClientInstance = createBiometricClientService({
  concurrencyLimiterInstance: biometricLimiter,
  circuitBreakerInstance: biometricBreaker,
});

// -------------------------------
// Signature Verification
// -------------------------------
/**
 * 🔐 Cryptographic Webhook Validation
 * Handles HMAC-SHA verification for Paystack/Flutterwave
 * and Time-based Signature verification for Stripe.
 */
function verifySignature(provider, rawBody, headers = {}) {
  if (!rawBody) throw new Error("Raw body required for signature verification");
  const p = provider.toLowerCase();

  switch (p) {
    case "stripe": {
      const sig = headers["stripe-signature"] || headers["Stripe-Signature"];
      // Use the variables destructured from process.env
      if (!STRIPE_ENDPOINT_SECRET || !STRIPE_SECRET) {
        throw new Error(
          "Stripe secrets (ENDPOINT_SECRET or API_KEY) not configured",
        );
      }
      if (!sig) throw new Error("Missing Stripe signature header.");

      try {
        const stripe = require("stripe")(STRIPE_SECRET);
        // This is the functional, live verification
        stripe.webhooks.constructEvent(rawBody, sig, STRIPE_ENDPOINT_SECRET);
        return true;
      } catch (err) {
        auditLog({
          level: "CRITICAL",
          event: "STRIPE_SIGNATURE_MISMATCH",
          details: { error: err.message },
        });
        throw new Error(`Stripe signature verification failed: ${err.message}`);
      }
    }

    case "paystack": {
      const sig =
        headers["x-paystack-signature"] || headers["X-Paystack-Signature"];
      if (!PAYSTACK_SECRET) throw new Error("PAYSTACK_SECRET not configured");

      const hash = crypto
        .createHmac("sha512", PAYSTACK_SECRET)
        .update(rawBody)
        .digest("hex");

      if (hash !== sig) throw new Error("Invalid Paystack signature");
      return true;
    }

    case "flutterwave": {
      const sig = headers["verif-hash"] || headers["Verif-Hash"];
      if (!FLUTTERWAVE_SECRET)
        throw new Error("FLUTTERWAVE_SECRET not configured");

      const hash = crypto
        .createHmac("sha256", FLUTTERWAVE_SECRET)
        .update(rawBody)
        .digest("hex");

      if (hash !== sig) throw new Error("Invalid Flutterwave signature");
      return true;
    }

    default:
      throw new Error(
        `Unsupported provider for signature verification: ${provider}`,
      );
  }
}

// -------------------------------
// Lock Management
// -------------------------------
const releaseOrderLock = async (orderId, jobId) => {
  try {
    const result = await Order.updateOne(
      { _id: orderId, lockToken: jobId },
      { $set: { lockToken: null } },
    );
    if (result.modifiedCount > 0) {
      auditLog({
        level: "INFO",
        event: "ORDER_LOCK_RELEASED_FAILSAFE",
        details: { orderId, jobId },
      });
    }
  } catch (lockErr) {
    auditLog({
      level: "ERROR",
      event: "ORDER_LOCK_RELEASE_FAILED",
      details: { orderId, jobId, error: lockErr.message },
    });
  }
};

// -------------------------------
// Transactional Worker Logic (SLOW PATH)
// -------------------------------
/**
 * ⚛️ ATOMIC ORDER STATE TRANSITION (Worker Logic)
 * Ensures that payment success, inventory deduction, and order status
 * are treated as a single unit of work (ACID).
 */
const executeAtomicOrderUpdate = async (data, context) => {
  const { orderId, reference } = data;
  const session = await mongoose.startSession();

  // 💡 Enterprise Write Concern: Ensure high consistency for critical money movement
  session.startTransaction({
    readConcern: { level: "majority" },
    writeConcern: { w: "majority" },
  });

  let lockAcquired = false;

  try {
    // 1. 🔒 PESSIMISTIC LOCKING: Acquire exclusive lock on the order
    const order = await Order.findOneAndUpdate(
      { _id: orderId, lockToken: { $in: [null, context.jobId] } },
      { $set: { lockToken: context.jobId } },
      { new: true, session, runValidators: true },
    ).session(session);

    if (!order) {
      // Logic to determine WHY the lock failed (Conflict vs Not Found)
      const competingOrder = await Order.findOne({
        _id: orderId,
        lockToken: { $ne: context.jobId, $ne: null },
      }).session(session);

      await session.abortTransaction();

      if (competingOrder) {
        lockAcquisitionCounter.inc({ status: "conflict" });
        auditLog({
          level: "WARN",
          event: "ORDER_LOCKED_CONFLICT",
          details: { ...context, competingLock: competingOrder.lockToken },
        });
        throw new ConflictError(
          `Order is currently locked by competing job: ${competingOrder.lockToken}`,
        );
      }

      lockAcquisitionCounter.inc({ status: "not_found" });
      throw new NotFoundError(`Order ${orderId} not found.`);
    }

    lockAcquired = true;
    lockAcquisitionCounter.inc({ status: "acquired" });

    // 2. 🛡️ PAYMENT STATE VERIFICATION
    let payment = await Payment.findOne({ reference }).session(session);

    if (!payment || payment.status !== "success") {
      await session.abortTransaction();

      // Explicit handling for different failure states
      if (payment?.status === "blocked") {
        auditLog({
          level: "ALERT",
          event: "ORDER_BLOCK_FRAUD",
          details: { orderId, reference },
        });
        throw new DomainError(
          "Payment blocked by fraud engine, fulfillment aborted.",
        );
      }

      throw new DomainError(
        `Payment status is '${payment?.status || "missing"}', cannot fulfill order.`,
      );
    }

    // 3. ATOMIC STATE TRANSITION
    if (order.paymentStatus === "pending") {
      // 3.1 Synchronous Inventory Deduction
      // This uses the same session to ensure inventory is only reduced if the order is marked as paid
      await InventoryService.deductItems(order.reservationId, session);

      // 3.2 Update Order Record
      const updatedOrder = await Order.findOneAndUpdate(
        { _id: orderId, paymentStatus: "pending" },
        {
          $set: {
            paymentStatus: "paid",
            status: "processing",
            paymentId: payment._id,
            lockToken: null, // Release lock
          },
        },
        { new: true, session },
      );

      if (!updatedOrder) {
        await session.abortTransaction();
        throw new ConflictError(
          `Order state conflict: Payment status changed by another process.`,
        );
      }
    } else {
      // Case: Webhook re-fired but order is already fulfilled
      await Order.updateOne(
        { _id: orderId, lockToken: context.jobId },
        { $set: { lockToken: null } },
        { session },
      );
      auditLog({
        level: "INFO",
        event: "ORDER_ALREADY_PAID_IDEMPOTENT",
        details: { orderId, reference },
      });
    }

    // 4. COMMIT EVERYTHING
    await session.commitTransaction();

    auditLog({
      level: "SUCCESS",
      event: "ORDER_UPDATE_COMPLETED",
      details: { orderId, reference },
    });

    return { success: true, paymentId: payment._id };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }

    // 5. DEFENSIVE LOCK RELEASE
    const errorName = error.name || error.constructor.name;
    const criticalError = !["NotFoundError", "ConflictError"].includes(
      errorName,
    );

    if (lockAcquired && criticalError) {
      // If we crashed for a reason other than a known conflict, release the lock so the job can retry
      await releaseOrderLock(orderId, context.jobId);
    }

    auditLog({
      level: "CRITICAL",
      event: "ORDER_UPDATE_FAILED",
      details: { ...context, error: error.message, stack: error.stack },
    });

    throw error;
  } finally {
    session.endSession();
  }
};

// -------------------------------
// Payment Service V6
// -------------------------------
// -----------------------
// Get wallet balance + recent payments
// -----------------------
const PaymentService = {
  getWallet: async (userId) => {
    const user = await User.findById(userId).select("+walletBalance").lean();
    if (!user) throw new NotFoundError("User account not found");

    // Fetch payments with projection to save memory
    const recentPayments = await Payment.find({ user: userId })
      .select("reference amount status currency createdAt provider")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return PaymentDTO.formatWalletResponse(user, recentPayments);
  },
  // -----------------------
  // Initialize Payment (MAXIMUM RISK ORCHESTRATION)
  // -----------------------
  initializePayment: async (
    userId,
    amount,
    email,
    {
      ip,
      userAgent,
      currency = "NGN",
      metadata = {},
      provider = "paystack",
    } = {},
  ) => {
    const input = PaymentDTO.transformInitializeInput({
      amount,
      email,
      currency,
      metadata,
    });

    // A. Geo-Fencing & Risk Scoring
    const geoData = await GeoIPClient.lookup(ip);
    const risk = await evaluatePaymentRisk({
      userId,
      ip,
      userAgent,
      context: {
        payment: { amount: input.amount, currency: input.currency },
        geo: geoData,
      },
    });

    if (risk.action === "block") {
      await FraudLog.create({
        userId,
        ip,
        action: "INITIALIZE_BLOCKED",
        reasons: risk.reasons,
      });
      throw new UnauthorizedError(`Transaction declined: High risk detected.`);
    }

    // B. Reference Generation (IDEMPOTENT)
    const reference = `ZEN_${crypto.randomBytes(12).toString("hex")}`;

    // C. Create Payment Record (Draft State)
    const payment = await Payment.create({
      user: userId,
      reference,
      amount: input.amount,
      currency: input.currency,
      status: "pending",
      provider: provider.toLowerCase(),
      metadata: {
        ...input.metadata,
        risk: { score: risk.score, reasons: risk.reasons },
        client: { ip, userAgent, geo: geoData },
      },
    });

    // D. Step-Up Orchestration (OTP or Biometric)
    let challengeData = {};

    if (risk.action.startsWith("challenge")) {
      payment.metadata.stepUpRequired = true;
      payment.metadata.stepUpIssuedAt = new Date();

      // Explicitly handle types to avoid "fallback" bugs
      if (risk.action.includes("otp")) {
        challengeData.stepUpOtp = await generateOtp(payment._id.toString());
        payment.metadata.stepUpType = "otp";
      } else if (risk.action.includes("biometric")) {
        payment.metadata.stepUpType = "biometric_and_password";
        challengeData.biometricRequired = true;
        challengeData.specialPasswordRequired = true;
      } else {
        // Default fallback or general challenge
        payment.metadata.stepUpType = "general_verification";
      }
      await payment.save();
    }

    // E. Provider Handshake (Abstracted Factory)
    // This is the "Best Practice" part
    const providerInstance = getProviderAdapter(payment.provider);
    const providerResp = await providerInstance.initialize({
      email: input.email,
      // Move kobo conversion logic into the adapter itself for cleaner code
      amount: payment.amount,
      currency: payment.currency,
      reference,
      metadata: { paymentId: payment._id },
    });

    payment.metadata.providerInit = providerResp;
    // Set expiry here if not handled inside the adapter
    payment.metadata.providerAuthExpires = new Date(Date.now() + 12 * 3600000);

    await payment.save();

    return PaymentDTO.formatInitializationResponse(
      payment,
      providerResp,
      challengeData,
    );
  },
  // -----------------------
  // Step-Up Challenge Verification (MAXIMUM SECURITY)
  // -----------------------
  verifyStepUpChallenge: async (
    paymentId,
    { otp, specialPassword, livenessVideoBase64 },
  ) => {
    const payment = await Payment.findById(paymentId);
    if (!payment) throw new NotFoundError("Payment not found");

    const user = await User.findById(payment.user);
    if (!user) throw new NotFoundError("User not found.");

    // Ensure we aren't re-verifying a finished challenge
    if (payment.status !== "pending" || !payment.metadata.stepUpRequired) {
      throw new BadRequestError("Step-up not applicable or already complete.");
    }

    // Security Check: Challenge Expiration
    const STEPUP_TTL = AppConfig.STEPUP_CHALLENGE_TTL_MS || 300000;
    if (new Date() - new Date(payment.metadata.stepUpIssuedAt) > STEPUP_TTL) {
      auditLog({
        level: "WARN",
        event: "STEPUP_EXPIRED",
        details: { paymentId },
      });
      throw new UnauthorizedError(
        "Step-up challenge expired. Please re-initialize.",
      );
    }

    let allChecksPassed = false;
    const stepUpType = payment.metadata.stepUpType;

    switch (stepUpType) {
      case "otp":
        if (!otp) throw new BadRequestError("OTP required.");
        await verifyOtp(paymentId, otp);
        allChecksPassed = true;
        break;

      case "biometric_and_password":
        if (!specialPassword || !livenessVideoBase64)
          throw new BadRequestError(
            "Challenge requires password and biometric data.",
          );

        // 1. Password Verification
        if (!user.verifySpecialPassword(specialPassword)) {
          auditLog({
            level: "ALERT",
            event: "STEPUP_PASSWORD_FAILED",
            details: { userId: user._id, paymentId },
          });
          throw new UnauthorizedError("Invalid special password.");
        }

        // 2. Biometric Verification with Resilient Handling
        try {
          const bioResult =
            await biometricClientInstance.verifyLivenessAndMatch(
              user._id.toString(),
              livenessVideoBase64,
            );
          if (!bioResult?.success)
            throw new Error("Biometric verification failed.");

          allChecksPassed = true;
        } catch (bioError) {
          // RESTORED: Precise error reporting for the frontend
          if (bioError instanceof BiometricVerificationError) {
            const { code, message } = bioError;
            auditLog({
              level: "CRITICAL",
              event: `BIOMETRIC_ERROR_${code}`,
              details: { paymentId, message },
            });

            if (code === "ASYNC_QUEUED")
              throw new DomainError("Service busy, queued.", "ASYNC_QUEUED");
            throw new ExternalServiceError(
              `Biometric Service: ${message}`,
              code,
            );
          }
          throw bioError;
        }
        break;

      default:
        throw new BadRequestError(`Unsupported step-up type: ${stepUpType}`);
    }

    if (allChecksPassed) {
      // Security Cleanup: Purge challenge data on success
      payment.metadata.stepUpRequired = false;
      payment.metadata.stepUpVerified = true;
      delete payment.metadata.stepUpType;
      delete payment.metadata.stepUpIssuedAt;

      await payment.save();

      auditLog({
        level: "SUCCESS",
        event: "STEPUP_VERIFIED",
        details: { paymentId },
      });

      return {
        success: true,
        message: "Step-up verified. Proceeding to authorization.",
        action: "client_complete_payment",
      };
    }

    throw new UnauthorizedError("Verification failed.");
  },
  // -----------------------
  // Verify Payment manually
  // -----------------------
  verifyPayment: async (reference) => {
    const payment = await Payment.findOne({ reference });
    if (!payment) throw new NotFoundError("Payment not found");

    const resp = await paystack.transaction.verify({ reference });
    const isSuccess = resp.data.status === "success";

    payment.status = isSuccess ? "success" : "failed";
    payment.metadata.providerVerify = resp.data;
    await payment.save();

    await queueJob(GENERAL_QUEUE_NAME, "payment.atomic_order_update", {
      paymentId: payment._id.toString(),
      reference,
      orderId: payment.metadata?.orderId || null,
      status: payment.status,
    });

    return {
      success: isSuccess,
      payment: payment.toObject(),
      providerData: resp.data,
    };
  },
  // -----------------------
  // Get Payment History
  // -----------------------
  getPaymentHistory: async (userId, params) => {
    const { page = 1, limit = 10, status, search, startDate, endDate } = params;
    const baseMatch = { user: new mongoose.Types.ObjectId(userId) };

    if (status) baseMatch.status = status.toLowerCase();
    if (search) baseMatch.reference = new RegExp(search, "i");
    if (startDate || endDate) {
      baseMatch.createdAt = {};
      if (startDate) baseMatch.createdAt.$gte = new Date(startDate);
      if (endDate) baseMatch.createdAt.$lte = new Date(endDate);
    }

    const result = await Payment.aggregate([
      { $match: baseMatch },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          metadata: [{ $count: "totalCount" }],
          data: [
            { $skip: (parseInt(page) - 1) * parseInt(limit) },
            { $limit: parseInt(limit) },
            { $project: { metadata: 0, __v: 0 } },
          ],
        },
      },
    ]);

    const totalCount = result[0].metadata[0]?.totalCount || 0;
    return {
      payments: result[0].data,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: parseInt(page),
    };
  },
  // -----------------------
  // Process Webhook (Robust, Fast Path with Restored Fraud Audit)
  // -----------------------
  processProviderWebhook: async ({
    provider,
    payload,
    rawBody,
    headers,
    ip,
    userAgent,
  }) => {
    verifySignature(provider, rawBody, headers);
    const event = payload?.data || payload;
    const reference = event?.reference || event?.id;

    // 1. Replay Protection
    if (!(await preventReplay(rawBody, provider, reference))) {
      return { processed: false, reason: "duplicate_webhook" };
    }

    const geoData = await GeoIPClient.lookup(ip);
    const session = await mongoose.startSession();

    // 💡 Enterprise Write Concern for financial records
    session.startTransaction({ writeConcern: { w: "majority" } });

    try {
      let payment = await Payment.findOne({ reference }).session(session);

      // 2. Atomic Find-or-Create
      if (!payment) {
        payment = (
          await Payment.create(
            [
              {
                reference,
                status: "pending",
                provider,
                amount: event.amount / 100,
                user: event.metadata?.userId || null,
                metadata: {
                  providerData: event,
                  orderId: event.metadata?.orderId,
                },
              },
            ],
            { session },
          )
        )[0];
      }

      // 3. Idempotency Check
      if (payment.status === "success") {
        await session.commitTransaction();
        return { processed: false, reason: "idempotent_ok" };
      }

      // 4. Real-time Risk Evaluation
      const risk = await evaluatePaymentRisk({
        userId: payment.user,
        ip,
        userAgent,
        context: { payment: { amount: payment.amount }, geo: geoData },
      });

      // 5. Update Payment State
      payment.status = risk.action === "block" ? "blocked" : "success";
      payment.metadata.lastWebhook = {
        receivedAt: new Date(),
        sourceIp: ip,
        riskEvaluation: risk, // The full risk object
        providerStatus: risk.action, // Shortcut for quick logic
      };
      await payment.save({ session });

      // -----------------------------------------------------------
      // 🚀 RESTORED: Fraud Audit Logging (Inside Transaction)
      // -----------------------------------------------------------
      await FraudLog.create(
        [
          {
            payment: payment._id,
            user: payment.user,
            provider,
            riskScore: risk.score,
            riskAction: risk.action,
            reasons: risk.reasons,
            geo: geoData,
            userAgent,
            ip,
          },
        ],
        { session },
      );

      // 6. Webhook History Logging
      await WebhookLog.create(
        [{ provider, reference, payload, status: payment.status }],
        { session },
      );

      await session.commitTransaction();

      // 7. Slow Path Delegation
      if (payment.status === "success" && payment.metadata.orderId) {
        await queueJob(GENERAL_QUEUE_NAME, "payment.atomic_order_update", {
          paymentId: payment._id.toString(),
          reference,
          orderId: payment.metadata.orderId,
        });
      }

      auditLog({
        level: "INFO",
        event: "WEBHOOK_PROCESSED",
        details: { reference, status: payment.status, riskScore: risk.score },
      });

      return { processed: true, status: payment.status };
    } catch (err) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      throw err;
    } finally {
      session.endSession();
    }
  },
};

module.exports = PaymentService;
module.exports.prometheusRegistry = prometheusRegistry;
module.exports.executeAtomicOrderUpdate = executeAtomicOrderUpdate;
