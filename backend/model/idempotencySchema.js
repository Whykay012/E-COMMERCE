/**
 * models/IdempotencyRecord.js
 * Mongoose schema for storing the final status of successful idempotent transactions.
 * This ensures that if a client replays a request after the Redis lock expires, 
 * we return the original successful response from the persistent store.
 */
const mongoose = require("mongoose");

const idempotencySchema = new mongoose.Schema({
    // The unique ID provided by the client (X-Idempotency-Key header)
    idempotencyKey: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    // The endpoint/method combination (e.g., "POST /api/v1/referral/signup")
    requestPath: {
        type: String,
        required: true,
    },
    // Timestamp of when the request was first processed successfully
    processedAt: {
        type: Date,
        default: Date.now,
        index: true,
        // 💡 CRITICAL ADDITION: MongoDB TTL index for automatic record cleanup.
        // This makes the BullMQ cleanup job optional or redundant for Mongo records.
        expires: "7d" 
    },
    // The exact response body returned to the client on first success
    responseBody: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
    },
    // The HTTP status code (e.g., 200, 201)
    responseStatus: {
        type: Number,
        required: true,
    }
}, {
    timestamps: false // We use 'processedAt' instead of mongoose's createdAt
});

// For extra safety, you can add an explicit TTL index definition (optional if 'expires' is used above)
idempotencySchema.index({ "processedAt": 1 }, { expireAfterSeconds: 7 * 24 * 3600 });


// Ensure the model is correctly initialized only once
const IdempotencyRecord = mongoose.models.IdempotencyRecord
    ? mongoose.models.IdempotencyRecord
    : mongoose.model("IdempotencyRecord", idempotencySchema);

module.exports = IdempotencyRecord;