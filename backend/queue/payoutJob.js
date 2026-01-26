const { payoutQueue } = require('../utils/queue');
const crypto = require('crypto');

/**
 * Generates a high-entropy, unique ID suitable for use as an auditable payout identifier.
 * This ID is used as the **idempotency key** for external payment processors (Stripe, Paystack, Flutterwave).
 * @returns {string} A unique identifier, e.g., "pout-1701234567890-abcxyz".
 */
const generateUniquePayoutId = () => {
    // In a real Node environment, prefer 'crypto.randomUUID()' for maximum safety.
    return `pout-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
};

/**
 * 1. The Producer: Queues a critical financial payout job.
 * * @param {string} userId - The ID of the user receiving the payout.
 * @param {number} amount - The payout amount (in minor units is generally safer, but using major units here for simplicity).
 * @param {string} referralTransactionId - The unique ID of the source event (e.g., referral ID).
 * @param {number} delayDays - The number of days to wait before executing (e.g., 30-day lock period).
 * @returns {Promise<import('bullmq').Job>} The newly created or existing BullMQ Job object.
 * @throws {Error} If the job fails to be queued.
 */
async function addPayoutJob(userId, amount, referralTransactionId, delayDays = 30) {
    // --- 1. Idempotency Key (BullMQ Layer) ---
    // Use the referral ID as the jobId to ensure this payout is NEVER queued twice by BullMQ.
    const jobId = `payout:${referralTransactionId}`; 
    
    // --- 2. External Idempotency Key (PSP Layer) ---
    const payoutId = generateUniquePayoutId();

    const jobData = { 
        userId, 
        amount, 
        referralTransactionId,
        payoutId, // Passed to the worker to be used as the PSP's idempotency key
        scheduledFor: new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000).toISOString(),
    };

    // --- 3. Production-Ready Job Options ---
    const jobOptions = {
        jobId: jobId, 
        delay: delayDays * 24 * 60 * 60 * 1000,
        priority: 1, // CRITICAL: Payouts are highest priority (1 is highest)
        attempts: 7, // High attempts to account for external PSP downtime
        backoff: {
            type: 'exponential',
            delay: 10000 // Start retrying after 10 seconds
        },
        // Aggressive cleanup for success to save Redis memory on old completed jobs
        removeOnComplete: true, 
        // Keep failed jobs for a long period for manual auditing
        removeOnFail: { age: 30 * 24 * 3600 }, 
    };

    try {
        // Attempt to queue the job. BullMQ's 'jobId' option prevents duplicate queuing.
        const job = await payoutQueue.add('process-payout', jobData, jobOptions);

        console.log(`[Producer: Payout] Job ${job.id} (Ref: ${referralTransactionId}) scheduled with delay of ${delayDays} days.`);
        return job;
    } catch (error) {
        console.error(`[Producer: Payout] CRITICAL FAILURE to queue payout job for Ref: ${referralTransactionId}. Error: ${error.message}`);
        // Re-throw to inform the calling service (e.g., to perform a database transaction rollback)
        throw error;
    }
}

module.exports = { addPayoutJob };