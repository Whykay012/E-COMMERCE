// services/LedgerService.js
import { doc, runTransaction, updateDoc } from "firebase/firestore"; // Added updateDoc for completion
import { TransientPayoutError, PermanentPayoutError } from '../lib/errorClasses'; // Corrected import

// 🚀 TELEMETRY UTILITIES INTEGRATION
const Tracing = require('../utils/tracingClient'); 
const Metrics = require('../utils/metricsClient'); 
const Logger = require('../utils/logger'); 

// CONSTANTS for Collection Paths
const ARTIFACTS_COLLECTION = "artifacts";
const PUBLIC_DATA_COLLECTION = "public/data";
const PAYOUTS_COLLECTION = "payouts";
const SOURCE_ACCOUNTS_COLLECTION = "source_accounts";

/**
 * Service layer for interacting with the internal financial ledger (Firestore).
 * This service uses Firestore transactions to ensure atomic updates for 
 * both the Payout status and the Source Account debit.
 */
class LedgerService {
    /**
     * Updates the payout status without a transaction. Used for initial status setting 
     * or final permanent failure logging.
     * @param {Firestore} db - The Firestore instance.
     * @param {string} appId - The application ID.
     * @param {string} payoutId - The unique ID of the payout document.
     * @param {string} status - The new status (e.g., 'PROCESSING', 'FAILED_PERMANENTLY').
     * @param {string | null} errorMessage - Optional error message.
     * @returns {Promise<void>}
     */
    async updatePayoutStatus(db, appId, payoutId, status, errorMessage = null) {
        return Tracing.withSpan("LedgerService:updatePayoutStatus", async (span) => {
            span.setAttribute('payout.id', payoutId);
            span.setAttribute('payout.new_status', status);
            span.setAttribute('app.id', appId);

            Logger.info(`[Ledger Service] Updating Payout ID ${poutId} status to ${status}.`, {
                payoutId, status, appId, errorMessage
            });
            
            // 🔑 AUDIT LOG: Track all non-transactional status changes
            Logger.audit("PAYOUT_STATUS_UPDATE", {
                entityId: payoutId,
                action: 'STATUS_SET',
                status,
                appId,
                errorMessage
            });

            const payoutDocRef = doc(
                db, ARTIFACTS_COLLECTION, appId, PUBLIC_DATA_COLLECTION, PAYOUTS_COLLECTION, payoutId
            );
            
            try {
                // Actual updateDoc logic (assuming it's imported correctly now)
                await updateDoc(payoutDocRef, { 
                    status, 
                    errorMessage, 
                    updatedAt: new Date().toISOString() 
                });
                Metrics.increment(`payout.status_update.success.${status}`);
            } catch (error) {
                Metrics.increment("payout.status_update.fail");
                Logger.error("Failed to update payout status in Firestore.", {
                    payoutId, status, error: error.message, stack: error.stack
                });
                span.recordException(error);
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: `Failed to update status to ${status}` });
                // Note: Not re-throwing a Transient/Permanent error here, as this is a non-core write.
            }
        });
    }


    /**
     * Atomically records the successful completion of a payout in the Firestore ledger.
     * This is the core transactional function.
     * @param {Firestore} db - The Firestore instance.
     * @param {string} appId - The application ID.
     * @param {string} payoutId - The unique ID of the payout document.
     * @param {string} providerTxId - The transaction ID from the PSP.
     * @param {number} amount - The amount to be debited (base unit).
     * @param {string} sourceAccountId - The ID of the funding source account.
     * @returns {Promise<void>}
     * @throws {PermanentPayoutError|TransientPayoutError}
     */
    async recordPayoutCompletion(db, appId, payoutId, providerTxId, amount, sourceAccountId) {
        return Tracing.withSpan("LedgerService:recordPayoutCompletion", async (span) => {
            span.setAttribute('payout.id', payoutId);
            span.setAttribute('payout.amount', amount);
            span.setAttribute('account.id', sourceAccountId);
            span.setAttribute('app.id', appId);

            const payoutDocRef = doc(
                db, ARTIFACTS_COLLECTION, appId, PUBLIC_DATA_COLLECTION, PAYOUTS_COLLECTION, payoutId
            );
            const sourceAccountRef = doc(
                db, ARTIFACTS_COLLECTION, appId, PUBLIC_DATA_COLLECTION, SOURCE_ACCOUNTS_COLLECTION, sourceAccountId
            );

            Logger.info(`[Ledger Service] Attempting atomic transaction for Payout ID ${payoutId}...`, {
                payoutId, amount, sourceAccountId
            });
            
            try {
                await runTransaction(db, async (transaction) => {
                    
                    // --- 1. Internal Idempotency Check (READ) ---
                    const payoutSnap = await transaction.get(payoutDocRef);
                    if (payoutSnap.exists() && payoutSnap.data().status === 'COMPLETED') {
                        // Payout already completed successfully. Idempotent success.
                        Logger.warn(`[Atomic] Payout ${payoutId} already COMPLETED. Aborting transaction cleanly.`, { payoutId });
                        Metrics.increment("payout.record.idempotent_success");
                        return; 
                    }
                    
                    // --- 2. Debit the source account (READ) ---
                    const sourceAccountSnap = await transaction.get(sourceAccountRef);
                    if (!sourceAccountSnap.exists()) {
                        Metrics.increment("payout.record.fail.account_not_found");
                        throw new PermanentPayoutError(`Source Account ${sourceAccountId} not found for debit.`);
                    }
                    
                    const currentBalance = sourceAccountSnap.data().balance || 0;
                    const newBalance = currentBalance - amount;

                    if (newBalance < 0) {
                        // Financial Integrity Check Failure -> Permanent Error
                        Metrics.security("payout.record.fail.insufficient_funds");
                        throw new PermanentPayoutError(`Insufficient funds in source account ${sourceAccountId} for Payout ${payoutId}. Debit failed. Current: ${currentBalance}, Debit: ${amount}.`); 
                    }
                    
                    span.setAttribute('account.balance_before', currentBalance);
                    span.setAttribute('account.balance_after', newBalance);

                    // --- 3. Perform Writes (Atomic Updates) ---
                    
                    // Debit the source account
                    transaction.update(sourceAccountRef, { 
                        balance: newBalance,
                        lastTransaction: new Date().toISOString()
                    });

                    // Mark the payout as completed
                    transaction.update(payoutDocRef, {
                        status: 'COMPLETED',
                        providerTxId: providerTxId,
                        completedAt: new Date().toISOString(),
                    });
                    
                    // 💡 METRICS GAUGE: Record the final balance inside the successful transaction
                    Metrics.gauge("account.source.balance", newBalance, { sourceAccountId, appId });
                    Metrics.increment("payout.record.success.committed");

                    Logger.info(`[Atomic] Transaction successful for ${payoutId}: debited ${amount} from ${sourceAccountId}.`, { payoutId, newBalance });
                });
                
                // 🔑 AUDIT LOG (POST-TRANSACTION): Final Ledger Change
                Logger.audit("PAYOUT_LEDGER_DEBITED", {
                    entityId: payoutId,
                    action: 'DEBIT_COMPLETION',
                    amount,
                    sourceAccountId,
                    appId,
                    providerTxId
                });

            } catch (error) {
                
                if (error instanceof PermanentPayoutError) {
                    Metrics.increment("payout.record.fail.permanent");
                    // Log Permanent Error but re-throw for the caller (processor) to handle final status update
                    Logger.critical(`[Ledger Service] Permanent error during Payout ${payoutId} transaction: ${error.message}`, { payoutId, error: error.message });
                    span.recordException(error);
                    span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Permanent Payout Error' });
                    throw error; 
                }
                
                Metrics.increment("payout.record.fail.transient");
                // Wrap any other error (like contention/network/transaction failure) as transient for worker retry.
                Logger.error(`[Ledger Service] Firestore runTransaction failed for Payout ${payoutId}.`, { 
                    payoutId, 
                    error: error.message, 
                    reason: "Contention/Network/Unknown DB error" 
                });
                span.recordException(error);
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Transient DB Transaction Failure' });
                throw new TransientPayoutError(`Database atomic transaction failed (Contention/Network): ${error.message}`); 
            }
        });
    }
}

export const ledgerService = new LedgerService();