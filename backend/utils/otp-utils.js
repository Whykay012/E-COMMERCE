// utils/otp-util.js
const crypto = require("crypto");

function generateOTP() {
  const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
  const hashedOTP = crypto.createHash("sha256").update(otp).digest("hex");
  return { otp, hashedOTP };
}

module.exports = generateOTP;
