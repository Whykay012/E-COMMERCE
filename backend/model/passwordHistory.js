/* ===========================
 * 💡 Assumed PasswordHistory Model Structure (for reference)
 * =========================== */

const PasswordHistorySchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    passwordHash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: '365d' } // Optional TTL index for long-term cleanup
});
module.exports = mongoose.model('PasswordHistory', PasswordHistorySchema);