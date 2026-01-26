/**
 * models/Referral.js
 * FINAL MERGED + OPTIMIZED REFERRAL SCHEMA
 * -----------------------------------------
 * Unified version combining both schemas with:
 * - Clean field naming
 * - Strong Base62 code validation
 * - Order-level idempotency support
 * - Duplicate prevention
 * - Proper indexing for massive scale
 */

const mongoose = require("mongoose");

const ReferralSchema = new mongoose.Schema(
    {
        // The user who OWNS this referral code
        referrerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
            immutable: true, // Cannot change owner later
        },

        // The shareable, Base62 referral code
        code: {
            type: String,
            required: true,
            unique: true,
            uppercase: true,
            minlength: 6,
            maxlength: 16,
            match: /^[0-9A-Za-z]+$/, // Strong Base62 enforcement
            index: true,
        },

        // Referral usage history
        referrals: [
            {
                // Who used this code
                referredId: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                    required: true,
                },

                // Order-level idempotency (prevents double credit)
                orderRef: {
                    type: String,
                    required: true,
                    comment: "The Order reference that triggered this commission.",
                },
                
                // CRITICAL NEW FIELD: Links this earning event to the PayoutTransaction model
                // This ObjectId will point to the specific document in the PayoutTransaction collection.
                payoutTxId: {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "PayoutTransaction",
                    default: null, // Will be populated when the payout is scheduled
                    index: true,
                    comment: "Reference to the PayoutTransaction document for reconciliation."
                },

                // Commission percentage or rate at the time
                commissionRate: {
                    type: Number,
                    required: true,
                    min: 0,
                },

                // Amount earned from this single referral
                commissionAmount: {
                    type: Number,
                    required: true,
                    min: 0,
                    validate: {
                        validator: Number.isFinite,
                        message: v => `${v} is not a valid number.`,
                    },
                },

                orderTotal: {
                    type: Number,
                    required: true,
                    min: 0,
                },

                creditedAt: {
                    type: Date,
                    default: Date.now,
                },
            },
        ],

        // Total lifetime earnings (kept atomic with $inc)
        totalEarned: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
            validate: {
                validator: Number.isFinite,
                message: v => `${v} must be a valid number.`,
            },
        },

        // Code active/inactive control
        isActive: {
            type: Boolean,
            default: true,
        },

        // Optional expiry (used by TTL index)
        expiresAt: {
            type: Date,
        },

        // Forward-compatible
        metadata: mongoose.Schema.Types.Mixed,
    },
    {
        timestamps: true,
        collection: "referrals",
    }
);

/* ------------------------------------------------------------------
 * INDEXES — CRITICAL FOR LARGE SCALE REFERRAL SYSTEMS
 * ------------------------------------------------------------------ */

// 1. Ensure no referred user can appear twice globally → "referred once" rule
ReferralSchema.index(
    { "referrals.referredId": 1 },
    { unique: true, sparse: true }
);

// 2. Ensure no duplicate orderRef across all referrals → idempotent commission payouts
ReferralSchema.index(
    { "referrals.orderRef": 1 },
    { unique: true, sparse: true }
);

// 3. Leaderboard / audit optimization
ReferralSchema.index(
    { referrerId: 1, totalEarned: -1, isActive: 1 }
);

// 4. TTL cleanup (optional expiry)
ReferralSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, sparse: true }
);

module.exports = mongoose.model("Referral", ReferralSchema);