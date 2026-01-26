/* ===========================
 * 📦 Dependencies (Models, Services, Utils)
 * =========================== */
const mongoose = require("mongoose");
const pdf = require("pdfkit");
const pLimit = require("p-limit");
const { v4: uuidv4 } = require("uuid");

// 💡 NEW: High-Assurance Dependencies
const { getRedisClient } = require("../lib/redisCacheClient");
const Logger = require("../utils/logger");
const {
  NotFoundError,
  BadRequestError,
  InternalServerError,
} = require("../errors/customErrors");

// Models
const User = require("../model/userModel"); // Ensure this points to your unified User schema
const WishlistItem = require("../model/WishlistItem");
const Notification = require("../model/notification");
const Session = require("../model/session");
const Order = require("../model/order");
const Payment = require("../model/payment");
const PaymentMethod = require("../model/paymentMethod");
const Address = require("../model/address");

// Services & Security Engine
const authService = require("./authService");
const passwordHistoryService = require("./passwordHistoryService");
const queueClient = require("./queueAdapters/queueClient");
const securityEngine = require("../utils/securityPolicyUtils");
const { dispatchLog: auditLog } = require("./auditLogger");
const { getPaginationParams } = require("../utils/paginationUtils");

// 💡 Concurrency Semaphore Initialization
const DB_CONCURRENCY_LIMIT = 6;
const limit = pLimit(DB_CONCURRENCY_LIMIT);

/* ==============================================
 * 🚀 ZENITH SECURITY & AUTHENTICATION METHODS
 * ============================================== */

/**
 * @desc Minimalist fetch for WebAuthn handshake
 * Superiority: Uses lean() and specific projection to reduce RAM overhead
 */
const getUserCredentials = async (userId) => {
  const user = await User.findById(userId).select("credentials").lean();

  if (!user) throw new NotFoundError("User not found");
  return user.credentials || [];
};

/**
 * @desc PANIC BUTTON: Global Revocation
 * @logic 1. Wipes all sessions in Redis. 2. Resets HA state. 3. Logs Critical Audit.
 */
/**
 * @desc Emergency Global Revocation (Panic Room)
 * @logic Terminates all sessions, increments security version, and logs audit data.
 */
exports.globalPanicRevocation = async (
  userId,
  adminId,
  reason = "Administrative Security Reset",
  ip = "0.0.0.0"
) => {
  return await Tracing.withSpan("identity.panicRevocation", async (span) => {
    const User = require("../models/User");

    // 1. ATOMIC DB UPDATE (The "Nuke" Button)
    // We use findByIdAndUpdate for O(1) speed since we have the ID.
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        $inc: { securityVersion: 1 }, // Invalidates all existing JWTs instantly
        $set: {
          lastWebAuthnVerification: 0, // Wipes MFA state
          isDisabled: true, // Optional: Lock the account entirely
        },
        $push: {
          securityAudit: {
            event: "GLOBAL_REVOCATION",
            admin: adminId,
            reason: reason,
            ip: ip, // ⭐ NEW: IP tracking for admin accountability
            ts: new Date(),
          },
        },
      },
      {
        new: true,
        runValidators: true, // ⭐ NEW: Ensures data integrity during panic
        select: "+securityVersion", // ⭐ NEW: Force-select hidden security field
      }
    );

    if (!updatedUser) {
      throw new NotFoundError("User not found for revocation.");
    }

    // 2. REDIS CLEANUP (Critical Challenges)
    const redis = getRedisClient();
    await redis.del(`auth:webauthn:challenge:${userId}`);
    // If you have a session-based refresh token store, clear it here:
    // await redis.del(`auth:sessions:${userId}`);

    // 3. LOGGING & OBSERVABILITY
    Logger.critical("SECURITY_PANIC_TRIGGERED", {
      userId,
      adminId,
      newVersion: updatedUser.securityVersion,
      ip,
    });

    return {
      success: true,
      newVersion: updatedUser.securityVersion,
    };
  });
};

/* ==============================================
 * 📊 USER DASHBOARD LOGIC (CQRS-lite Read Model)
 * ============================================== */

