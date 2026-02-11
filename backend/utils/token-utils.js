const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { BadRequestError } = require("../errors/bad-request-error");

/**
 * @desc Consistent hashing for sensitive lookup tokens (Verification, OTP, Password Reset).
 * Used to securely store tokens in the database without storing them in plain text.
 */
const hashToken = (token) => {
  if (!token) return null;
  return crypto.createHash("sha256").update(token).digest("hex");
};

/**
 * @desc Generates a short-lived Access Token bound to the current security version.
 */
const generateAccessToken = (user) => {
  // Use a random JTI for individual token blacklisting if needed
  const jti = crypto.randomBytes(16).toString("hex");

  return jwt.sign(
    {
      userID: user._id,
      role: user.role,
      version: user.securityVersion || 0, // 🚀 Bind to Global Panic state
      jti,
    },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRE || "15m" },
  );
};

/**
 * @desc Verifies the Access Token.
 * Note: Uses ACCESS_SECRET, not the generic secret.
 */
const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
  } catch (err) {
    // Distinguish between expired and tampered for better frontend UX
    const message =
      err.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
    throw new BadRequestError(message);
  }
};

/**
 * @desc Generates a long-lived Refresh Token with session metadata.
 */
const generateRefreshToken = (user, sessionData = {}) => {
  const jti = crypto.randomBytes(24).toString("hex");

  return jwt.sign(
    {
      userID: user._id,
      version: user.securityVersion || 0,
      jti,
      // sessionData can include ip, userAgent, or deviceName for rotation tracking
      ...sessionData,
    },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRE || "7d" },
  );
};

/**
 * @desc Verifies the Refresh Token using the specific Refresh Secret.
 */
const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch (err) {
    throw new BadRequestError("Refresh session expired or invalid");
  }
};

module.exports = {
  hashToken, // 🚀 Exported for use in User model and Auth services
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
};
