// services/pspService.js

/**
 * @fileoverview Payment Service Provider (PSP) Service for Card Tokenization 
 * and immediate payment-related APIs (Charge, Refund). This file focuses on 
 * secure, multi-provider integration for payment acceptance and settlement.
 */
const { BadRequestError,  } = require("../errors/bad-request-error");
const { NotFoundError,  } = require("../errors/notFoundError");
const { ConflictError } = require("../errors/onflictError");
const TransientPaymentError = require("../event/lib/errorClasses"); // Custom error for retryable failures
const { v4: uuidv4 } = require('uuid'); // Import UUID for trace IDs

// --- 1. Static Environment Secrets & URLs ---
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_live_stripe_placeholder';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_live_paystack_placeholder';
const FLUTTERWAVE_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY || 'FLWSECK_live_flutterwave_placeholder';

const STRIPE_API_BASE = 'https://api.stripe.com/v1'; 
const PAYSTACK_API_BASE = 'https://api.paystack.co';
const FLUTTERWAVE_API_BASE = 'https://api.flutterwave.com/v3';

// --- Zenith Infrastructure Stubs (Assumed) ---
const IdempotencyCache = require('../infrastructure/idempotencyCache'); // Redis/DB helpercreat
const { log: auditLog } = require('./auditLogger'); // Clean import: Destructure 'log' as auditLog

// Helper to determine HTTP success
const isSuccess = (response) => response.status >= 200 && response.status < 300;


// =========================================================================
// 💳 1. TOKENIZATION (Nonce Exchange)
// =========================================================================

/**
 * @desc Executes the secure process of exchanging a temporary client-side nonce 
 * for a persistent, re-useable Card Token from the PSP.
 */
async function exchangeNonceForToken(tempNonce, userId, idempotencyKey) {
    if (!tempNonce || !idempotencyKey) {
        throw new BadRequestError("Temporary token/nonce and idempotency key are required.");
    }
    
    // Idempotency Check
    const cachedResult = await IdempotencyCache.get(idempotencyKey);
    if (cachedResult) {
         auditLog({ 
             level: 'WARN', 
             event: 'IDEMPOTENCY_HIT', 
             userId, 
             details: { key: idempotencyKey, operation: 'TOKEN_EXCHANGE' } 
         });
         return JSON.parse(cachedResult);
    }
    
    // Determine the provider.
    let provider;
    if (tempNonce.startsWith('tok_str_')) provider = 'Stripe';
    else if (tempNonce.startsWith('tok_pay_')) provider = 'Paystack';
    else if (tempNonce.startsWith('tok_flw_')) provider = 'Flutterwave';
    else throw new BadRequestError("Unknown PSP identifier in temporary token.");
    
    try {
        let response, data;
        let persistentToken, cardMetadata;

        switch (provider) {
            case 'Stripe':
                // Stripe: Nonce is often the token ID. We simulate the full object fetch/customer attachment.
                cardMetadata = {
                    type: 'Visa', provider: 'Stripe', last4: '4242',
                    expiryMonth: 12, expiryYear: 2028, fingerprint: 'fp_stripe_xyz'
                };
                persistentToken = `tok_str_${tempNonce}_cust_${userId}`;
                break;

            case 'Paystack':
                // Paystack: Fetch card details using a token exchange endpoint.
                response = await fetch(`${PAYSTACK_API_BASE}/card/token`, { 
                    method: 'GET',
                    headers: { 
                        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'X-Idempotency-Key': idempotencyKey 
                    }
                });
                data = await response.json();
                
                if (!isSuccess(response) || data.status !== true) {
                    throw new TransientPaymentError(`Paystack Tokenization failed: ${data.message || 'API Error'}`);
                }
                
                persistentToken = data.data.token;
                cardMetadata = {
                    type: data.data.brand, provider: 'Paystack', last4: data.data.last4,
                    expiryMonth: data.data.exp_month, expiryYear: data.data.exp_year, fingerprint: data.data.fingerprint
                };
                break;

            case 'Flutterwave':
                // FLUTTERWAVE ACTIVE LOGIC: Token verification/fetch (simplified)
                response = await fetch(`${FLUTTERWAVE_API_BASE}/tokens/verify`, {
                    method: 'POST', // Assuming verification is a POST request
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
                    },
                    body: JSON.stringify({ token: tempNonce, currency: 'NGN' }) // Example payload
                });
                data = await response.json();

                if (!isSuccess(response) || data.status !== 'success') {
                    throw new TransientPaymentError(`Flutterwave Tokenization failed: ${data.message || 'API Error'}`);
                }

                // Map response fields to standardized metadata
                persistentToken = data.data.card_token;
                cardMetadata = {
                    type: data.data.card_brand, provider: 'Flutterwave', last4: data.data.last_4digits,
                    expiryMonth: data.data.expiry_month, expiryYear: data.data.expiry_year, fingerprint: data.data.card_hash
                };
                break;
                
            default:
                throw new BadRequestError(`Unsupported provider: ${provider}`);
        }
        
        const finalResult = { persistentToken, cardMetadata };
        
        // Cache the successful result
        await IdempotencyCache.set(idempotencyKey, JSON.stringify(finalResult), 3600); 

        return finalResult;

    } catch (error) {
        if (error instanceof TransientPaymentError || error instanceof BadRequestError) {
             throw error; 
        }
        throw new TransientPaymentError(`Network/Unhandled error during PSP token exchange: ${error.message}`);
    }
}


