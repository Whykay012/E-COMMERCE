const mongoose = require("mongoose");

const FraudLogSchema = new mongoose.Schema({
  payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  provider: String,
  riskScore: Number,
  riskAction: { type: String, enum: ["allow","block","challenge"] },
  reasons: [String],
  geo: Object,
  userAgent: String,
  ip: String,
  createdAt: { type: Date, default: Date.now }
});

// Export as a model
const FraudLog = mongoose.model("FraudLog", FraudLogSchema);
module.exports = FraudLog;
