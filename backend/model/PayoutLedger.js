const mongoose = require("mongoose");

/**
 * PayoutLedgerSchema
 * Represents a historical, immutable record of a final payout disbursement.
 * This is the source of truth for all completed or failed payout transactions.
 */
const PayoutLedgerSchema = new mongoose.Schema({
    // Unique ID for idempotency and linking back to the job queue
    payoutId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    
    // Identifier of the user/entity receiving the payment
    userId: {
        type: mongoose.Schema.Types.ObjectId, // Assuming users are stored in MongoDB
        ref: 'User', // Reference to a User model if applicable
        required: true,
        index: true,
    },

    amount: {
        type: Number,
        required: true,
        min: 0.01,
    },
    
    currency: {
        type: String, // e.g., USD, EUR, NGN
        required: true,
        uppercase: true,
        trim: true,
    },
    
    // Final status of the disbursement transaction
    status: {
        type: String,
        enum: ['completed', 'failed', 'reversed'],
        required: true,
        index: true,
    },
    
    // The payment service provider used (Stripe, PayPal, Flutterwave, etc.)
    provider: {
        type: String,
        required: true,
        trim: true,
        index: true,
    },

    // The core reason/purpose of the payout
    reason: {
        type: String,
        required: true,
        trim: true,
    },
    
    // Transaction ID returned by the external payment provider
    providerTransactionId: {
        type: String,
        required: function() { return this.status === 'completed' || this.status === 'reversed'; },
        sparse: true, // Only index if present
    },

    failureReason: {
        type: String,
        required: function() { return this.status === 'failed'; },
        default: null,
    },

    // A detailed JSON object of the account used for payment (e.g., bank details, crypto wallet)
    recipientAccountDetails: {
        type: Object, 
        required: true,
    },
    
    // Audit log/Metadata from the original job
    metadata: {
        type: Object,
        default: {},
    },

}, {
    timestamps: { createdAt: 'createdAt', updatedAt: false }, // Only track creation time
    collection: 'payout_ledgers' // Explicit collection name
});

module.exports = mongoose.model("PayoutLedger", PayoutLedgerSchema);