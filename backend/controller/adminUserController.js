/* ===========================
 * 📦 Dependencies
 * =========================== */
const { StatusCodes } = require("http-status-codes");
const asyncHandler = require("../middleware/asyncHandler");
const AdminUserService = require("../services/adminUserService");
const userService = require("../services/userService");
const Logger = require("../utils/logger");
const {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
} = require("../errors/customErrors");

/**
 * Controller for all administrative User Management functions.
 * Includes Zenith Enterprise Emergency Lockdown (Panic Room) functionality.
 */

/* ===========================================================
 * 🚨 SECURITY: EMERGENCY LOCKDOWN (PANIC ROOM)
 * =========================================================== */

/**
 * @desc Emergency Global Revocation (Admin Only)
 * @access Private (Super-Admin level)
 * @logic Increments securityVersion, logs critical audit via Zenith Purge.
 */
exports.emergencyUserLockdown = asyncHandler(async (req, res) => {
  const { targetUserId, reason } = req.body;
  const adminId = req.user.userID;

  if (!targetUserId) {
    throw new BadRequestError("Target User ID is required for lockdown.");
  }

  // ⭐ ZENITH CORE: This service triggers both DB versioning and Redis LUA purge
  const updatedUser = await userService.globalPanicRevocation(
    targetUserId,
    adminId,
    reason || "Administrative Security Reset",
    req.ip
  );

  Logger.critical("ADMIN_EMERGENCY_LOCKDOWN_EXECUTED", {
    adminId,
    targetUserId,
    newVersion: updatedUser.securityVersion,
    reason,
    ip: req.ip,
  });

  res.status(StatusCodes.OK).json({
    success: true,
    message: `Panic Room: Global revocation completed. All active tokens for User ${targetUserId} are now invalid.`,
    data: {
      userId: targetUserId,
      newSecurityVersion: updatedUser.securityVersion,
      timestamp: new Date(),
    },
  });
});

/* ===========================================================
 * 📊 USER MANAGEMENT: LIST & READ
 * =========================================================== */

exports.getAllUsers = asyncHandler(async (req, res) => {
  const usersData = await AdminUserService.getFilteredUsers(req.query);
  res.status(StatusCodes.OK).json({
    success: true,
    message: "Users retrieved successfully.",
    ...usersData,
  });
});

exports.getUserDetails = asyncHandler(async (req, res) => {
  const user = await AdminUserService.getUserDetails(req.params.id);
  res.status(StatusCodes.OK).json({
    success: true,
    message: "User details retrieved successfully.",
    user,
  });
});

/* ===========================================================
 * 🛠️ USER MANAGEMENT: UPDATES & ROLES
 * =========================================================== */

exports.updateUserRole = asyncHandler(async (req, res) => {
  const { role } = req.body;
  const user = await AdminUserService.updateUserRole(
    req.params.id,
    role,
    req.user.userID
  );

  res.status(StatusCodes.OK).json({
    success: true,
    message: `User role updated to ${user.role} successfully.`,
    user: { id: user._id, role: user.role, email: user.email },
  });
});

exports.toggleUserStatus = asyncHandler(async (req, res) => {
  const { isActive } = req.body; // Unified boolean

  if (typeof isActive !== "boolean") {
    throw new BadRequestError("Status must be a boolean value (true/false).");
  }

  const user = await AdminUserService.toggleUserStatus(
    req.params.id,
    isActive,
    req.user.userID
  );

  res.status(StatusCodes.OK).json({
    success: true,
    message: `User account set to ${
      isActive ? "Active" : "Inactive (Banned)"
    } successfully.`,
    user: { id: user._id, isActive: user.isActive, email: user.email },
  });
});

/* ===========================================================
 * 🗑️ USER MANAGEMENT: DELETION
 * =========================================================== */

exports.softDeleteUser = asyncHandler(async (req, res) => {
  const user = await AdminUserService.toggleSoftDeletion(
    req.params.id,
    true,
    req.user.userID
  );

  res.status(StatusCodes.OK).json({
    success: true,
    message: `User account for ${user.email} soft-deleted successfully.`,
    userId: user._id,
    isDeleted: user.isDeleted,
  });
});

exports.hardDeleteUser = asyncHandler(async (req, res) => {
  if (req.user.role !== "admin") {
    throw new ForbiddenError(
      "Only Super Administrators can perform permanent deletion."
    );
  }

  await AdminUserService.hardDeleteUser(req.params.id, req.user.userID);

  res.status(StatusCodes.OK).json({
    success: true,
    message: "User permanently deleted from the database.",
  });
});
