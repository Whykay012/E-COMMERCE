const mongoose = require("mongoose");

const LoyaltyHistorySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    points: { type: Number, required: true },
    type: { type: String, enum: ["earn", "redeem"], required: true },
    description: { type: String, required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LoyaltyHistory", LoyaltyHistorySchema);
