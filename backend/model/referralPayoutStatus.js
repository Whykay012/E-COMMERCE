// model/referralPayoutStatus.js

const mongoose = require('mongoose');

// Define the Schema for the Payout Status document
const PayoutStatusSchema = new mongoose.Schema({
    // CRITICAL: payoutId is the primary identifier for idempotency.
    // 'unique: true' ensures MongoDB throws an E11000 error if a duplicate
    // is attempted, which the worker uses to safely skip duplicate writes.
    payoutId: {
        type: String,
        required: true,
        unique: true, 
        index: true
    },
    // The state of the payout process
    status: {
        type: String,
        enum: ['PENDING', 'COMPLETED', 'FAILED'],
        default: 'PENDING',
        required: true,
    },
    // Data passed from the job
    referralId: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    recipient: { type: String, required: true },
    provider: { type: String, required: true },
    
    // External Transaction ID returned by the payment adapter
    providerTxId: { type: String, index: true },
    
    // Metadata
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
}, {
    // Adds version key (__v) to documents, good practice for auditing/debugging
    versionKey: true,
    // Automatically manage timestamps for create and update
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

// Create the Mongoose Model
const PayoutStatus = mongoose.model('PayoutStatus', PayoutStatusSchema);

module.exports = PayoutStatus;