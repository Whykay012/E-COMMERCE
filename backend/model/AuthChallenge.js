// models/AuthChallenge.js
const AuthChallengeSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },
  type: { type: String, enum: ["OTP", "3DS"] },
  codeHash: String,
  expiresAt: Date,
  attempts: { type: Number, default: 0 },
  resolved: { type: Boolean, default: false },
});
module.exports = mongoose.model("AuthChallenge", AuthChallengeSchema);
