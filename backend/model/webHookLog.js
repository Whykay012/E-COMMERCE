const mongoose = require("mongoose");

const WebhookLogSchema = new mongoose.Schema(
 {
  provider: {
   type: String,
   required: true,
   enum: ["Stripe", "Paystack", "Paystack-Test", "Wallet", "Other"], // extend as needed
  },
  orderId: {
   type: mongoose.Schema.Types.ObjectId,
   ref: "Order",
   required: false,
  },
  reference: {
   // optional payment/reference id from provider
   type: String,
   required: false,
   index: true,
  },
  payload: {
   type: mongoose.Schema.Types.Mixed,
   required: true,
  },
  status: {
   type: String,
   enum: ["received", "processed", "failed"],
   required: true,
   default: "received",
  },
  error: {
   type: String,
  },
  signature: { type: String }, // raw signature header
  receivedAt: { type: Date, default: Date.now }, // <--- REMOVED: index: true
 },
 { timestamps: true }
);

// This index is kept because it specifies the Time-To-Live (TTL) for auto-deletion.
WebhookLogSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 86400 }); // 86400 seconds = 24 hours

// ✅ Prevent duplicates (core replay protection)
WebhookLogSchema.index({ provider: 1, reference: 1 }, { unique: true });

module.exports = mongoose.model("WebhookLog", WebhookLogSchema);