// =========================================================================
// 💳 2. EXECUTE CHARGE
// =========================================================================

/**
 * @desc Executes an immediate charge against a saved payment method token.
 */
async function executeCharge(token, amount, currency, email, idempotencyKey) {
    if (!token || !amount || !currency || !email || !idempotencyKey) {
        throw new BadRequestError("Missing required parameters for charge.");
    }
    
    // 💡 TRACING ENHANCEMENT: Unique ID for this specific charge request
    const chargeTraceId = uuidv4(); 

    // Determine the provider
    let provider;
    if (token.startsWith('tok_str_')) provider = 'Stripe';
    else if (token.startsWith('tok_pay_')) provider = 'Paystack';
    else if (token.startsWith('tok_flw_')) provider = 'Flutterwave';
    else throw new BadRequestError("Unknown PSP token format.");
    
    const amountInMinorUnit = Math.round(amount * 100); // Stripe/Paystack use minor units

    try {
        let response, data;
        let transactionResult = { status: 'PENDING', providerTxId: null, message: 'Initiated' };

        switch (provider) {
            case 'Stripe':
                response = await fetch(`${STRIPE_API_BASE}/charges`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
                        'Idempotency-Key': idempotencyKey,
                    },
                    body: new URLSearchParams({
                        amount: amountInMinorUnit, 
                        currency: currency.toLowerCase(),
                        source: token,
                        receipt_email: email,
                        description: `Charge for user ${email}`,
                    }).toString(),
                });
                data = await response.json();
                
                if (data.status === 'succeeded') {
                    transactionResult.status = 'SUCCESS';
                    transactionResult.providerTxId = data.id;
                    transactionResult.message = 'Charge successful.';
                } else if (data.status === 'pending') {
                    transactionResult.status = 'PENDING';
                    transactionResult.providerTxId = data.id;
                    transactionResult.message = 'Charge pending action/webhook.';
                } else {
                    throw new BadRequestError(`Stripe charge failed: ${data.failure_message || 'Unknown error.'}`);
                }
                break;

            case 'Paystack':
                response = await fetch(`${PAYSTACK_API_BASE}/transaction/initialize`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'X-Idempotency-Key': idempotencyKey,
                    },
                    body: JSON.stringify({
                        email: email,
                        amount: amountInMinorUnit,
                        currency: currency.toUpperCase(),
                        reference: idempotencyKey,
                    }),
                });
                data = await response.json();
                
                if (data.status === true) {
                    transactionResult.status = 'REDIRECT'; 
                    transactionResult.message = data.data.authorization_url;
                    transactionResult.providerTxId = data.data.reference;
                } else {
                    throw new BadRequestError(`Paystack initiation failed: ${data.message || 'Unknown error.'}`);
                }
                break;
                
            case 'Flutterwave':
                response = await fetch(`${FLUTTERWAVE_API_BASE}/charges?type=card`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
                    },
                    body: JSON.stringify({
                        tx_ref: idempotencyKey, // Flutterwave uses tx_ref for idempotency
                        amount: amount, // Flutterwave often uses major units
                        currency: currency.toUpperCase(),
                        card_token: token,
                        email: email,
                        // ... other required fields (e.g., redirect_url, full name)
                    }),
                });
                data = await response.json();

                if (isSuccess(response) && data.status === 'success') {
                    if (data.data.status === 'successful') {
                         transactionResult.status = 'SUCCESS';
                    } else if (data.data.status === 'pending' || data.data.status === 'otp') {
                         transactionResult.status = 'PENDING';
                    } else {
                         throw new BadRequestError(`Flutterwave charge failed: ${data.data.processor_response || data.message}`);
                    }
                    transactionResult.providerTxId = data.data.id; 
                    transactionResult.message = data.data.status;
                } else {
                    throw new BadRequestError(`Flutterwave initiation error: ${data.message || 'API Error'}`);
                }
                break;

            default:
                throw new BadRequestError(`Charge failed: Provider ${provider} not supported.`);
        }
        
        // Final success audit log
         auditLog({ 
             level: 'INFO', 
             event: 'CHARGE_SUCCESS', 
             details: { 
                 provider, 
                 amount, 
                 currency, 
                 providerTxId: transactionResult.providerTxId,
                 traceId: chargeTraceId // TRACING ADDITION
             } 
         });

        return transactionResult;

    } catch (error) {
         auditLog({ 
             level: 'ERROR', 
             event: 'CHARGE_FAILURE', 
             details: { 
                 provider, 
                 amount, 
                 reason: error.message,
                 traceId: chargeTraceId // TRACING ADDITION
             } 
         });

        if (error instanceof TransientPaymentError || error instanceof BadRequestError) {
             throw error; 
        }
        throw new TransientPaymentError(`Network/Unhandled error during PSP Charge: ${error.message}`);
    }
}


