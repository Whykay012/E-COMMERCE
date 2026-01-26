// utils/payoutAdapter.js
/**
 * @fileoverview Payout adapter handling money transfers via Stripe, Paystack, and Flutterwave.
 * It ensures:
 * 1. Currency-specific provider routing (NGN to Paystack/Flutterwave, USD/GBP to Stripe/Flutterwave).
 * 2. Idempotency using the job's payoutId to prevent double transfers on retry.
 * 3. Correct minor/base unit handling for the different PSPs.
 * 4. Granular error handling (Permanent vs. Transient) for robust worker retries.
 */

const { PermanentPayoutError, TransientPayoutError } = require("../lib/errorClasses");

// --- 1. Environment Secrets (Must be supplied) ---
// NOTE: These should be securely injected via environment variables in a real application.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_live_stripe_placeholder_MUST_BE_REPLACED';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_live_paystack_placeholder_MUST_BE_REPLACED';
const FLUTTERWAVE_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY || 'FLWSECK_live_flutterwave_placeholder_MUST_BE_REPLACED';

const STRIPE_API_URL = 'https://api.stripe.com/v1/payouts';
const PAYSTACK_API_URL = 'https://api.paystack.co/transfer';
const FLUTTERWAVE_API_URL = 'https://api.flutterwave.com/v3/transfers';

/**
 * Executes an external money transfer using the specified Payment Service Provider (PSP).
 *
 * @param {Object} jobData - Data from the BullMQ job.
 * @param {string} jobData.payoutId - Unique ID for idempotency (CRITICAL).
 * @param {string} jobData.recipient - The destination account number or identifier.
 * @param {number} jobData.amount - The amount in the major unit (e.g., 100.00).
 * @param {string} jobData.reason - Description for the transfer.
 * @param {('Stripe'|'Paystack'|'Flutterwave')} jobData.provider - The chosen PSP.
 * @param {string|Object} jobData.providerAccountId - Source account ID or bank code (Flutterwave).
 * @param {('NGN'|'USD'|'GBP')} jobData.currency - The currency code.
 * @returns {Promise<Object>} - Transaction metadata upon success.
 * @throws {PermanentPayoutError|TransientPayoutError} - Throws specific errors for granular handling.
 */
async function performPayout({ payoutId, recipient, amount, reason, provider, providerAccountId, currency }) {
    // --- Granular Error Optimization 1: Input Validation (Permanent Errors) ---
    // If we're missing crucial data, retrying won't help. Fail permanently.
    if (!payoutId || !recipient || !amount || !provider || !providerAccountId || !currency) {
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
        processedAt: new Date().toISOString(),
        payoutId,
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
                        // CRITICAL: Idempotency Key - Prevents duplicate execution on Stripe's side
                        'Idempotency-Key': payoutId, 
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
                    transactionResult.message = `Stripe payout initiated. Status: ${stripeData.status}`;
                } else {
                    // API failure: Treat as transient unless specific error codes indicate permanent failure (e.g., invalid destination)
                    const errorMsg = stripeData.error?.message || `Stripe API non-OK status: ${stripeResponse.status}.`;
                    // For simplicity, treating most API errors as transient for retries.
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
                        // CRITICAL: Idempotency Key - Prevents duplicate execution on Paystack's side
                        'X-Request-Idempotency': payoutId,
                    },
                    body: JSON.stringify({
                        source: 'balance',
                        amount: amountInMinorUnit, // Amount in Kobo
                        recipient: recipient,
                        reference: payoutId, // Used as a primary reference for idempotency
                        reason: reason,
                        currency: upperCurrency,
                    }),
                });

                const paystackData = await paystackResponse.json();

                if (paystackResponse.ok && paystackData.status === true) {
                    transactionResult.success = true;
                    transactionResult.providerTxId = paystackData.data.reference;
                    transactionResult.message = paystackData.message || `Paystack transfer initiated.`;
                } else {
                    // API failure: Treat as transient (Paystack transfers are usually asynchronous)
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
                        amount: amount, // Amount in base unit (e.g., 100.00 USD)
                        narration: reason.substring(0, 50),
                        currency: upperCurrency,
                        reference: payoutId, // CRITICAL: Idempotency
                        debit_currency: upperCurrency,
                    }),
                });

                const flutterwaveData = await flutterwaveResponse.json();

                if (flutterwaveResponse.ok && flutterwaveData.status === 'success') {
                    transactionResult.success = true;
                    transactionResult.providerTxId = flutterwaveData.data.reference;
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
        console.error(`CRITICAL PSP FAILURE for ${provider} Payout ID ${payoutId}:`, error.message);
        
        // Re-throw specific error types (Permanent or Transient)
        if (error instanceof PermanentPayoutError || error instanceof TransientPayoutError) {
            throw error;
        }
        
        // Catch all remaining errors (e.g., network timeout from 'fetch') as transient
        throw new TransientPayoutError(`Network/Unhandled error during PSP communication: ${error.message}`);
    }

    return transactionResult;
}

module.exports = { performPayout };