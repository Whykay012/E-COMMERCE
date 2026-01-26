// models/ImmutableWebhookRecord.js
const mongoose = require('mongoose');

const immutableWebhookSchema = new mongoose.Schema({
  provider: { type: String, required: true, index: true },
  providerId: { type: String, index: true, default: null }, // provider event id if present
  fingerprint: { type: String, required: true, unique: true, index: true },
  signature: { type: String, default: null }, // signature string if available (kept for audit)
  receivedAt: { type: Date, default: Date.now, index: true },
  payload: { type: mongoose.Schema.Types.Mixed }, // full parsed payload (optional, can be omitted if privacy)
  rawBodyHash: { type: String, required: true }, // SHA256 of raw body
  metadata: { type: mongoose.Schema.Types.Mixed }, // any extra metadata (ip, headers, etc)
}, {
  timestamps: false,
  versionKey: false,
  capped: false,
});

// Make writes append-only by avoiding model-level updates in code. (Enforced via code policy)
const ImmutableWebhookRecord = mongoose.model('ImmutableWebhookRecord', immutableWebhookSchema);

module.exports = ImmutableWebhookRecord;
