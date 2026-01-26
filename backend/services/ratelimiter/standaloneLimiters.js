const redis = require("../../libs/redisClient");
const { TooManyRequestsError } = require("../../errors/tooManyREquestError");

const resendRateLimiter = {
  /**
   * Dedicated enforcer for OTP resends to avoid locking DB transactions.
   */
  enforce: async (userId) => {
    const key = `rate-limit:otp-resend:${userId}`;
    const limit = 3;
    const window = 600;

    // Atomic operation to prevent race conditions
    const results = await redis
      .multi()
      .incr(key)
      .expire(key, window, "NX")
      .exec();

    // results[0][1] is the result of INCR
    const count = results[0][1];

    if (count > limit) {
      throw new TooManyRequestsError(
        "Too many OTP requests. Try again in 10 minutes."
      );
    }
  },
};

module.exports = { resendRateLimiter };
