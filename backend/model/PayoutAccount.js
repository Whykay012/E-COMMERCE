/**
 * models/PayoutAccount.js
 * Optimized Mongoose schema for secure storage of external payment recipient IDs.
 * Separated from the User model for security and scale.
 */
const mongoose = require('mongoose');

// Define a sub-schema for the non-sensitive bank details for better structure enforcement
const BankDetailsSchema = new mongoose.Schema({
    bankName: { type: String, trim: true },
    accountNumberLast4: { type: String, trim: true, match: /^\d{4}$/ }, // Enforce last 4 digits
    currency: { type: String, uppercase: true, match: /^[A-Z]{3}$/ },
    accountHolderName: { type: String, trim: true },
}, { _id: false });

const PayoutAccountSchema = new mongoose.Schema({
    // Link to the user who owns this payout account
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true, // CRITICAL: A user MUST only have one active payout account record
    },
    
    // The payment provider (e.g., Stripe, Paystack)
    provider: {
        type: String,
        enum: ['Stripe', 'Paystack', 'Flutterwave', 'LocalBankTransfer'],
        required: true,
    },

    // The recipient ID from the external payment processor (e.g., Stripe Connect Account ID, Paystack Recipient Code)
    recipientId: {
        type: String,
        required: true,
        index: true, // For quick lookup by PSP ID
        trim: true,
    },
    
    // The actual bank account or payment method display details
    bankDetails: {
        type: BankDetailsSchema,
        required: true,
        comment: "Non-sensitive display/audit details of the underlying bank account.",
    },

    // The current status of the account (synced from the PSP)
    status: {
        type: String,
        enum: ['verified', 'pending', 'incomplete', 'suspended', 'deactivated'],
        default: 'pending',
        index: true,
    },
    
    // Flag to denote if this account is currently selected for payouts
    isActive: {
        type: Boolean,
        default: true,
    },

    // Audit field: when was the account status last confirmed with the PSP
    lastVerifiedAt: {
        type: Date,
        default: null,
    },

    // Arbitrary data from the PSP (e.g., full verification object)
    pspMetadata: mongoose.Schema.Types.Mixed,

}, { 
    timestamps: true,
    collection: "payout_accounts",
});

/* ------------------------------------------------------------------
 * INDEXES
 * ------------------------------------------------------------------ */

// Compound index for finding active accounts by status quickly
PayoutAccountSchema.index({ user: 1, isActive: 1, status: 1 });

const PayoutAccount = mongoose.model('PayoutAccount', PayoutAccountSchema);

module.exports = PayoutAccount;