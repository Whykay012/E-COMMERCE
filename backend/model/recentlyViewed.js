const mongoose = require("mongoose");

const RecentlyViewedSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

// unique per user-product to prevent duplicate entries
RecentlyViewedSchema.index({ user: 1, product: 1 }, { unique: true });

module.exports = mongoose.model("RecentlyViewed", RecentlyViewedSchema);
