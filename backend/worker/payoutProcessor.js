import { ledgerService } from '../services/LedgerService';
const { pspAdapter } = require('../adapters/pspAdapter'); 
const { PermanentPayoutError, TransientPayoutError } = require('../lib/errorClasses');

// Production Check: Ensure required global variables are available
const db = typeof __firestore_db !== 'undefined' ? __firestore_db : null;
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

/**
 * @typedef {object} PayoutJobData
 * @property {string} payoutId - Unique ID for the payout document.
 * @property {number} amount - Amount to be paid out.
 * @property {string} sourceAccountId - Account to debit funds from.
 * @property {object} destinationDetails - Details needed by the PSP (e.g., bank info, recipient, provider).
 * @property {string} [idempotencyKey] - Optional, explicit key for PSP.
 */


/**
 * Payout Processor Worker Function (The atomic orchestrator).
 * @param {object} job - The job object from the queue.
 * @param {PayoutJobData} job.data
 * @returns {Promise<object>} - Success object upon full completion.
 * @throws {PermanentPayoutError|TransientPayoutError} - Controls job retry logic.
 */
export const payoutProcessor = async (job) => {
    const data = job.data;
    const startTimestamp = Date.now();
    const attempts = job.attemptsMade + 1 || 1;
    
    // Strict Idempotency Key Handling: Prefer explicit key, fallback to payoutId.
    const idempotencyKey = data.idempotencyKey || data.payoutId;

    console.log(`\n--- Payout Job ${data.payoutId} (Attempt ${attempts}) ---\n`);

    // --- CRITICAL INPUT VALIDATION (Fast-Fail) ---
    if (!db) {
        throw new PermanentPayoutError("FATAL: Database instance not initialized. Cannot proceed.");
    }
    if (!data.payoutId || typeof data.amount !== 'number' || data.amount <= 0 || !data.sourceAccountId || !data.destinationDetails) {
        // This is a permanent error because the input data itself is garbage.
        throw new PermanentPayoutError(`Invalid payout data payload. Missing critical fields or amount is invalid.`);
    }

    let providerTxId = null;

    try {
        // --- STEP 1: Pre-flight Status Update (Idempotent DB Write) ---
        // Sets status to PROCESSING right away to prevent other processes from picking it up.
        await ledgerService.updatePayoutStatus(db, appId, data.payoutId, 'PROCESSING');
        
        console.table([
            { Step: 1, Action: 'Status Set', Details: 'PROCESSING' },
            { Step: 2, Action: 'PSP Call', Details: `Using Key: ${idempotencyKey}` }
        ]);

        // --- STEP 2: External PSP Call (Idempotent API Call via adapter) ---
        const pspStart = Date.now();
        const pspResult = await pspAdapter.executePayout({
            idempotencyKey, 
            amount: data.amount,
            destinationDetails: data.destinationDetails // Contains recipient, provider, currency, etc.
        });
        const pspLatencyMs = Date.now() - pspStart;

        providerTxId = pspResult.providerTxId;
        
        if (pspResult.status !== 'SUCCESS' && pspResult.status !== 'PENDING') {
            // Treat non-success/non-pending as failure that warrants a retry (Transient)
            const errorMessage = `PSP acknowledged request but returned non-SUCCESS status: ${pspResult.message || 'Unknown PSP status'}.`;
            console.warn(`[PSP STATUS WARNING] Non-SUCCESS/Non-PENDING status received: ${pspResult.status}. Will retry.`);
            throw new TransientPayoutError(errorMessage); 
        }

        if (pspResult.status === 'PENDING') {
             // If PENDING, we stop the worker and rely on the webhook to finish the transaction.
             console.log(`[PSP PENDING] Payout ${data.payoutId} is PENDING. Stopping worker execution to await webhook.`);
             return {
                payoutId: data.payoutId, 
                status: 'PENDING',
                providerTxId
             };
        }

        console.log(`[Step 2/3 Complete] PSP Success. Provider Tx ID: ${providerTxId}. Latency: ${pspLatencyMs}ms.`);

        // --- STEP 3: CRITICAL ATOMIC LEDGER COMPLETION (Firestore Transaction) ---
        // This is the most crucial step for financial integrity. It guarantees debit and status update occur together.
        console.log(`[Step 3/3] Executing atomic debit and completion transaction...`);

        const ledgerStart = Date.now();
        await ledgerService.recordPayoutCompletion(
            db,
            appId,
            data.payoutId,
            providerTxId,
            data.amount,
            data.sourceAccountId // Account to debit from
        );
        const ledgerLatencyMs = Date.now() - ledgerStart;
        
        const totalLatencyMs = Date.now() - startTimestamp;
        
        console.log(`\n--- Payout ${data.payoutId} COMPLETED ---\n`);
        console.table([
            { Metric: 'Total Latency', Value: `${totalLatencyMs}ms` },
            { Metric: 'PSP Latency', Value: `${pspLatencyMs}ms` },
            { Metric: 'Ledger Latency', Value: `${ledgerLatencyMs}ms` }
        ]);
        
        return { 
            payoutId: data.payoutId, 
            status: 'COMPLETED',
            providerTxId,
            totalLatencyMs
        };

    } catch (error) {
        
        const errorMessage = `[Payout ${data.payoutId}] ${error.message}`;
        
        if (error instanceof PermanentPayoutError) {
            // Permanent Errors: Log and update status to FAILED_PERMANENTLY before halting.
            console.error(`\n[PERMANENT FAILURE] Failed permanently. Error: ${errorMessage}`);
            await ledgerService.updatePayoutStatus(db, appId, data.payoutId, 'FAILED_PERMANENTLY', errorMessage);
            
        } else if (error instanceof TransientPayoutError) {
            // Transient Errors: Log warning and signal the queue to retry.
            console.warn(`\n[TRANSIENT FAILURE] Retrying. Error: ${errorMessage}`);
            
        } else {
            // Unhandled system errors are wrapped and treated as transient for safety.
            console.error(`\n[UNEXPECTED SYSTEM FAILURE] Wrapping as Transient. Error: ${errorMessage}`, error);
            throw new TransientPayoutError(`Unhandled system error during processing: ${error.message}`);
        }
        
        // Re-throw the original error instance (Permanent or Transient) to propagate the retry signal
        throw error;
    }
};