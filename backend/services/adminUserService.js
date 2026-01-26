/**
 * services/adminUser.service.js
 * ZENITH APEX - Extreme-Reliability Admin Orchestrator
 * Logic: Internal Audit Schema, Unified isActive Naming, and Atomic Revocation.
 */

const User = require("../model/userModel");
const { NotFoundError } = require("../errors/notFoundError");
const mongoose = require("mongoose");
const { Schema, model } = mongoose;

// --- Telemetry & Security Dependencies ---
const Tracing = require("./tracingClient");
const Metrics = require("./metricsClient");
const Logger = require("./logger");
const { purgeAllUserState } = require("../services/tokenRevocationService");

/* ===========================================================
 * INTERNAL AUDIT LOGGING (Unified Trail)
 * =========================================================== */

const AuditLogSchema = new Schema({
  adminId: { type: String, required: true },
  targetUserId: { type: Schema.Types.ObjectId, required: true, index: true },
  action: {
    type: String,
    required: true,
    enum: [
      "ROLE_UPDATE",
      "SOFT_DELETE",
      "RESTORE",
      "BAN",
      "UNBAN",
      "HARD_DELETE_INITIATED",
      "HARD_DELETE_COMPLETED",
      "SECURITY_BREACH_HANDLED",
    ],
  },
  details: { type: Object, default: {} },
  timestamp: { type: Date, default: Date.now, index: true },
});

// Avoid OverwriteModelError if this file is hot-reloaded during development
const AuditLog = mongoose.models.AuditLog || model("AuditLog", AuditLogSchema);

/* ===========================================================
 * ZENITH SECURITY ORCHESTRATION (The Nuclear Options)
 * =========================================================== */

/**
 * @desc THE NUCLEAR OPTION: Handles high-risk security breaches.
 */
exports.handleSecurityBreach = async (userId) => {
  return Tracing.withSpan("Service:handleSecurityBreach", async (span) => {
    span.setAttribute("user.id", userId.toString());
    const timer = Date.now();

    try {
      // 1. Database Level: Force account inactive and bump security version
      await User.findByIdAndUpdate(userId, {
        $inc: { securityVersion: 1 },
        isActive: false,
      });

      // 2. Redis Level: The Atomic Nuclear Purge (Sessions, MFA, Circuit Breakers)
      await purgeAllUserState(userId);

      const duration = Date.now() - timer;
      Metrics.timing("security.breach_purge_ms", duration);
      Logger.critical("USER_SHUTDOWN_COMPLETE", { userId, duration });

      // Persist to internal AuditLog
      await AuditLog.create({
        adminId: "SYSTEM_SECURITY",
        targetUserId: userId,
        action: "SECURITY_BREACH_HANDLED",
        details: { action: "NUCLEAR_PURGE", duration },
      });

      return true;
    } catch (error) {
      Logger.error("SECURITY_BREACH_PURGE_FAIL", {
        userId,
        err: error.message,
      });
      throw error;
    }
  });
};

const DataCleanupService = {
  initiateHardDeleteCleanup: async (userId) => {
    return Tracing.withSpan(
      "Service:InitiateHardDeleteCleanup",
      async (span) => {
        // Simulate background worker enqueueing
        await new Promise((resolve) => setTimeout(resolve, 50));
        Logger.warn(`CLEANUP_JOB_ENQUEUED`, { userId: userId.toString() });
        return true;
      }
    );
  },
};

/* ===========================================================
 * CORE LISTING & DETAIL RETRIEVAL
 * =========================================================== */

exports.getFilteredUsers = async (query) => {
  return Tracing.withSpan("UserService:getFilteredUsers", async (span) => {
    const { page = 1, limit = 10, status, role, search } = query;
    const skip = (page - 1) * limit;
    const filters = {};

    // Logic: Standardized status filtering for Middleware compatibility
    if (status && status !== "all") {
      if (status === "deleted") {
        filters.isDeleted = true;
      } else {
        filters.isDeleted = false;
        if (status === "active") filters.isActive = true;
        else if (status === "inactive") filters.isActive = false;
      }
    } else {
      filters.isDeleted = false;
    }

    if (role && role !== "all") filters.role = role;
    if (search) {
      filters.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const totalCount = await User.countDocuments(filters);
    const users = await User.find(filters)
      .select(
        "-password -__v -resetPasswordToken -resetPasswordExpire -loginAttempts"
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      users,
      totalCount,
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalCount / limit),
    };
  });
};

