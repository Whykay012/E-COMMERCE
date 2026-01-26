/**
 * @fileoverview Payout adapter handling money transfers via Stripe, Paystack, and Flutterwave.
 * This module exports the `pspAdapter` interface used by the Payout Processor worker.
 */

const { PermanentPayoutError, TransientPayoutError } = require("../lib/errorClasses");

// --- 1. Static Environment Secrets ---
// NOTE: Using placeholder values directly, as process.env is not available in this runtime.
const STRIPE_SECRET_KEY = 'sk_live_stripe_placeholder_MUST_BE_REPLACED';
const PAYSTACK_SECRET_KEY = 'sk_live_paystack_placeholder_MUST_BE_REPLACED';
const FLUTTERWAVE_SECRET_KEY = 'FLWSECK_live_flutterwave_placeholder_MUST_BE_REPLACED';

const STRIPE_API_URL = 'https://api.stripe.com/v1/payouts';
const PAYSTACK_API_URL = 'https://api.paystack.co/transfer';
const FLUTTERWAVE_API_URL = 'https://api.flutterwave.com/v3/transfers';


/**
 * Executes an external money transfer using the specified Payment Service Provider (PSP).
 * This function signature matches the expectation of the Payout Processor worker.
 *
 * @param {Object} data - Structured data from the Payout Processor job.
 * @param {string} data.idempotencyKey - Unique ID for idempotency (CRITICAL).
 * @param {number} data.amount - The amount in the major unit (e.g., 100.00).
 * @param {Object} data.destinationDetails - Contains detailed routing info.
 * @returns {Promise<Object>} - Transaction metadata upon success.
 * @throws {PermanentPayoutError|TransientPayoutError} - Throws specific errors for granular handling.
 */
