const mongoose = require("mongoose");

const ActivityLogSchema = new mongoose.Schema(
 {
  user: {
   type: mongoose.Schema.Types.ObjectId,
   ref: "User",
   required: true,
   index: true, // Indexed for efficient lookup by user
  },
  type: {
   type: String,
   enum: [
    "login",
    "logout",
    "order",
    "payment",
    "wishlist",
    "profile-update",
    "password-change",
    "address-update",
    "support-ticket",
    "session-revoke",
   ],
   required: true,
   index: true, // Indexed for efficient filtering by type
  },
  description: { type: String, required: true },
  ipAddress: { type: String },
  meta: { type: mongoose.Schema.Types.Mixed }, // arbitrary metadata e.g. orderId
 },
 { timestamps: true }
);

// --- CRITICAL ADDITION: Define the Text Index ---
// This enables the high-performance, non-regex $text search in the controller.
ActivityLogSchema.index({ 
    description: "text", 
    "meta.value": "text" // Assuming you want to search common values within the 'meta' object
});

module.exports = mongoose.model("ActivityLog", ActivityLogSchema);