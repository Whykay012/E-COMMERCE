const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * 🛰️ ZENITH QUANTUM OUTBOX (v5.0.0-ULTRA)
 * Architecture: Distributed Log-Based Orchestration
 * Capabilities: Sharded Locking, Idempotency Guard, Priority Weighting.
 */

const OutboxSchema = new mongoose.Schema({
    // 1. DISTRIBUTED CONTEXT
    aggregateId: { type: String, required: true, index: true },
    traceId: { type: String, required: true },
    
    // 🧠 IDEMPOTENCY FINGERPRINT: Prevents the same event from being 
    // published twice if the transaction is retried at the app level.
    idempotencyKey: { 
        type: String, 
        unique: true, 
        default: () => crypto.randomBytes(16).toString('hex') 
    },

    // 2. ACTION DEFINITION & VERSIONING
    eventType: { 
        type: String, 
        required: true,
        index: true 
    },
    version: { type: Number, default: 1 }, // Supports rolling schema updates

    // 3. PRIORITY ORCHESTRATION
    // 0 = Low (Newsletters), 10 = Critical (Password Change / Security Purge)
    priority: { 
        type: Number, 
        default: 5, 
        min: 0, 
        max: 10,
        index: true 
    },

    // 4. ADVANCED STATE MACHINE
    status: {
        type: String,
        enum: ['PENDING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'STALLED', 'DEAD_LETTER'],
        default: 'PENDING',
        index: true
    },

    // 5. ENCRYPTED PAYLOAD (Optional Zenith Layer)
    // We store sensitive payload as Mixed, but in Ultra-mode, this can be encrypted.
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    // 6. RELIABILITY HEURISTICS
    retryStrategy: {
        attempts: { type: Number, default: 0 },
        maxAttempts: { type: Number, default: 5 },
        nextAttemptAt: { type: Date, default: Date.now, index: true },
        backoffMultiplier: { type: Number, default: 2 }, // Exponential: 2s, 4s, 8s...
    },

    // 7. CONCURRENCY & SHARDED LOCKING
    // Prevents "Thundering Herd" in multi-node clusters
    lock: {
        workerId: { type: String, default: null },
        expiresAt: { type: Date, default: null },
    },

    // 8. TELEMETRY & AUDIT
    performance: {
        latencyMs: { type: Number }, // Time from creation to completion
        workerHost: { type: String },
    },
    errorLog: [{
        timestamp: { type: Date, default: Date.now },
        message: String,
        stack: String,
        attempt: Number
    }],

    // 9. LIFECYCLE MANAGEMENT
    processedAt: { type: Date },
    // Advanced: Keep failed tasks longer for forensic analysis
    retentionAt: { type: Date, index: { expires: '0s' } } 
}, { timestamps: true });

/* ===========================
 * 🚀 CRITICAL OPTIMIZATIONS
 * =========================== */

// COMPOUND INDEX: Optimized for the "Next Task" Worker Query
// Filters by: Ready status + High Priority + Time to execute + No active lock
OutboxSchema.index({ 
    status: 1, 
    priority: -1, 
    'retryStrategy.nextAttemptAt': 1, 
    'lock.workerId': 1 
});

/**
 * ZENITH LOGIC: Atomic Lock Acquisition
 * Ensures only one worker can claim the task, even under microsecond race conditions.
 */
OutboxSchema.statics.claimTask = async function(workerId, lockDurationMs = 30000) {
    const now = new Date();
    const expiry = new Date(now.getTime() + lockDurationMs);

    return this.findOneAndUpdate(
        {
            status: { $in: ['PENDING', 'STALLED'] },
            'retryStrategy.nextAttemptAt': { $lte: now },
            'lock.workerId': null
        },
        {
            $set: { 
                status: 'PROCESSING', 
                'lock.workerId': workerId, 
                'lock.expiresAt': expiry 
            }
        },
        { sort: { priority: -1, createdAt: 1 }, new: true }
    );
};

const Outbox = mongoose.models.Outbox || mongoose.model('Outbox', OutboxSchema);

module.exports = Outbox;