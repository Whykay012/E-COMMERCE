// services/complianceOutbox.js (Compliance Request Outbox Model)

const mongoose = require('mongoose');

/**
 * @typedef {'ERASURE_REQUEST' | 'ACCESS_REQUEST' | 'PORTABILITY_REQUEST'} ComplianceAction
 */

const ComplianceOutboxSchema = new mongoose.Schema({
    // Identifier for the data subject (e.g., userId, email hash)
    subjectId: {
        type: String,
        required: true,
        index: true,
    },
    // The specific data subject right being exercised
    action: {
        type: String,
        enum: ['ERASURE_REQUEST', 'ACCESS_REQUEST', 'PORTABILITY_REQUEST'],
        required: true,
    },
    // The status of the request processing
    status: {
        type: String,
        enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
        default: 'PENDING',
    },
    // Timestamp when the request was initiated
    createdAt: {
        type: Date,
        default: Date.now,
    },
    // Metadata for auditing or complex requests
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
    },
    // Record of processing attempts or final error
    processingLog: [{
        timestamp: { type: Date, default: Date.now },
        message: String,
        attempt: Number,
    }],
    // The final audit event to be published to the message broker (Kafka/RabbitMQ)
    eventPayload: {
        type: mongoose.Schema.Types.Mixed,
        required: false,
    }
}, { collection: 'compliance_outbox', timestamps: true });

// Index on status and creation time for efficient worker pickup
ComplianceOutboxSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('ComplianceOutbox', ComplianceOutboxSchema);