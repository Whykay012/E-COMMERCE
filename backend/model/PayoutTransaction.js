/**
 * models/PayoutTransaction.js
 * Mongoose schema for tracking the lifecycle and external status of a scheduled referral payout.
 * Optimized for large-scale e-commerce: uses Decimal128 for financial precision.
 */
const mongoose = require("mongoose");

// Sub-schema for history entries, ensuring consistency in the audit log
const PayoutHistorySchema = new mongoose.Schema({
    status: { type: String, required: true },
    timestamp: { type: Date, default: Date.now, required: true },
    message: { type: String, default: 'Status updated.' },
}, { _id: false });

const PayoutTransactionSchema = new mongoose.Schema({
    // 1. Link to the internal earning event
    // The user who receives the commission
    recipientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true, // Primary index for retrieving user payout history
    },

    // Reference to the main Referral document that owns the commission history
    referralDocId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Referral",
        required: true,
    },

    // Optional: Reference to the Order that generated the commission
    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order",
        // Only required for sales commission, optional for referral bonuses
    },

    // 2. Link to the queue and external payment
    // Unique ID used for BullMQ job, ensuring only one job per transaction.
    jobId: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true,
    },

    // The unique, auditable ID used as the idempotency key for the Payment Service Provider (PSP)
    payoutId: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true,
    },

    // 3. Financial details
    amount: {
        // Use Decimal128 for high-precision financial data instead of Number
        type: mongoose.Types.Decimal128,
        required: true,
    },
    currency: {
        type: String,
        required: true,
        trim: true,
        uppercase: true,
        match: /^[A-Z]{3}$/, // E.g., USD, NGN (ISO 4217 standard)
    },

    // 4. Status and timing
    status: {
        type: String,
        enum: ["scheduled", "processing", "pending_provider", "paid", "failed", "cancelled", "refunded"],
        default: "scheduled",
        required: true,
        index: true, // Used in conjunction with recipientId for history lookups
    },

    provider: {
        type: String,
        enum: ["Stripe", "Paystack", "Flutterwave", "Manual", "Internal", "Other"],
        required: true,
    },

    scheduledFor: {
        type: Date,
        required: true,
        comment: "The date/time the job is due to execute after the lock period.",
    },

    // Timestamp when the external PSP reported success
    paidAt: {
        type: Date,
        default: null,
    },

    // 5. Audit trail
    failureReason: {
        type: String,
        default: null,
        comment: "Details about why the payout failed (e.g., PSP error message).",
    },

    providerReference: {
        type: String,
        default: null,
        sparse: true, // Only index documents where this field exists
        comment: "The transaction ID provided by the external PSP.",
    },

    // Full history of status changes using the sub-schema
    history: {
        type: [PayoutHistorySchema],
        default: [],
        comment: "Immutable log of status changes for audit purposes.",
    },

    metadata: mongoose.Schema.Types.Mixed,
}, {
    timestamps: true,
    collection: "payout_transactions",
});

/* ------------------------------------------------------------------
 * INDEXES
 * ------------------------------------------------------------------ */

// Compound index for fast retrieval of a user's pending or failed transactions
PayoutTransactionSchema.index({ recipientId: 1, status: 1 });

// Index for quick lookup of external references (only index documents that have this field)
PayoutTransactionSchema.index({ providerReference: 1 }, { sparse: true });

const PayoutTransaction = mongoose.model("PayoutTransaction", PayoutTransactionSchema);

module.exports = PayoutTransaction;