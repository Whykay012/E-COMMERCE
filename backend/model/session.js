const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    refreshToken: String,
    userAgent: String,
    ip: String,
    valid: { type: Boolean, default: true },
    expiresAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Session", sessionSchema);
