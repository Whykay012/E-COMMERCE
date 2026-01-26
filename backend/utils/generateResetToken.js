const crypto = require("crypto");

const generateResetToken = () => {
  const token = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
  const expires = Date.now() + 10 * 60 * 1000; // 10 minutes
  return { token, hashedToken, expires };
};

module.exports = generateResetToken;
