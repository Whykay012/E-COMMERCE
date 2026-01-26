const User = require("../model/userModel");
const { StatusCodes } = require("http-status-codes");
const BadRequestError = require("../errors/bad-request-error");
const { validationResult, matchedData } = require("express-validator");
const generateOTP = require("../utils/otp-utils");
const sendEmail = require("../utils/sendEmail");
const crypto = require("crypto");

// --- Import Enterprise Cookie Config ---
const {
  COOKIE_OPTIONS_ACCESS,
  ACCESS_COOKIE_NAME,
} = require("../config/cookieConfig");

/**
 * @desc    Register a new user with Zenith Hybrid Security
 * @route   POST /api/register
 */
const register = async (req, res) => {
  // 1. Validation & sanitization
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new BadRequestError(
      errors
        .array()
        .map((e) => e.msg)
        .join(", ")
    );
  }

  const userData = matchedData(req);
  const { email, phone, username } = userData;

  // 2. Conflict Check
  const existingUser = await User.findOne({
    $or: [{ email }, { username }, { phone }],
  });

  if (existingUser) {
    const field =
      existingUser.email === email
        ? "Email"
        : existingUser.username === username
        ? "Username"
        : "Phone number";
    throw new BadRequestError(`${field} already exists`);
  }

  // 3. Security Payload Generation
  const { otp, hashedOTP } = generateOTP();
  const rawVerificationToken = crypto.randomBytes(32).toString("hex");
  const hashedVerificationToken = crypto
    .createHash("sha256")
    .update(rawVerificationToken)
    .digest("hex");

  // Using a centralized 10-minute expiry for the registration flow
  const VERIFICATION_EXPIRY = Date.now() + 10 * 60 * 1000;

  const newUser = new User({
    ...userData,
    otp: hashedOTP,
    otpExpiry: VERIFICATION_EXPIRY,
    isVerified: false,
    verificationToken: hashedVerificationToken,
    verificationExpires: VERIFICATION_EXPIRY,
  });

  newUser.lastIp = req.ip;
  newUser.lastUserAgent = req.headers["user-agent"];
  await newUser.save();

  // 4. Hybrid Dispatch (Critical Path)
  // We don't 'await' this if we want faster response times,
  // but awaiting ensures we know the mail was accepted by the provider.
  await sendEmail({
    to: newUser.email,
    subject: "Verify Your Account",
    priority: "high", // ⚡ Triggers Postmark/SendGrid SDKs
    text: `Your OTP is ${otp}. It expires in 10 minutes.`,
    htmlTemplatePath: "emails/verify-otp-email.html",
    placeholders: {
      OTP: otp,
      EMAIL: newUser.email,
      COMPANY: process.env.COMPANY_NAME || "Zenith",
      YEAR: new Date().getFullYear(),
    },
  });

  // 5. Secure Response with Hardened Cookies
  res
    .status(StatusCodes.CREATED)
    // We use COOKIE_OPTIONS_ACCESS for the verification cookie as it
    // shares the same security profile (Short-lived, Strict/Lax)
    .cookie(ACCESS_COOKIE_NAME + "_verify", rawVerificationToken, {
      ...COOKIE_OPTIONS_ACCESS,
      maxAge: 10 * 60 * 1000, // Override to 10 mins for registration flow
    })
    .json({
      status: "success",
      message:
        "Account created. Please check your email for the verification code.",
      token: rawVerificationToken, // Provided for non-cookie clients (Mobile/Postman)
    });
};

module.exports = register;