// =========================================================================
// 💳 3. EXECUTE REFUND
// =========================================================================

/**
 * @desc Executes a refund against a successful transaction ID.
 */
async function executeRefund({ providerTxId, amount, currency, reason, provider, idempotencyKey }) {
    if (!providerTxId || !currency || !provider || !idempotencyKey) {
        throw new BadRequestError("Missing required parameters for refund.");
    }
    
    // 💡 TRACING ENHANCEMENT: Unique ID for this specific refund request
    const refundTraceId = uuidv4(); 
    
    const amountInMinorUnit = amount ? Math.round(amount * 100) : null;
    
    try {
        let response, data;
        let refundResult = { status: 'PENDING', refundId: null, message: 'Initiated' };
        
        switch (provider) {
            case 'Stripe':
                response = await fetch(`${STRIPE_API_BASE}/refunds`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
                        'Idempotency-Key': idempotencyKey,
                    },
                    body: new URLSearchParams({
                        charge: providerTxId, 
                        amount: amountInMinorUnit, 
                        reason: reason,
                    }).toString(),
                });
                data = await response.json();
                
                if (data.status === 'succeeded') {
                    refundResult.status = 'SUCCESS';
                    refundResult.refundId = data.id;
                    refundResult.message = 'Refund processed successfully.';
                } else {
                    throw new BadRequestError(`Stripe refund failed: ${data.failure_reason || data.error?.message || 'Unknown error.'}`);
                }
                break;

            case 'Paystack':
                response = await fetch(`${PAYSTACK_API_BASE}/refund`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'X-Idempotency-Key': idempotencyKey,
                    },
                    body: JSON.stringify({
                        transaction: providerTxId, 
                        amount: amountInMinorUnit, 
                        reason: reason,
                        currency: currency.toUpperCase(),
                    }),
                });
                data = await response.json();
                
                if (data.status === true) {
                    refundResult.status = 'SUCCESS'; 
                    refundResult.refundId = data.data.reference; 
                    refundResult.message = data.message;
                } else {
                    throw new BadRequestError(`Paystack refund failed: ${data.message || 'Unknown error.'}`);
                }
                break;

            case 'Flutterwave':
                // FLUTTERWAVE ACTIVE LOGIC: Execute refund
                response = await fetch(`${FLUTTERWAVE_API_BASE}/transactions/${providerTxId}/refund`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
                    },
                    body: JSON.stringify({
                        tx_ref: idempotencyKey, // Using idempotency key as refund reference
                        amount: amount, // Flutterwave typically uses major units
                        reason: reason,
                    }),
                });
                data = await response.json();

                if (isSuccess(response) && data.status === 'success') {
                    refundResult.status = 'SUCCESS';
                    refundResult.refundId = data.data.id;
                    refundResult.message = data.message;
                } else {
                    throw new BadRequestError(`Flutterwave refund failed: ${data.message || 'API Error'}`);
                }
                break;

            default:
                throw new BadRequestError(`Refund failed: Provider ${provider} not supported.`);
        }

         auditLog({ 
             level: 'INFO', 
             event: 'REFUND_PROCESSED', 
             details: { 
                 provider, 
                 providerTxId, 
                 amount, 
                 refundId: refundResult.refundId,
                 traceId: refundTraceId // TRACING ADDITION
             } 
         });
        
        return refundResult;

    } catch (error) {
         auditLog({ 
             level: 'ERROR', 
             event: 'REFUND_FAILURE', 
             details: { 
                 provider, 
                 providerTxId, 
                 reason: error.message,
                 traceId: refundTraceId // TRACING ADDITION
             } 
         });

        if (error instanceof TransientPaymentError || error instanceof BadRequestError) {
             throw error; 
        }
        throw new TransientPaymentError(`Network/Unhandled error during PSP Refund: ${error.message}`);
    }
}


module.exports = {
    exchangeNonceForToken,
    executeCharge,
    executeRefund,
};