exports.getUserDetails = async (userId) => {
  return Tracing.withSpan("UserService:getUserDetails", async (span) => {
    const user = await User.findById(userId)
      .select("-password -__v -resetPasswordToken -resetPasswordExpire")
      .populate("orders", "orderId totalAmount status createdAt")
      .lean();

    if (!user || user.isDeleted)
      throw new NotFoundError(`User with ID ${userId} not found.`);

    return {
      ...user,
      lastLogin: user.lastLoginAt || "N/A",
    };
  });
};

/* ===========================================================
 * ADMINISTRATIVE ACTIONS (Zenith Integrated)
 * =========================================================== */

exports.updateUserRole = async (userId, newRole, adminId = "SYSTEM") => {
  return Tracing.withSpan("UserService:updateUserRole", async (span) => {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError(`User ID ${userId} not found.`);

    const oldRole = user.role;
    if (oldRole === newRole) return user;

    user.role = newRole;
    await user.save();

    await AuditLog.create({
      adminId,
      targetUserId: userId,
      action: "ROLE_UPDATE",
      details: { oldRole, newRole, email: user.email },
    });

    return user;
  });
};

exports.toggleSoftDeletion = async (
  userId,
  shouldDelete,
  adminId = "SYSTEM"
) => {
  const action = shouldDelete ? "SOFT_DELETE" : "RESTORE";
  return Tracing.withSpan(`UserService:${action}`, async (span) => {
    const update = {
      isDeleted: shouldDelete,
      deletedAt: shouldDelete ? new Date() : undefined,
      isActive: !shouldDelete, // Standard: Deleted users are automatically inactive
      $inc: { securityVersion: shouldDelete ? 1 : 0 },
    };

    const user = await User.findByIdAndUpdate(userId, update, { new: true });
    if (!user) throw new NotFoundError(`User ID ${userId} not found.`);

    await AuditLog.create({
      adminId,
      targetUserId: userId,
      action,
      details: { email: user.email },
    });

    if (shouldDelete) await purgeAllUserState(userId);

    return user;
  });
};

exports.toggleUserStatus = async (userId, isActive, adminId = "SYSTEM") => {
  const action = isActive ? "UNBAN" : "BAN";
  return Tracing.withSpan(`UserService:${action}`, async (span) => {
    const user = await User.findById(userId);
    if (!user) throw new NotFoundError(`User ID ${userId} not found.`);
    if (user.isActive === isActive) return user;

    user.isActive = isActive;
    // If banning, bump security version to invalidate existing JWTs
    if (!isActive) {
      user.securityVersion += 1;
      await purgeAllUserState(userId);
    }

    await user.save();

    await AuditLog.create({
      adminId,
      targetUserId: userId,
      action,
      details: { email: user.email },
    });

    return user;
  });
};

exports.hardDeleteUser = async (userId, adminId = "SYSTEM") => {
  return Tracing.withSpan("UserService:hardDeleteUser", async (span) => {
    const user = await User.findById(userId).select("email");
    if (!user) throw new NotFoundError(`User not found.`);

    // 1. Log Initiation
    await AuditLog.create({
      adminId,
      targetUserId: userId,
      action: "HARD_DELETE_INITIATED",
    });

    // 2. Trigger Background Cleanup
    await DataCleanupService.initiateHardDeleteCleanup(userId);

    // 3. Purge Security State
    await purgeAllUserState(userId);

    // 4. Atomic Database Deletion
    await User.findByIdAndDelete(userId);

    // 5. Final Audit Record
    await AuditLog.create({
      adminId,
      targetUserId: userId,
      action: "HARD_DELETE_COMPLETED",
      details: { email: user.email },
    });

    return true;
  });
};