const fetchUserDashboard = async (userId, queryParams) => {
  const limitCount = parseInt(queryParams.limit) || 5;
  const p = {
    wishlist: parseInt(queryParams.wishlistPage) || 1,
    orders: parseInt(queryParams.ordersPage) || 1,
    notifs: parseInt(queryParams.notificationsPage) || 1,
    payments: parseInt(queryParams.paymentsPage) || 1,
    sessions: parseInt(queryParams.sessionsPage) || 1,
  };

  const userObjectId = new mongoose.Types.ObjectId(userId);

  // 1. Fetch Summaries (Bounded Parallelism)
  const [
    wishlistCount,
    ordersSummary,
    notificationsCount,
    userProfile,
    pendingPaymentsCount,
    sessionsCount,
    totalPaymentsCount,
  ] = await Promise.all([
    limit(() => WishlistItem.countDocuments({ user: userId })),
    limit(() =>
      Order.aggregate([
        { $match: { user: userObjectId } },
        {
          $group: {
            _id: "$user",
            totalOrders: { $sum: 1 },
            totalSpent: { $sum: "$totalAmount" },
          },
        },
      ])
    ),
    limit(() => Notification.countDocuments({ user: userId, read: false })),
    limit(() =>
      User.findById(userId).select("loyaltyPoints username email phone").lean()
    ),
    limit(() => Payment.countDocuments({ user: userId, status: "pending" })),
    limit(() => Session.countDocuments({ user: userId, valid: true })),
    limit(() => Payment.countDocuments({ user: userId })),
  ]);

  const totalOrders = ordersSummary[0]?.totalOrders || 0;
  const totalSpent = ordersSummary[0]?.totalSpent || 0;

  // 2. Fetch Detailed Lists & Analytics
  const [
    wishlist,
    orders,
    payments,
    notifications,
    sessions,
    paymentMethods,
    addresses,
    recentlyViewed,
    tickets,
    activities,
    loyaltyHistory,
    cart,
    topProductsAgg,
    salesInsights,
  ] = await Promise.all([
    limit(() =>
      WishlistItem.find({ user: userId })
        .skip((p.wishlist - 1) * limitCount)
        .limit(limitCount)
        .populate("product")
        .lean()
    ),
    limit(() =>
      Order.find({ user: userId })
        .skip((p.orders - 1) * limitCount)
        .limit(limitCount)
        .sort({ createdAt: -1 })
        .lean()
    ),
    limit(() =>
      Payment.find({ user: userId })
        .skip((p.payments - 1) * limitCount)
        .limit(limitCount)
        .sort({ createdAt: -1 })
        .lean()
    ),
    limit(() =>
      Notification.find({ user: userId })
        .skip((p.notifs - 1) * limitCount)
        .limit(limitCount)
        .sort({ createdAt: -1 })
        .lean()
    ),
    limit(() =>
      Session.find({ user: userId, valid: true })
        .skip((p.sessions - 1) * limitCount)
        .limit(limitCount)
        .sort({ createdAt: -1 })
        .lean()
    ),
    limit(() =>
      PaymentMethod.find({ user: userId })
        .sort({ isDefault: -1, createdAt: -1 })
        .lean()
    ),
    limit(() =>
      Address.find({ user: userId })
        .sort({ isDefault: -1, createdAt: -1 })
        .lean()
    ),
    limit(() =>
      mongoose.models.RecentlyViewed.find({ user: userId })
        .populate("product")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
    ),
    limit(() =>
      mongoose.models.SupportTicket.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean()
    ),
    limit(() =>
      mongoose.models.ActivityLog.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
    ),
    limit(() =>
      mongoose.models.LoyaltyHistory.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
    ),
    limit(() =>
      mongoose.models.Cart.findOne({ user: userId })
        .populate("items.product")
        .lean()
    ),
    limit(() =>
      Order.aggregate([
        { $match: { user: userObjectId } },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.productId",
            name: { $first: "$items.name" },
            totalSold: { $sum: "$items.quantity" },
          },
        },
        { $sort: { totalSold: -1 } },
        { $limit: 5 },
      ])
    ),
    limit(() =>
      Order.aggregate([
        { $match: { user: userObjectId, paymentStatus: "paid" } },
        {
          $group: {
            _id: { $month: "$createdAt" },
            totalSales: { $sum: "$totalAmount" },
            totalOrders: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
    ),
  ]);

  return {
    userProfile,
    summary: {
      totalOrders,
      totalSpent,
      loyaltyPoints: userProfile?.loyaltyPoints || 0,
      unreadNotifications: notificationsCount,
      pendingPayments: pendingPaymentsCount,
      wishlistCount,
      cartItemsCount: cart?.items?.length || 0,
      savedAddressesCount: addresses.length,
      savedPaymentMethodsCount: paymentMethods.length,
    },
    lists: {
      wishlist,
      orders,
      payments,
      notifications,
      sessions,
      paymentMethods,
      addresses,
      recentlyViewed,
      tickets,
      activities,
      loyaltyHistory,
    },
    analytics: {
      cart: cart || { items: [] },
      topProducts: topProductsAgg,
      salesInsights,
    },
    pagination: {
      limit: limitCount,
      wishlist: {
        page: p.wishlist,
        total: wishlistCount,
        pages: Math.ceil(wishlistCount / limitCount),
      },
      orders: {
        page: p.orders,
        total: totalOrders,
        pages: Math.ceil(totalOrders / limitCount),
      },
      notifications: {
        page: p.notifs,
        total: notificationsCount,
        pages: Math.ceil(notificationsCount / limitCount),
      },
      payments: {
        page: p.payments,
        total: totalPaymentsCount,
        pages: Math.ceil(totalPaymentsCount / limitCount),
      },
      sessions: {
        page: p.sessions,
        total: sessionsCount,
        pages: Math.ceil(sessionsCount / limitCount),
      },
    },
  };
};

/* ===========================
 * 👤 PROFILE & SECURITY LOGIC
 * =========================== */

const updateUserProfile = async (userID, updateData) => {
  const updatedUser = await User.findByIdAndUpdate(
    userID,
    { $set: updateData },
    { new: true, runValidators: true }
  ).select("-password -__v");

  if (!updatedUser) throw new NotFoundError("User not found.");

  auditLog({
    level: "INFO",
    event: "USER_PROFILE_UPDATED",
    userId: userID,
    details: updateData,
  });
  return updatedUser.toObject();
};

const changeUserPassword = async (userID, oldPassword, newPassword) => {
  const context = { userID, traceId: uuidv4() };

  const securityAnalysis = securityEngine.calculatePasswordRisk(newPassword);
  if (!securityAnalysis.isViable) {
    throw new BadRequestError(
      `Password rejected: ${securityAnalysis.recommendation} (Entropy: ${securityAnalysis.entropy})`
    );
  }

  await passwordHistoryService.checkPasswordHistory(
    userID,
    newPassword,
    context
  );
  const newPasswordHash = await authService.updateUserPassword(
    userID,
    oldPassword,
    newPassword,
    context
  );

  if (!newPasswordHash)
    throw new InternalServerError("Auth service failure during rotation.");

  await passwordHistoryService.saveNewPasswordHash(
    userID,
    newPasswordHash,
    context
  );
  auditLog({
    level: "CRITICAL",
    event: "PASSWORD_CHANGED",
    userId: userID,
    entropyScore: securityAnalysis.entropy,
    ...context,
  });
};

const initiateAccountDeletion = async (userID, ip) => {
  // Instead of just logging, we ensure the Compliance Job is queued
  await queueClient.send("COMPLIANCE_ERASURE_TASK", {
    userId: userID,
    reason: "User Self-Deletion",
    initiatedBy: "USER",
    ip,
  });

  auditLog({
    level: "CRITICAL",
    event: "ACCOUNT_DELETION_INITIATED",
    userId: userID,
  });
};

/* ===========================
 * 🔒 SESSION MANAGEMENT LOGIC
 * =========================== */

const revokeUserSession = async (userID, sessionId, ip) => {
  const session = await Session.findOne({
    _id: sessionId,
    user: userID,
  }).lean();
  if (!session) throw new NotFoundError("Session not found.");

  await authService.revokeSessionAndCleanup({
    refreshToken: session.refreshToken,
    userId: userID,
    context: { ip, type: "SPECIFIC_SESSION_REVOKED" },
  });
};

const getSessions = async (userID, queryParams) => {
  const {
    page,
    limit: limitCount,
    skip,
  } = getPaginationParams(queryParams, 10);
  const [sessions, total] = await Promise.all([
    limit(() =>
      Session.find({ user: userID })
        .skip(skip)
        .limit(limitCount)
        .sort({ createdAt: -1 })
        .lean()
    ),
    limit(() => Session.countDocuments({ user: userID })),
  ]);

  return {
    count: sessions.length,
    total,
    page,
    pages: Math.ceil(total / limitCount),
    sessions,
  };
};

/**
 * @desc ZENITH CONSOLIDATED REVOCATION
 * Handles database versioning and physical session wiping in Redis.
 */
const revokeAllUserSessions = async (
  userID,
  adminId,
  reason,
  ip,
  userAgent
) => {
  return await Tracing.withSpan("identity.revokeAllSessions", async (span) => {
    const redis = getRedisClient();

    // 1. REDIS LAYER: Physical Wipe in a Single Pipeline
    // We clear challenges, session metadata, MFA state, and lockout status.
    const pipeline = redis.pipeline();
    pipeline.del(`auth:webauthn:challenge:${userID}`);
    pipeline.del(`sessions:${userID}`);
    pipeline.del(`mfa:state:${userID}`);
    pipeline.del(`rate-limit:auth:${userID}`);

    // Execute all commands in one network round-trip
    const redisResults = await pipeline.exec();

    // Optional: Log if any Redis command failed (ioredis returns [[err, res], ...])
    const errors = redisResults.filter(([err]) => err !== null);
    if (errors.length > 0) {
      Logger.warn("PARTIAL_REDIS_WIPE_FAILURE", { userID, errors });
    }

    // 2. DATABASE LAYER: Increment Security Version
    // This "Kill Switch" invalidates all stateless JWTs instantly.
    const updatedUser = await User.findByIdAndUpdate(
      userID,
      {
        $inc: { securityVersion: 1 },
        $push: {
          securityAudit: {
            event: "ALL_SESSIONS_REVOKED",
            admin: adminId,
            reason,
            ip,
            ts: new Date(),
          },
        },
      },
      {
        new: true,
        select: "securityVersion", // Projection: ignore heavy PII fields
        runValidators: true,
      }
    );

    if (!updatedUser)
      throw new NotFoundError("User not found during revocation.");

    // 3. AUDIT LOGGING
    AuditLogger.log({
      level: "CRITICAL",
      event: "ALL_SESSIONS_REVOKED",
      userId: userID,
      details: { adminId, ip, newVersion: updatedUser.securityVersion },
    });

    return {
      success: true,
      newVersion: updatedUser.securityVersion,
    };
  });
};

/* ===========================
 * 🏡 ADDRESS & 💳 PAYMENT DEFAULTS
 * =========================== */

const setDefaultAddress = async (userID, addressId) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await Address.updateMany(
      { user: userID, isDefault: true },
      { isDefault: false },
      { session }
    );
    const updated = await Address.findOneAndUpdate(
      { _id: addressId, user: userID },
      { isDefault: true },
      { new: true, session }
    ).lean();
    if (!updated) throw new NotFoundError("Address not found.");
    await session.commitTransaction();
    return updated;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const setDefaultPaymentMethod = async (userID, methodId) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await PaymentMethod.updateMany(
      { user: userID, isDefault: true },
      { isDefault: false },
      { session }
    );
    const updated = await PaymentMethod.findOneAndUpdate(
      { _id: methodId, user: userID },
      { isDefault: true },
      { new: true, session }
    ).lean();
    if (!updated) throw new NotFoundError("Payment method not found.");
    await session.commitTransaction();
    return updated;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

/* ===========================
 * ❤️ WISHLIST LOGIC
 * =========================== */

const getWishlist = async (userID, queryParams) => {
  const {
    page,
    limit: limitCount,
    skip,
  } = getPaginationParams(queryParams, 20);
  const [wishlist, total] = await Promise.all([
    limit(() =>
      WishlistItem.find({ user: userID })
        .skip(skip)
        .limit(limitCount)
        .sort({ createdAt: -1 })
        .populate({
          path: "product",
          select: "name price imageUrl slug stockQuantity",
        })
        .lean()
    ),
    limit(() => WishlistItem.countDocuments({ user: userID })),
  ]);
  return {
    count: wishlist.length,
    wishlist,
    pagination: {
      page,
      limit: limitCount,
      total,
      pages: Math.ceil(total / limitCount),
    },
  };
};

const addToWishlist = async (userID, productId) => {
  const result = await WishlistItem.findOneAndUpdate(
    { user: userID, product: productId },
    { $setOnInsert: { user: userID, product: productId } },
    { upsert: true, new: true, rawResult: true, setDefaultsOnInsert: true }
  )
    .populate({ path: "product", select: "name price" })
    .lean();

  if (result.lastErrorObject?.updatedExisting)
    throw new BadRequestError("Product already in wishlist.");
  queueClient.send("WISHLIST_EVENT", {
    type: "ITEM_ADDED",
    userId: userID,
    productId,
  });
  return result;
};

const removeFromWishlist = async (userID, itemId) => {
  const deleted = await WishlistItem.findOneAndDelete({
    _id: itemId,
    user: userID,
  });
  if (!deleted) throw new NotFoundError("Wishlist item not found.");
  queueClient.send("WISHLIST_EVENT", {
    type: "ITEM_REMOVED",
    userId: userID,
    productId: deleted.product.toString(),
  });
};

/* ===========================
 * 💵 PAYMENTS & RECEIPTS
 * =========================== */

const getUserPayments = async (userID, queryParams) => {
  const {
    page,
    limit: limitCount,
    skip,
  } = getPaginationParams(queryParams, 10);
  const [payments, total] = await Promise.all([
    limit(() =>
      Payment.find({ user: userID })
        .skip(skip)
        .limit(limitCount)
        .sort({ createdAt: -1 })
        .lean()
    ),
    limit(() => Payment.countDocuments({ user: userID })),
  ]);
  return {
    count: payments.length,
    payments,
    pagination: {
      page,
      limit: limitCount,
      total,
      pages: Math.ceil(total / limitCount),
    },
  };
};

const generateReceipt = async (userID, paymentId) => {
  const payment = await Payment.findOne({ _id: paymentId, user: userID })
    .populate("order")
    .lean();
  if (!payment) throw new NotFoundError("Payment not found.");

  // PDF generation logic remains in the service to keep controller thin
  const fileName = `receipt-${paymentId}.pdf`;
  const filePath = `./temp/${fileName}`; // In production, use a secure temp dir or S3

  const doc = new pdf();
  doc.pipe(fs.createWriteStream(filePath));
  doc
    .fontSize(20)
    .text("Zenith Enterprise Receipt", { align: "center" })
    .moveDown();
  doc.fontSize(12).text(`Payment ID: ${payment._id}`);
  doc.text(`Amount: $${payment.amount.toFixed(2)}`);
  doc.text(`Date: ${payment.createdAt.toDateString()}`);
  doc.end();

  return { filePath, fileName };
};

/* ===========================
 * ✅ EXPORTS (Zenith Bundle)
 * =========================== */
module.exports = {
  // High-Assurance Security
  getUserCredentials,
  globalPanicRevocation,
  // Dashboard & Profile
  fetchUserDashboard,
  updateUserProfile,
  changePasswordUser: changeUserPassword,
  initiateAccountDeletion,
  // Sessions
  revokeUserSession,
  getSessions,
  revokeAllUserSessions,
  // Defaults
  setDefaultAddress,
  setDefaultPaymentMethod,
  // Wishlist
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  // Payments
  getUserPayments,
  generateReceipt,
};
