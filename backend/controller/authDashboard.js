/* ===========================
 * 📦 Dependencies
 * =========================== */
const { StatusCodes } = require("http-status-codes");
const asyncHandler = require("../middleware/asyncHandler");
const BadRequestError = require("../errors/bad-request-error");
const passport = require("passport");
const fs = require("fs");

// Service Layer
const userService = require("../services/userService");
const webAuthnService = require("../services/WebAuthnSecurityService");
const { blacklistToken } = require("../services/tokenRevocationService");
const Logger = require("../utils/logger");

// Enterprise Cookie Configuration
const {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  COOKIE_OPTIONS_ACCESS,
  COOKIE_OPTIONS_REFRESH,
  COOKIE_OPTIONS_CSRF,
} = require("../config/cookieConfig");

/* ===========================
 * 🔐 SECURITY: AUTH & SESSION
 * =========================== */



/* ===========================
 * 🔐 SECURITY: WEBAUTHN / STEP-UP
 * =========================== */

/**
 * @desc Step 1: Generate FIDO2 assertion options for biometric challenge
 * Access: Private (Requires session)
 */
const getStepUpOptions = asyncHandler(async (req, res) => {
  const userId = req.user.userID;

  const userCredentials = await userService.getUserCredentials(userId);
  const options = await webAuthnService.getAssertionOptions(
    userId,
    userCredentials
  );

  Logger.info("STEP_UP_OPTIONS_GENERATED", { userId });
  res.status(StatusCodes.OK).json(options);
});

/**
 * @desc Step 2: Finalize the Step-Up process via Passport Strategy
 */
const finalizeStepUp = (req, res, next) => {
  passport.authenticate("webauthn-stepup", (err, user, info) => {
    if (err) return next(err);

    if (!user) {
      return res.status(StatusCodes.UNAUTHORIZED).json({
        success: false,
        message: info?.message || "Biometric verification failed",
      });
    }

    res.status(StatusCodes.OK).json({
      success: true,
      message: "Identity verified. High-assurance session active.",
    });
  })(req, res, next);
};

/* ===========================
 * 📊 USER DASHBOARD & PROFILE
 * =========================== */

const getUserDashboard = asyncHandler(async (req, res) => {
  const dashboardData = await userService.fetchUserDashboard(
    req.user.userID,
    req.query
  );
  res.status(StatusCodes.OK).json(dashboardData);
});

const updateProfile = asyncHandler(async (req, res) => {
  const { username, email, phone } = req.body;
  const userID = req.user.userID;

  const updateData = {
    ...(username && { username }),
    ...(email && { email }),
    ...(phone && { phone }),
  };

  if (Object.keys(updateData).length === 0)
    throw new BadRequestError("At least one field is required for update.");

  const updatedUser = await userService.updateUserProfile(userID, updateData);
  res.status(StatusCodes.OK).json({
    message: "Profile updated successfully",
    user: updatedUser,
  });
});

const changePassword = asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const userID = req.user.userID;

  if (!oldPassword || !newPassword)
    throw new BadRequestError("Both old and new passwords are required.");

  await userService.changeUserPassword(userID, oldPassword, newPassword);
  res.status(StatusCodes.OK).json({
    message:
      "Password updated successfully. All other active sessions have been logged out.",
  });
});

/* ===========================
 * 🛠️ ACCOUNT & SESSION MANAGEMENT
 * =========================== */

const deleteAccount = asyncHandler(async (req, res) => {
  await userService.initiateAccountDeletion(req.user.userID, req.ip);

  // Clear cookies upon account deletion initiation
  res.clearCookie(ACCESS_COOKIE_NAME, COOKIE_OPTIONS_ACCESS);
  res.clearCookie(REFRESH_COOKIE_NAME, COOKIE_OPTIONS_REFRESH);
  res.clearCookie(CSRF_COOKIE_NAME, COOKIE_OPTIONS_CSRF);

  res
    .status(StatusCodes.ACCEPTED)
    .json({ message: "Account deletion initiated." });
});

