/**
 * utils/transactionalOutbox.js
 * ZENITH OUTBOX - Distributed & Fault-Tolerant Edition
 */

const mongoose = require('mongoose');
const Logger = require('./logger'); 
const crypto = require('crypto');

// --- Advanced Outbox Schema ---
const OutboxSchema = new mongoose.Schema({
    outboxId: { type: String, required: true, unique: true, index: true },
    topic: { type: String, required: true, index: true },
    event: { type: Object, required: true },
    status: { 
        type: String, 
        enum: ['PENDING', 'PROCESSED', 'FAILED', 'LOCKED'], 
        default: 'PENDING',
        index: true 
    },
    // Locking mechanism for multi-instance scaling
    lockedAt: { type: Date },
    lockId: { type: String }, 
    
    retries: { type: Number, default: 0 },
    nextAttempt: { type: Date, default: Date.now, index: true },
    lastError: { type: String }
}, { timestamps: true });

// TTL for cleanup and Compound Index for the Worker query
OutboxSchema.index({ status: 1, nextAttempt: 1 });
OutboxSchema.index({ status: 1, createdAt: 1 }, { 
    expireAfterSeconds: 60 * 60 * 24 * 3, 
    partialFilterExpression: { status: 'PROCESSED' } 
});

const OutboxModel = mongoose.model('Outbox', OutboxSchema);

const Outbox = {
    /**
     * @desc Atomic Save within a Business Transaction
     */
    async save({ topic, event, session }) {
        const outboxId = event.eventId || crypto.randomBytes(16).toString('hex');
        
        const [record] = await OutboxModel.create([{
            outboxId,
            topic,
            event,
            status: 'PENDING',
            nextAttempt: new Date()
        }], { session });

        Logger.debug('OUTBOX_RESERVED', { outboxId, topic });
        return outboxId;
    },

    /**
     * @desc High-Performance Worker with Distributed Locking
     */
    async processBatch(publisherFn, batchSize = 20) {
        const lockId = crypto.randomBytes(8).toString('hex');
        const now = new Date();

        // 1. PESSIMISTIC LOCKING: Claim records so other instances don't touch them
        // This makes the worker safe for Kubernetes / Multi-instance clusters
        await OutboxModel.updateMany(
            { 
                status: 'PENDING', 
                nextAttempt: { $lte: now },
                // Also reclaim locks that have timed out (e.g. if a previous worker crashed)
                $or: [
                    { lockedAt: { $exists: false } },
                    { lockedAt: { $lte: new Date(now - 5 * 60000) } } 
                ]
            },
            { 
                $set: { status: 'LOCKED', lockId, lockedAt: now } 
            },
            { limit: batchSize }
        );

        const records = await OutboxModel.find({ lockId, status: 'LOCKED' });
        if (records.length === 0) return 0;

        Logger.info('OUTBOX_BATCH_CLAIMED', { count: records.length, lockId });

        for (const record of records) {
            try {
                // 2. Execute Publishing
                await publisherFn(record.topic, record.event);

                // 3. Success -> PROCESSED
                await OutboxModel.updateOne(
                    { _id: record._id },
                    { $set: { status: 'PROCESSED', lockedAt: null, lockId: null } }
                );
            } catch (err) {
                // 4. Failure -> Exponential Backoff
                const delayMinutes = Math.pow(2, record.retries + 1); // 2, 4, 8, 16...
                const isFinalFailure = record.retries >= 5;

                await OutboxModel.updateOne(
                    { _id: record._id },
                    { 
                        $set: { 
                            status: isFinalFailure ? 'FAILED' : 'PENDING',
                            nextAttempt: new Date(Date.now() + delayMinutes * 60000),
                            lastError: err.message,
                            lockId: null,
                            lockedAt: null
                        },
                        $inc: { retries: 1 }
                    }
                );
                Logger.error('OUTBOX_PUBLISH_RETRY', { id: record.outboxId, retry: record.retries, err: err.message });
            }
        }
        return records.length;
    },

    /**
     * @desc Graceful Worker Loop (Replaces node-cron for better control)
     */
    startWorker(publisherFn, intervalMs = 5000) {
        let isRunning = false;

        const run = async () => {
            if (isRunning) return;
            isRunning = true;
            try {
                const processed = await this.processBatch(publisherFn);
                // If we found work, run again immediately, otherwise wait for interval
                if (processed > 0) setTimeout(run, 100); 
                else setTimeout(run, intervalMs);
            } catch (err) {
                Logger.error('OUTBOX_WORKER_CRITICAL', err);
                setTimeout(run, intervalMs);
            } finally {
                isRunning = false;
            }
        };

        run();
        Logger.info('ZENITH_OUTBOX_WORKER_ACTIVE', { intervalMs });
    }
};

module.exports = Outbox;