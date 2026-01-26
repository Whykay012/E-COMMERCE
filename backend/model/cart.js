// models/cart.js
const mongoose = require("mongoose");

const cartItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: { type: Number, default: 1, min: 1 },
    discount: { type: Number, default: 0 }, // absolute amount (not percent) — match your business rules
    selectedColor: { type: String },
    selectedSize: { type: String },
  },
  { _id: false }
);

const cartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    items: { type: [cartItemSchema], default: [] },
    // optional saved address or notes
    address: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Cart", cartSchema);
