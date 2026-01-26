const z = require('zod');

// --- Reusable Schemas ---

// Standard 4-digit card number suffix validation
const last4Schema = z.string()
    .length(4, { message: "Last 4 digits must be exactly 4 characters." })
    .regex(/^\d{4}$/, { message: "Last 4 digits must contain only numbers." });

// Expiry month (1 to 12)
const expiryMonthSchema = z.number().int().min(1).max(12);

// Expiry year (Current year or in the future)
const currentYear = new Date().getFullYear();
const expiryYearSchema = z.number().int()
    .min(currentYear, { message: `Expiry year must be ${currentYear} or later.` })
    .max(currentYear + 15, { message: "Expiry year is too far in the future." }); // Max 15 years validity


// =========================================================================
// 1. tokenizeCard Input Schema
// =========================================================================

/**
 * Schema for tokenizing a card (exchanging a temporary nonce for a permanent token).
 * This requires data fields that come from the secure client-side form.
 */
const tokenizeCardSchema = z.object({
    // 💡 CRITICAL: The temporary token/nonce provided by the PSP client-side SDK.
    tempNonce: z.string().min(10, { message: "Temporary nonce is required for tokenization." }),

    // 💡 CRITICAL: Idempotency Key provided by the client, used for the PSP call.
    idempotencyKey: z.string().uuid({ message: "Idempotency key must be a valid UUID." }),

    // Fields passed from the client that are NOT sensitive (for DB storage/validation)
    cardDetails: z.object({
        type: z.enum(["visa", "mastercard", "amex", "discover", "other"], { message: "Invalid card type." }),
        provider: z.string().min(2, { message: "Payment provider name is required." }),
        last4: last4Schema,
        expiryMonth: expiryMonthSchema,
        expiryYear: expiryYearSchema,
    }).required(),
});


// =========================================================================
// 2. addPaymentMethod Input Schema
// =========================================================================

/**
 * Schema for adding the payment method to the user's profile, using the token
 * and metadata returned by the 'tokenizeCard' endpoint.
 */
const addPaymentMethodSchema = z.object({
    // 💡 CRITICAL: The persistent token obtained from PSP in the first step.
    token: z.string().min(10, { message: "Persistent payment token is required." }),

    // 💡 CRITICAL: The idempotency key *re-used* from the tokenize step 
    // to protect the final DB write/atomic default status update.
    idempotencyKey: z.string().uuid({ message: "Idempotency key must be a valid UUID." }), 

    type: z.enum(["visa", "mastercard", "amex", "discover", "other"]),
    provider: z.string().min(2),
    last4: last4Schema,
    expiryMonth: expiryMonthSchema,
    expiryYear: expiryYearSchema,
    
    // Optional flag to set as default
    isDefault: z.boolean().optional().default(false), 
});


// =========================================================================
// 3. updatePaymentMethod Input Schema
// =========================================================================

/**
 * Schema for updating non-sensitive payment method fields.
 * Note: Token and sensitive details cannot be updated here; a new card must be tokenized.
 */
const updatePaymentMethodSchema = z.object({
    // Updates are partial, so we use optional()
    isDefault: z.boolean().optional(),
    
    // Non-sensitive metadata updates
    billingAddressId: z.string().uuid({ message: "Invalid billing address ID format." }).optional(),
    
    // In some systems, the expiry date is stored client-side and updated manually (less common/safe)
    // Here we allow updating ONLY IF the date is valid/future-dated.
    expiryMonth: expiryMonthSchema.optional(),
    expiryYear: expiryYearSchema.optional(),

    // Ensure at least one field is present for the update operation
}).partial().refine(data => Object.keys(data).length > 0, {
    message: "Request body must contain at least one field to update."
});


// =========================================================================
// 4. deletePaymentMethod Input Schema (for the password field)
// =========================================================================

/**
 * Schema for deleting a payment method, requiring password re-authentication.
 */
const deletePaymentMethodSchema = z.object({
    password: z.string().min(8, { message: "Password is required for re-authentication." }),
});


// =========================================================================
// 📦 EXPORT THE VALIDATION SCHEMAS
// =========================================================================

module.exports = {
    tokenizeCard: tokenizeCardSchema,
    addPaymentMethod: addPaymentMethodSchema,
    updatePaymentMethod: updatePaymentMethodSchema,
    // Note: get/setDefaultPaymentMethod uses route params only, so no body schema needed.
    deletePaymentMethod: deletePaymentMethodSchema, 
};