const revokeSession = asyncHandler(async (req, res) => {
  await userService.revokeUserSession(
    req.user.userID,
    req.params.sessionId,
    req.ip
  );
  res.status(StatusCodes.OK).json({ message: "Session revoked successfully" });
});

const getSessions = asyncHandler(async (req, res) => {
  const sessionsData = await userService.getSessions(
    req.user.userID,
    req.query
  );
  res.status(StatusCodes.OK).json(sessionsData);
});

/**
 * @desc ZENITH CONTROLLER: Global Revocation
 */
const revokeAllSessions = asyncHandler(async (req, res) => {
  const targetUserId = req.params.id || req.user.userID;
  const adminId = req.user.userID;
  const reason = req.body.reason || "User initiated global logout";
  const ip = req.ip;
  const userAgent = req.get("User-Agent");

  const result = await userService.revokeAllUserSessions(
    targetUserId,
    adminId,
    reason,
    ip,
    userAgent
  );

  res.status(StatusCodes.OK).json({
    success: true,
    message: "Global session revocation successful. All tokens invalidated.",
    securityVersion: result.newVersion,
  });
});

/* ===========================
 * 📦 DEFAULTS & WISHLIST
 * =========================== */

const setDefaultAddress = asyncHandler(async (req, res) => {
  const updatedAddress = await userService.setDefaultAddress(
    req.user.userID,
    req.params.id
  );
  res.status(StatusCodes.OK).json({
    message: "Default address set successfully",
    address: updatedAddress,
  });
});

const setDefaultPaymentMethod = asyncHandler(async (req, res) => {
  const updatedMethod = await userService.setDefaultPaymentMethod(
    req.user.userID,
    req.params.id
  );
  res.status(StatusCodes.OK).json({
    message: "Default payment method set successfully",
    method: updatedMethod,
  });
});

const getWishlist = asyncHandler(async (req, res) => {
  const wishlistData = await userService.getWishlist(
    req.user.userID,
    req.query
  );
  res.status(StatusCodes.OK).json(wishlistData);
});

const addToWishlist = asyncHandler(async (req, res) => {
  if (!req.body.productId) throw new BadRequestError("Product ID is required.");
  const wishlistItem = await userService.addToWishlist(
    req.user.userID,
    req.body.productId
  );
  res.status(StatusCodes.CREATED).json({
    message: "Added to wishlist",
    wishlistItem,
  });
});

const removeFromWishlist = asyncHandler(async (req, res) => {
  await userService.removeFromWishlist(req.user.userID, req.params.id);
  res.status(StatusCodes.OK).json({ message: "Removed from wishlist" });
});

/* ===========================
 * 📑 PAYMENTS & RECEIPTS
 * =========================== */

const downloadReceipt = asyncHandler(async (req, res) => {
  const { filePath, fileName } = await userService.generateReceipt(
    req.user.userID,
    req.params.id
  );

  res.download(filePath, fileName, (err) => {
    fs.unlink(filePath, (uErr) => {
      if (uErr) Logger.error("TEMP_FILE_CLEANUP_FAIL", { path: filePath });
    });
    if (err && !res.headersSent)
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).send("Download failed.");
  });
});

const getUserPayments = asyncHandler(async (req, res) => {
  const paymentsData = await userService.getUserPayments(
    req.user.userID,
    req.query
  );
  res.status(StatusCodes.OK).json(paymentsData);
});

/* ===========================
 * ✅ EXPORTS
 * =========================== */
module.exports = {
  
  getStepUpOptions,
  finalizeStepUp,
  getUserDashboard,
  updateProfile,
  changePassword,
  deleteAccount,
  revokeSession,
  revokeAllSessions,
  getSessions,
  setDefaultAddress,
  setDefaultPaymentMethod,
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  getUserPayments,
  downloadReceipt,
};