const mongoose = require("mongoose");

const paymentMethodSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  type: {
    type: String,
    enum: ["card", "bank", "paypal"],
    required: true,
  },
  provider: { type: String, required: true }, // e.g., Visa, MasterCard, PayPal
  last4: { type: String, required: true }, // last 4 digits of card/bank
  expiryMonth: { type: Number }, // optional for cards
  expiryYear: { type: Number }, // optional for cards
  isDefault: { type: Boolean, default: false }, // default payment method
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("PaymentMethod", paymentMethodSchema);
