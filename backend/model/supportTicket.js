const mongoose = require("mongoose");

const supportTicketSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    status: { type: String, enum: ["open", "closed"], default: "open" },
    attachedFiles: [{ type: String }],
  },
  { timestamps: true }
);

// Indexes for fast queries
supportTicketSchema.index({ user: 1, createdAt: -1 });

// Optional TTL: auto-delete tickets older than 180 days (6 months)
supportTicketSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 180 * 24 * 60 * 60 }
);

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
