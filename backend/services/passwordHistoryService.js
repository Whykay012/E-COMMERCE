// services/passwordHistoryService.js

/* ===========================
 * 📦 Dependencies (Models, Utils, Config)
 * =========================== */
const bcrypt = require("bcryptjs");
const PasswordHistory = require("../model/PasswordHistoryModel");
const User = require("../model/userModel");
const BadRequestError = require("../errors/bad-request-error");
const auditLogger = require("./auditLogger");
const securityPolicy = require("../utils/securityPolicyUtils"); // 💡 UPGRADE 1: Centralized, cross-service policy fetching
const pLimit = require("p-limit");

// 💡 Concurrency Semaphore for CPU-intensive bcrypt comparisons
// Limits the number of simultaneous comparison promises to prevent event loop starvation.
const COMPARISON_CONCURRENCY_LIMIT = 5;
const compareLimit = pLimit(COMPARISON_CONCURRENCY_LIMIT);

//

/* ===========================
 * 🔒 SECURITY LOGIC (Apex Optimisation)
 * =========================== */

/**
 * Checks if the new password has been used recently or matches the current password.
 * Uses bounded concurrency for hash comparisons to manage CPU load.
 * * @param {string} userId - ID of the user.
 * @param {string} newPassword - The clear-text new password provided by the user.
 * @param {object} context - Optional: { traceId } for better logging.
 * @throws {BadRequestError} If the password is found in history or matches current.
 */
exports.checkPasswordHistory = async (userId, newPassword, context = {}) => {
  // Fetch policy dynamically
  const MAX_HISTORY_COUNT = securityPolicy.getMaxPasswordHistoryCount(
    user.role
  );

  if (!newPassword) {
    throw new BadRequestError("New password cannot be empty.");
  }

  // 1. Fetch current hash and historical hashes concurrently (DB reads are fast)
  const [user, history] = await Promise.all([
    User.findById(userId).select("password").lean(),
    PasswordHistory.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(MAX_HISTORY_COUNT)
      .select("passwordHash")
      .lean(),
  ]);

  if (!user || !user.password) {
    // Log a high-severity event for a missing user record
    // 🎯 FIXED: Removed 'await'
    auditLogger.dispatchLog({
      level: "ERROR",
      event: "PASSWORD_CHECK_FAILED",
      userId,
      details: "User or current password hash not found.",
      traceId: context.traceId,
    });
    throw new BadRequestError("Invalid user operation.");
  }

  // 2. Prepare all hash comparison tasks using the bounded concurrency limiter
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

  // 3. Execute all comparisons (The limiter protects the event loop from being blocked by too many CPU tasks)
  const results = await Promise.all(comparisonTasks);
  //

  // 4. Analyze results (Fail-fast principle)
  for (const result of results) {
    if (result.isMatch) {
      const message =
        result.type === "current"
          ? "New password must be different from your current password."
          : `This password was used recently. You cannot reuse any of your last ${MAX_HISTORY_COUNT} passwords.`;

      // 🎯 FIXED: Removed 'await'
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

  // Success: Password is new
};

/**
 * Saves the new password hash to the history collection and enforces the history limit.
 * NOTE: Assumes the authService passes the HASH, avoiding re-hashing the clear-text password.
 * * @param {string} userId - ID of the user.
 * @param {string} newPasswordHash - The new password hash (output from authService/bcrypt).
 * @param {object} context - Optional: { traceId } for better logging.
 */
exports.saveNewPasswordHash = async (userId, newPasswordHash, context = {}) => {
  // Fetch policy dynamically
  const MAX_HISTORY_COUNT = securityPolicy.getMaxPasswordHistoryCount();

  try {
    // 1. Save the new hash to history (Fast, single DB write)
    await PasswordHistory.create({
      user: userId,
      passwordHash: newPasswordHash,
      createdAt: new Date(),
    });

    // 2. Enforce limit (Cleanup old history records - fire-and-forget, non-blocking)
    this.enforceHistoryLimit(userId, MAX_HISTORY_COUNT, context).catch(
      (err) => {
        console.error(
          `[CRITICAL] Async history cleanup failed for user ${userId}:`,
          err
        );
        // 🎯 FIXED: Removed 'await'
        auditLogger.dispatchLog({
          level: "ERROR",
          event: "HISTORY_CLEANUP_FAIL",
          userId,
          details: `Error cleaning history: ${err.message}`,
          traceId: context.traceId,
        });
      }
    );
  } catch (error) {
    console.error(
      `[CRITICAL] Error saving password hash to history for user ${userId}:`,
      error
    );
    // 🎯 FIXED: Removed 'await'
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
 * Internal function to clean up older password history records beyond the limit.
 * Efficiently uses MongoDB query optimisations.
 * @param {string} userId - ID of the user.
 * @param {number} maxCount - The maximum number of records to keep.
 * @param {object} context - Optional: { traceId }
 */
exports.enforceHistoryLimit = async (userId, maxCount, context = {}) => {
  // Find the oldest record that should be kept (the MAX_HISTORY_COUNT-th newest record)
  const recordToKeep = await PasswordHistory.find({ user: userId })
    .sort({ createdAt: -1 })
    .skip(maxCount)
    .limit(1)
    .select("createdAt")
    .lean();

  if (recordToKeep.length > 0) {
    const cutOffDate = recordToKeep[0].createdAt;

    // Delete all records older than or equal to the cutOffDate in one query
    const result = await PasswordHistory.deleteMany({
      user: userId,
      createdAt: { $lte: cutOffDate },
    });

    // 🎯 FIXED: Removed 'await'
    auditLogger.dispatchLog({
      level: "DEBUG",
      event: "PASSWORD_HISTORY_CLEANUP",
      userId,
      details: `Deleted ${result.deletedCount} old records.`,
      traceId: context.traceId,
    });
  }
};