async function executePayout({ idempotencyKey, amount, destinationDetails }) {
    // De-structure the detailed fields from the destinationDetails object
    const { 
        recipient, 
        reason, 
        provider, 
        providerAccountId, 
        currency 
    } = destinationDetails;

    // --- Granular Error Optimization 1: Input Validation (Permanent Errors) ---
    // Check for critical missing data points that retrying won't fix.
    if (!idempotencyKey || !recipient || !amount || !provider || !providerAccountId || !currency) {
        throw new PermanentPayoutError("Payout validation failed: Missing required job data fields.");
    }

    const supportedCurrencies = ['NGN', 'USD', 'GBP'];
    const upperCurrency = currency.toUpperCase();
    if (!supportedCurrencies.includes(upperCurrency)) {
        throw new PermanentPayoutError(`Unsupported currency: ${currency}. Adapter only handles ${supportedCurrencies.join(', ')}.`);
    }

    // Convert to minor unit (cents, kobo, pence)
    // NGN, USD, and GBP all use a 100 multiplier.
    const amountInMinorUnit = Math.round(amount * 100);

    let transactionResult = {
        success: false,
        providerTxId: null,
        message: null,
        status: 'PENDING', // Default status for external transfers
        processedAt: new Date().toISOString(),
        payoutId: idempotencyKey, // Use idempotency key as the primary reference
        amount,
        recipient,
        provider,
        currency,
    };

    try {
        switch (provider) {
            case 'Stripe':
                // Check for provider/currency mismatch (Permanent Error)
                if (upperCurrency === 'NGN') {
                    throw new PermanentPayoutError("Stripe is not configured for NGN payouts in this adapter.");
                }
                
                const stripeResponse = await fetch(STRIPE_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
                        // CRITICAL: Idempotency Key
                        'Idempotency-Key': idempotencyKey, 
                    },
                    body: new URLSearchParams({
                        amount: amountInMinorUnit, 
                        currency: upperCurrency.toLowerCase(),
                        destination: providerAccountId,
                        statement_descriptor: reason.substring(0, 22),
                    }).toString(),
                });

                const stripeData = await stripeResponse.json();

                if (stripeResponse.ok && stripeData.id) {
                    transactionResult.success = true;
                    transactionResult.providerTxId = stripeData.id;
                    transactionResult.status = stripeData.status === 'paid' ? 'SUCCESS' : 'PENDING';
                    transactionResult.message = `Stripe payout initiated. Status: ${stripeData.status}`;
                } else {
                    // Treat API failure as transient for retries, unless proven permanent
                    const errorMsg = stripeData.error?.message || `Stripe API non-OK status: ${stripeResponse.status}.`;
                    throw new TransientPayoutError(errorMsg); 
                }
                break;

            case 'Paystack':
                // Check for provider/currency mismatch (Permanent Error)
                if (upperCurrency !== 'NGN') {
                    throw new PermanentPayoutError("Paystack adapter only supports 'NGN' currency for transfers.");
                }
                
                const paystackResponse = await fetch(PAYSTACK_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                        // CRITICAL: Idempotency Key
                        'X-Request-Idempotency': idempotencyKey,
                    },
                    body: JSON.stringify({
                        source: 'balance',
                        amount: amountInMinorUnit, // Amount in Kobo
                        recipient: recipient,
                        reference: idempotencyKey, // Used as a primary reference for idempotency
                        reason: reason,
                        currency: upperCurrency,
                    }),
                });

                const paystackData = await paystackResponse.json();

                if (paystackResponse.ok && paystackData.status === true) {
                    transactionResult.success = true;
                    transactionResult.providerTxId = paystackData.data.reference;
                    // Paystack transfers are often asynchronous (pending status)
                    transactionResult.status = 'PENDING'; 
                    transactionResult.message = paystackData.message || `Paystack transfer initiated.`;
                } else {
                    // API failure: Treat as transient
                    throw new TransientPayoutError(paystackData.message || `Paystack API non-OK status: ${paystackResponse.status}`);
                }
                break;

            case 'Flutterwave':
                
                const flutterwaveResponse = await fetch(FLUTTERWAVE_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
                    },
                    body: JSON.stringify({
                        // providerAccountId must be structured/string for bank code
                        account_bank: typeof providerAccountId === 'object' ? providerAccountId.bankCode : providerAccountId, 
                        account_number: recipient,
                        amount: amount, // Flutterwave uses base unit (major unit)
                        narration: reason.substring(0, 50),
                        currency: upperCurrency,
                        reference: idempotencyKey, // CRITICAL: Idempotency
                        debit_currency: upperCurrency,
                    }),
                });

                const flutterwaveData = await flutterwaveResponse.json();

                if (flutterwaveResponse.ok && flutterwaveData.status === 'success') {
                    transactionResult.success = true;
                    transactionResult.providerTxId = flutterwaveData.data.reference;
                    // Flutterwave transfers are often asynchronous
                    transactionResult.status = 'PENDING'; 
                    transactionResult.message = flutterwaveData.message || `Flutterwave transfer initiated.`;
                } else {
                    // API failure: Treat as transient
                    throw new TransientPayoutError(flutterwaveData.message || `Flutterwave API non-OK status: ${flutterwaveResponse.status}`);
                }
                break;

            default:
                // Unsupported provider (Permanent Error)
                throw new PermanentPayoutError(`Unsupported payment provider: ${provider}`);
        }
    } catch (error) {
        // Log the error detail
        console.error(`CRITICAL PSP FAILURE for ${provider} Payout ID ${idempotencyKey}:`, error.message);
        
        // Re-throw specific error types (Permanent or Transient)
        if (error instanceof PermanentPayoutError || error instanceof TransientPayoutError) {
            throw error;
        }
        
        // Catch all remaining errors (e.g., network timeout from 'fetch') as transient
        throw new TransientPayoutError(`Network/Unhandled error during PSP communication: ${error.message}`);
    }

    return transactionResult;
}

// Export the function within the required object structure for the Worker
module.exports = { 
    pspAdapter: {
        executePayout
    }
};