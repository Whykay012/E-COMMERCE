const { payoutQueue } = require("./referralPayoutQueue")


/**
 * Generates a high-entropy, unique ID suitable for use as an auditable payout identifier.
 * This ID is used as the **idempotency key** for external payment processors (Stripe, Paystack, Flutterwave).
 * @returns {string} A unique identifier, e.g., "payout-1701234567890-abcxyz".
 */
const generateUniquePayoutId = () => {
    // In a real Node environment, prefer 'crypto.randomUUID()' for maximum safety.
    return `pout-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
};

/**
 * @typedef {Object} PayoutJobData
 * @property {string} recipient - The destination account identifier (e.g., bank account number, recipient code).
 * @property {number} amount - The amount in major unit (e.g., 50.00). Must be > 0.
 * @property {string} currency - The currency code (e.g., 'USD', 'NGN', 'GBP').
 * @property {string} reason - Description for the transfer (used for statement descriptor).
 * @property {('Stripe'|'Paystack'|'Flutterwave')} provider - The selected Payment Service Provider (PSP).
 * @property {string|Object} providerAccountId - The source account ID (Stripe) or bank code (Flutterwave/Paystack).
 * @property {string} referralId - The internal unique domain identifier for the referral event.
 * @property {string} [payoutId] - Optional: A pre-defined unique, auditable transaction ID.
 */


/**
 * 5. The Producer (Rock-Solid): Queues a critical payout job with built-in idempotency, delay, and cleanup policies.
 *
 * @param {PayoutJobData} data - The required payout data, including PSP details.
 * @param {number} delayDays - The number of days to wait before executing the payout. Default is 30 (lock period).
 * @param {number} [priority=5] - BullMQ priority: 1 is highest, 10 is lowest. Use for SLA tiers.
 * @returns {Promise<import('bullmq').Job>} The newly created or existing BullMQ Job object.
 * @throws {Error} If the job fails to be queued.
 */
export async function scheduleReferralPayout(data, delayDays = 30, priority = 5) {
    const timeOfExecution = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000).toISOString();

    // 1. Core ID and Job Name Setup
    // Use an explicit, unique ID for the external PSP's idempotency key.
    const payoutId = data.payoutId || generateUniquePayoutId();
    // Use referralId as the BullMQ jobId to prevent *any* duplicate jobs from being queued for the same referral.
    const jobId = `payout-${data.referralId}`;

    // 2. Final Job Data construction
    const finalData = { 
        ...data, 
        payoutId: payoutId 
    };

    // 3. Check for existing job (Pre-emptive robust check)
    try {
        const existingJob = await payoutQueue.getJob(jobId);
        if (existingJob) {
            console.warn(`[Producer WARNING] Job ${jobId} already exists and is skipped. Status: ${existingJob.status}`);
            return existingJob; // Return the existing job to maintain idempotency at the queuing layer.
        }
    } catch (e) {
        // If the getJob fails (e.g., Redis issue), we proceed to add but log the issue.
        console.error(`[Producer WARNING] Failed to check for existing job ${jobId}. Proceeding to queue. Error: ${e.message}`);
    }
    
    // 4. Define Production-Ready Job Options
    const jobOptions = {
        delay: delayDays * 24 * 60 * 60 * 1000,
        jobId: jobId, // Prevents duplicate queuing (BullMQ guarantees this)
        priority: priority, // Ensures critical jobs are processed first (e.g., VIP partners)
        attempts: 5, // Increased attempts for external, non-idempotent retries
        backoff: {
            type: 'exponential', // Recommended for external service calls
            delay: 5000 // Start retrying after 5 seconds
        },
        
        // CRITICAL: Aggressive cleanup policy for Redis memory management
        removeOnComplete: {
            age: 3600, // Keep successful job history for 1 hour for audit
            count: 5000, // Max number of completed jobs to keep
        },
        removeOnFail: {
            age: 7 * 24 * 3600, // Keep failed job history for 7 days
            count: 5000,
        },
    };

    // 5. Add Job to Queue
    try {
        const job = await payoutQueue.add(
            jobId, // The job name (can be the same as the jobId for clarity)
            finalData,
            jobOptions
        );

        console.log(`[Producer Success] Payout ${payoutId} (Ref: ${data.referralId}) scheduled.`);
        console.log(`-> Execution Time: ${timeOfExecution}, Queue ID: ${job.id}, Priority: ${priority}`);
        return job;
    } catch (error) {
        // Log all critical data if queuing fails (e.g., Redis connection issue)
        console.error(
            `[Producer CRITICAL FAILURE] Failed to queue payout for referral ${data.referralId}.`,
            { error: error.message, data: JSON.stringify(finalData) }
        );
        // Re-throw the error so the calling function can handle it (e.g., database rollback, alert system)
        throw new Error(`Queueing Payout Job failed: ${error.message}`);
    }
}

// Example usage in your application:
/*
import { scheduleReferralPayout } from './payout.producer.js';

async function handleSuccessfulReferral(referral) {
    // This data structure MUST match the PayoutJobData definition.
    const jobData = {
        recipient: referral.bankDetails.accountNumber, 
        amount: 50.00, 
        currency: 'NGN',
        reason: 'Referral Bonus',
        provider: 'Paystack', 
        providerAccountId: referral.bankDetails.bankCode, 
        referralId: referral.id, 
    };

    try {
        // Schedule the payout for a standard 30-day lock period with medium priority (5)
        const job = await scheduleReferralPayout(jobData, 30, 5); 
        // Update database: referral.payoutJobId = job.id;
    } catch (error) {
        // Handle failure to queue the job (e.g., log to Datadog/Sentry)
        console.error("Could not schedule job:", error);
    }
}
*/