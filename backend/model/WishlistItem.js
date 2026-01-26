const mongoose = require("mongoose");

const wishlistItemSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: true,
  },
  addedAt: { type: Date, default: Date.now },
});

wishlistItemSchema.index({ user: 1, product: 1 }, { unique: true });

module.exports = mongoose.model("WishlistItem", wishlistItemSchema);
