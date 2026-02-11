"use strict";

/**
 * COSMOS HYPER-FABRIC: Password History Service
 * ---------------------------------------------
 * Manages credential hygiene by preventing password reuse and enforcing 
 * historical rotation policies across different user roles.
 */

const bcrypt = require("bcryptjs");
const PasswordHistory = require("../model/passwordHistory");
const User = require("../model/userModel");
const BadRequestError = require("../errors/bad-request-error");
const auditLogger = require("./auditLogger");
const securityPolicy = require("../utils/securityPolicyUtils"); 
const pLimit = require("p-limit");

// 💡 Concurrency Semaphore: Prevents CPU spikes during mass bcrypt comparisons
const COMPARISON_CONCURRENCY_LIMIT = 5;
const compareLimit = pLimit(COMPARISON_CONCURRENCY_LIMIT);

/**
 * Checks if the new password has been used recently or matches the current password.
 * Uses bounded concurrency for hash comparisons to manage CPU load.
 * * @param {string} userId - ID of the user (MongoDB ObjectId).
 * @param {string} newPassword - The clear-text new password provided by the user.
 * @param {Object} [context={}] - Optional: { traceId } for audit trail continuity.
 * @throws {BadRequestError} If the password is found in history or matches current.
 * @returns {Promise<void>}
 */
exports.checkPasswordHistory = async (userId, newPassword, context = {}) => {
  if (!newPassword) {
    throw new BadRequestError("New password cannot be empty.");
  }

  // 1. Fetch current hash and role (Role is required to fetch correct security policy)
  const user = await User.findById(userId).select("password role").lean();

  if (!user || !user.password) {
    auditLogger.dispatchLog({
      level: "ERROR",
      event: "PASSWORD_CHECK_FAILED",
      userId,
      details: "User or current password hash not found.",
      traceId: context.traceId,
    });
    throw new BadRequestError("Invalid user operation.");
  }

  // 2. Fetch policy dynamically based on user role (e.g., Admin might have higher history count)
  const MAX_HISTORY_COUNT = securityPolicy.getMaxPasswordHistoryCount(user.role);

  // 3. Fetch historical hashes (DB reads are fast)
  const history = await PasswordHistory.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(MAX_HISTORY_COUNT)
    .select("passwordHash")
    .lean();

  // 4. Prepare comparison tasks using the bounded concurrency limiter
  const comparisonTasks = [];

  // Task A: Check against current password
  comparisonTasks.push(
    compareLimit(() =>
      bcrypt.compare(newPassword, user.password).then((isMatch) => ({
        type: "current",
        isMatch,
      }))
    )
  );

  // Task B: Check against historical passwords
  history.forEach((record) => {
    comparisonTasks.push(
      compareLimit(() =>
        bcrypt.compare(newPassword, record.passwordHash).then((isMatch) => ({
          type: "history",
          isMatch,
        }))
      )
    );
  });

  // 5. Execute all comparisons (Limiter protects the Event Loop)
  const results = await Promise.all(comparisonTasks);

  // 6. Analyze results (Fail-fast principle)
  for (const result of results) {
    if (result.isMatch) {
      const message =
        result.type === "current"
          ? "New password must be different from your current password."
          : `This password was used recently. You cannot reuse any of your last ${MAX_HISTORY_COUNT} passwords.`;

      auditLogger.dispatchLog({
        level: "WARN",
        event: "PASSWORD_REUSE_BLOCKED",
        userId,
        details: message,
        traceId: context.traceId,
      });
      throw new BadRequestError(message);
    }
  }

  // Success: Password is clean
};

/**
 * Saves the new password hash to history and triggers cleanup.
 * * @param {string} userId - ID of the user.
 * @param {string} newPasswordHash - The pre-hashed new password.
 * @param {Object} [context={}] - Optional tracing metadata.
 * @returns {Promise<void>}
 */
exports.saveNewPasswordHash = async (userId, newPasswordHash, context = {}) => {
  try {
    // Determine policy for cleanup
    const user = await User.findById(userId).select("role").lean();
    const MAX_HISTORY_COUNT = securityPolicy.getMaxPasswordHistoryCount(user?.role || 'user');

    // 1. Save new hash
    await PasswordHistory.create({
      user: userId,
      passwordHash: newPasswordHash,
      createdAt: new Date(),
    });

    // 2. Enforce limit (Non-blocking cleanup)
    this.enforceHistoryLimit(userId, MAX_HISTORY_COUNT, context).catch((err) => {
      auditLogger.dispatchLog({
        level: "ERROR",
        event: "HISTORY_CLEANUP_FAIL",
        userId,
        details: `Async cleanup failed: ${err.message}`,
        traceId: context.traceId,
      });
    });

  } catch (error) {
    auditLogger.dispatchLog({
      level: "CRITICAL",
      event: "PASSWORD_HISTORY_FAIL",
      userId,
      details: `Failed to save new hash: ${error.message}`,
      traceId: context.traceId,
    });
  }
};

/**
 * Internally cleans up older password history records beyond the allowed limit.
 * * @param {string} userId - ID of the user.
 * @param {number} maxCount - The maximum number of records to retain.
 * @param {Object} [context={}] - Optional tracing metadata.
 * @returns {Promise<void>}
 */
exports.enforceHistoryLimit = async (userId, maxCount, context = {}) => {
  // Identify records that exceed the 'maxCount' window
  const recordsToPrune = await PasswordHistory.find({ user: userId })
    .sort({ createdAt: -1 })
    .skip(maxCount)
    .select("_id")
    .lean();

  if (recordsToPrune.length > 0) {
    const idsToDelete = recordsToPrune.map(rec => rec._id);
    const result = await PasswordHistory.deleteMany({ _id: { $in: idsToDelete } });

    auditLogger.dispatchLog({
      level: "DEBUG",
      event: "PASSWORD_HISTORY_CLEANUP",
      userId,
      details: `Deleted ${result.deletedCount} old records.`,
      traceId: context.traceId,
    });
  }
};