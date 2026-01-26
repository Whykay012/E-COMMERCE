// controllers/paymentMethodController.js (Updated for Zenith Service Layer)

const { StatusCodes } = require("http-status-codes");
const asyncHandler = require('../middleware/asyncHandler');
const BadRequestError = require("../errors/bad-request-error");
const UnauthorizedError = require('../errors/unauthorized-error');

// --- 👑 PEAK ZENITH DELEGATION ---
// All business logic moves to the Service layer
const PaymentMethodService = require("../services/paymentMethodService");

// --- Zenith Input Validation Schemas (Assumed external dependency) ---
const ValidationSchema = require("../validators/paymentMethodSchema"); 


// =========================================================================
// 💳 1. PCI-COMPLIANT CARD TOKENIZATION
// =========================================================================

/**
 * @desc Exchanges a client-side nonce for a persistent, re-useable Card Token.
 * @route POST /api/v1/payment/methods/tokenize
 * @access Private (User)
 */
const tokenizeCard = asyncHandler(async (req, res) => {
    // 👑 PEAK ZENITH: Use schema validation for input integrity
    // The idempotencyKey is critical here to protect the external PSP call.
    const { tempNonce, cardDetails, idempotencyKey } = await ValidationSchema.tokenizeCard.validateAsync(req.body);
    
    // Delegation: Pass control to the Service Layer
    // Result is the validated token metadata, ready for saving.
    const result = await PaymentMethodService.tokenizeAndValidate({
        userId: req.user.userID,
        tempNonce,
        cardDetails,
        idempotencyKey,
    });

    // CRITICAL: The response includes the idempotencyKey to be re-used by the client 
    // in the subsequent 'addPaymentMethod' call for end-to-end idempotency protection.
    res.status(StatusCodes.OK).json({ 
        message: "Card successfully tokenized. Use the returned key to save it.",
        data: { ...result, idempotencyKey } // Re-expose key for client's next step
    });
});


// =========================================================================
// 💳 2. ADD PAYMENT METHOD
// =========================================================================

/**
 * @desc Adds a new payment method using a securely obtained token and idempotency key.
 * @route POST /api/v1/payment/methods
 * @access Private (User)
 */
const addPaymentMethod = asyncHandler(async (req, res) => {
    // 👑 PEAK ZENITH: Use schema validation for input integrity
    // Ensure the key for service-level idempotency protection is included
    const validatedData = await ValidationSchema.addPaymentMethod.validateAsync(req.body);
    
    // Delegation: Pass control to the Service Layer
    const newMethod = await PaymentMethodService.addPaymentMethod({
        userId: req.user.userID,
        ...validatedData
    });

    // The service handles transaction, default flag, and service-level idempotency caching.
    res.status(StatusCodes.CREATED).json({ 
        message: "Payment method added successfully.", 
        paymentMethod: newMethod
    });
});


// =========================================================================
// 💳 3. GET ALL PAYMENT METHODS
// =========================================================================

/**
 * @desc Retrieves all payment methods for the user.
 * @route GET /api/v1/payment/methods
 * @access Private (User)
 */
const getPaymentMethods = asyncHandler(async (req, res) => {
    // Delegation: Pass control to the Service Layer
    const methods = await PaymentMethodService.getPaymentMethods(req.user.userID);

    res.status(StatusCodes.OK).json({
        paymentMethods: methods,
    });
});


// =========================================================================
// 💳 4. UPDATE PAYMENT METHOD
// =========================================================================

/**
 * @desc Updates non-sensitive fields (expiry, default status) of a payment method.
 * @route PUT /api/v1/payment/methods/:id
 * @access Private (User)
 */
const updatePaymentMethod = asyncHandler(async (req, res) => {
    const { id } = req.params;
    // 👑 PEAK ZENITH: Use schema validation for input integrity
    const validatedUpdates = await ValidationSchema.updatePaymentMethod.validateAsync(req.body);

    // Delegation: Pass control to the Service Layer
    const updatedMethod = await PaymentMethodService.updatePaymentMethod(
        req.user.userID,
        id,
        validatedUpdates
    );

    res.status(StatusCodes.OK).json({ 
        message: "Payment method updated.", 
        paymentMethod: updatedMethod 
    });
});


// =========================================================================
// 💳 5. SET DEFAULT CARD
// =========================================================================

/**
 * @desc Dedicated endpoint to quickly set one card as the default.
 * @route POST /api/v1/payment/methods/:id/default
 * @access Private (User)
 */
const setDefaultPaymentMethod = asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Delegation: Pass control to the Service Layer
    const newDefault = await PaymentMethodService.setDefaultPaymentMethod(
        req.user.userID,
        id
    );

    res.status(StatusCodes.OK).json({ 
        message: "Default payment method successfully switched.", 
        paymentMethod: newDefault
    });
});


// =========================================================================
// 💳 6. DELETE PAYMENT METHOD (Re-authentication & Soft Delete)
// =========================================================================

/**
 * @desc Deletes a payment method. Requires re-authentication (password in body).
 * @route DELETE /api/v1/payment/methods/:id
 * @access Private (User)
 */
const deletePaymentMethod = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { password } = req.body; 
    const userId = req.user.userID;

    // The service handles the password verification logic, but the controller must ensure it's present.
    if (!password) {
        // 👑 PEAK ZENITH: Use specific 401 response for re-authentication failure
        throw new UnauthorizedError("Password (re-authentication) is required to delete a payment method.");
    }

    // Delegation: Pass control to the Service Layer, including the password check
    await PaymentMethodService.deletePaymentMethod(userId, id, password);

    // The service handles re-auth, PSP token removal, soft-delete, and default fallback logic.
    res.status(StatusCodes.OK).json({ message: "Payment method deleted and archived for audit." });
});


module.exports = {
    tokenizeCard,
    addPaymentMethod,
    getPaymentMethods,
    updatePaymentMethod,
    setDefaultPaymentMethod,
    deletePaymentMethod,
};