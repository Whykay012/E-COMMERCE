const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },

    // 🔍 IDENTIFICATION & IDEMPOTENCY
    reference: { type: String, required: true, unique: true, index: true },
    idempotencyKey: { type: String, index: true },
    operation: { type: String, enum: ["INITIALIZE", "VERIFY", "WEBHOOK"] },

    // 💰 FINANCIAL DATA (Stored as Integers/Kobo)
    amount: { type: Number, required: true },
    currency: { type: String, default: "NGN", uppercase: true },

    // 🚦 STATE MACHINE
    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "success",
        "failed",
        "blocked",
        "reversed",
      ],
      default: "pending",
      index: true,
    },
    processed: { type: Boolean, default: false, index: true },

    // 🏗️ ADAPTER INFO
    channel: { type: String }, // card, bank_transfer, ussd
    provider: { type: String, required: true }, // paystack, stripe, etc.
    providerReference: { type: String, index: true },

    // 🛡️ SECURITY & STEP-UP (Promoted for Fast Querying)
    stepUpRequired: { type: Boolean, default: false },
    stepUpType: {
      type: String,
      enum: ["otp", "biometric_and_password", "none"],
    },
    stepUpVerified: { type: Boolean, default: false },
    stepUpIssuedAt: { type: Date },

    // 📦 EXTENSIBLE METADATA
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

// Compound index for strict idempotency
paymentSchema.index(
  { idempotencyKey: 1, operation: 1 },
  { unique: true, sparse: true },
);

// Optimized index for User History (Sort + Filter)
paymentSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("Payment", paymentSchema);
