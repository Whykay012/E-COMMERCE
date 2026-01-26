const User = require("../model/userModel");
const BadRequestError = require("../errors/bad-request-error");
const generateOTP = require("../utils/otp-utils");
const sendEmail = require("../utils/sendEmail");
const crypto = require("crypto");
const { StatusCodes } = require("http-status-codes");

const resendOtp = async (req, res) => {
  const { token } = req.params;
  const ip = req.ip;
  const userAgent = req.headers["user-agent"];

  if (!token) throw new BadRequestError("Verification token is missing");

  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const user = await User.findOne({ verificationToken: hashedToken });
  if (!user) throw new BadRequestError("Invalid verification token");

  if (user.isVerified) {
    throw new BadRequestError("Your account is already verified");
  }

  // --- Rate Limiting Logic (No changes needed, this is solid) ---
  const RATE_WINDOW = 10 * 60 * 1000;
  const MAX_RESENDS = 3;

  if (user.lastResendAt) {
    const timeDifference = Date.now() - user.lastResendAt.getTime();
    if (timeDifference < RATE_WINDOW) {
      if (user.resendCount >= MAX_RESENDS) {
        throw new BadRequestError(
          "You have reached the maximum OTP resend attempts. Try again later."
        );
      }
    } else {
      user.resendCount = 0;
    }
  }

  user.resendCount += 1;
  user.lastResendAt = new Date();
  user.lastIp = ip;
  user.lastUserAgent = userAgent;

  // --- Generate NEW OTP + Token ---
  const { otp, hashedOTP } = generateOTP();
  const rawNewToken = crypto.randomBytes(32).toString("hex");
  const hashedNewToken = crypto
    .createHash("sha256")
    .update(rawNewToken)
    .digest("hex");

  user.otp = hashedOTP;
  user.otpExpiry = Date.now() + 10 * 60 * 1000;
  user.verificationToken = hashedNewToken;
  user.verificationExpires = Date.now() + 10 * 60 * 1000;

  await user.save();

  // ==========================================
  // 📧 UPGRADED EMAIL DISPATCH
  // ==========================================
  await sendEmail({
    to: user.email,
    subject: "Your New OTP Code",
    priority: "high", // 🔥 CRITICAL: Forces use of Postmark/SendGrid SDK
    text: `Your new OTP is ${otp}. It expires in 10 minutes.`,
    htmlTemplatePath: "emails/verify-otp-email.html",
    placeholders: {
      OTP: otp,
      EMAIL: user.email,
      COMPANY: process.env.COMPANY_NAME || "Zenith", // Use ENV for brand consistency
      YEAR: new Date().getFullYear(),
    },
  });

  return res.status(StatusCodes.OK).json({
    message: "A new OTP has been sent to your email.",
    token: rawNewToken,
  });
};

module.exports = resendOtp;
