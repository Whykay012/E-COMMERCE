const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const winston = require("winston");

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

// -------------------------------
// Logger Setup (Winston)
// -------------------------------
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: "otp-service" },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/otp-service.log" }),
  ],
});

// -------------------------------
// OTP Configuration
// -------------------------------
const OTP_TTL = parseInt(process.env.OTP_TTL_SECONDS || "300"); // 5 min default
const OTP_LENGTH = parseInt(process.env.OTP_LENGTH || "6");
const OTP_RETRY_LIMIT = parseInt(process.env.OTP_RETRY_LIMIT || "5"); // max attempts

// -------------------------------
// Utility: Generate Random OTP
// -------------------------------
function generateRandomOtp(length = OTP_LENGTH) {
  const buffer = crypto.randomBytes(length);
  let otp = "";
  for (let i = 0; i < length; i++) {
    otp += (buffer[i] % 10).toString(); // numeric OTP
  }
  return otp;
}

// -------------------------------
// Enterprise OTP Generator
// -------------------------------
async function generateOtp(paymentId) {
  if (!paymentId) throw new Error("Payment ID required");

  const otp = generateRandomOtp();

  const key = `otp:${paymentId}`;
  const metaKey = `otp_meta:${paymentId}`;

  // Atomic multi-set in Redis
  await redis.multi()
    .set(key, otp, "EX", OTP_TTL)
    .set(metaKey, JSON.stringify({ retries: 0, createdAt: Date.now() }), "EX", OTP_TTL)
    .exec();

  logger.info(`Generated OTP for paymentId: ${paymentId}`);

  return otp;
}

// -------------------------------
// Enterprise OTP Verifier
// -------------------------------
async function verifyOtp(paymentId, enteredOtp) {
  if (!paymentId || !enteredOtp) throw new Error("Payment ID and OTP required");

  const key = `otp:${paymentId}`;
  const metaKey = `otp_meta:${paymentId}`;

  const [storedOtp, metaStr] = await redis.mget(key, metaKey);
  if (!storedOtp) {
    logger.warn(`OTP expired or missing for paymentId: ${paymentId}`);
    throw new Error("OTP expired or invalid");
  }

  const meta = metaStr ? JSON.parse(metaStr) : { retries: 0 };

  if (meta.retries >= OTP_RETRY_LIMIT) {
    await redis.del(key, metaKey);
    logger.warn(`OTP retry limit exceeded for paymentId: ${paymentId}`);
    throw new Error("OTP retry limit exceeded");
  }

  if (enteredOtp !== storedOtp) {
    meta.retries += 1;
    await redis.set(metaKey, JSON.stringify(meta), "EX", OTP_TTL);
    logger.warn(`Incorrect OTP attempt #${meta.retries} for paymentId: ${paymentId}`);
    throw new Error("Incorrect OTP");
  }

  // OTP correct: delete keys
  await redis.del(key, metaKey);
  logger.info(`OTP verified successfully for paymentId: ${paymentId}`);
  return true;
}

// -------------------------------
// Optional Rate Limiter Middleware
// -------------------------------
function otpRateLimiter(options = {}) {
  return rateLimit({
    windowMs: options.windowMs || 60 * 1000, // 1 minute
    max: options.max || 5, // max requests per window
    message: { error: "Too many OTP requests, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

module.exports = {
  generateOtp,
  verifyOtp,
  otpRateLimiter,
};
