// services/paymentMethodService.js

const mongoose = require("mongoose");
const PaymentMethod = require("../model/paymentMethod");
const PaymentMethodSoftDelete = require("../model/paymentMethodSoftDelete"); 
// --- Consolidated Error Imports ---
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const ConflictError = require('../errors/conflictError');
const UnauthorizedError = require('../errors/unauthorized-error');
const TransientPaymentError = require("../event/lib/errorClasses"); // Custom error for retryable failures
const ForbiddenError = require("../errors/forbidden-error"); // For token expiry denial

// External Service Integrations (Peak Zenith Dependency)
const AuthService = require('./authService'); 
const PSPService = require('./pspService');
const AuditLogger = require('./auditLogger');
const { log: auditLog } = AuditLogger;
const IdempotencyCache = require('../infrastructure/idempotencyCache'); // CRITICAL: For service-level idempotency


// =========================================================================
// ⚙️ UTILITIES & TRANSACTION MANAGEMENT
// =========================================================================

/**
 * @desc Executes a database operation within a Mongoose transaction block,
 * ensuring atomicity and proper session management.
 * @param {Function} operation - The async function containing the transaction logic.
 * @returns {Promise<any>} - Result of the operation.
 */
async function runInTransaction(operation) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const result = await operation(session);
        await session.commitTransaction();
        return result;
    } catch (error) {
        await session.abortTransaction();
        // 🎯 FIXED: Removed 'await' from auditLog
        auditLog({ 
            level: 'ERROR', 
            event: 'DB_TRANSACTION_FAILED', 
            // Log full stack trace for CRITICAL DB errors
            details: { error: error.message, stack: error.stack } 
        });
        throw error;
    } finally {
        session.endSession();
    }
}

/**
 * @desc Performs strict validation on the final token metadata.
 * @param {Object} metadata 
 * @throws {BadRequestError}
 */
function validateTokenMetadata(metadata) {
    const requiredFields = ['token', 'type', 'provider', 'last4', 'expiryMonth', 'expiryYear'];
    for (const field of requiredFields) {
        if (!metadata[field]) {
            throw new BadRequestError(`Missing critical payment metadata field: ${field}`);
        }
    }

    // Advanced Expiry Check: Ensure year is in the future
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1; // 1-indexed

    if (metadata.expiryYear < currentYear || 
        (metadata.expiryYear === currentYear && metadata.expiryMonth < currentMonth)
    ) {
        throw new ForbiddenError("Cannot use an expired payment method.");
    }

    // Basic format checks
    if (metadata.last4.length !== 4 || isNaN(metadata.last4)) {
        throw new BadRequestError('Invalid card last4 format.');
    }
}


// =========================================================================
// 💳 TOKENIZATION & VALIDATION
// =========================================================================

/**
 * @desc Exchanges a temporary nonce for a persistent PSP token and validates it.
 * @param {Object} data - Tokenization input data.
 * @returns {Promise<Object>} - Persistent token and metadata.
 */
async function tokenizeAndValidate({ userId, tempNonce, cardDetails, idempotencyKey }) {
    if (!tempNonce || !idempotencyKey) {
        throw new BadRequestError("Temporary token/nonce and idempotency key are required for tokenization.");
    }

    // 1. Production PSP SDK Call with Idempotency Protection (handled inside PSPService)
    const { persistentToken, cardMetadata } = await PSPService.exchangeNonceForToken(
        tempNonce,
        userId,
        idempotencyKey 
    );
    
    const finalMetadata = { ...cardDetails, ...cardMetadata, token: persistentToken };

    // 2. Strict Zenith Validation: Ensure PSP returned all necessary data and is not expired
    validateTokenMetadata(finalMetadata);

    // 3. Uniqueness Check: Ensure the persistent token is new/unique to this user
    const existingCard = await PaymentMethod.findOne({ user: userId, token: persistentToken });
    if (existingCard) {
        // Log this as a security issue: token was re-used or double-tokenized
        // 🎯 FIXED: Removed 'await' from auditLog
        auditLog({ 
            level: 'SECURITY', 
            event: 'CARD_TOKEN_REUSE_DETECTED', 
            userId, 
            details: { methodId: existingCard._id, last4: finalMetadata.last4 } 
        });
        throw new ConflictError("This card token has already been saved for this user.");
    }
    
    // 🎯 FIXED: Removed 'await' from auditLog
    auditLog({ 
        level: 'SECURITY', 
        event: 'CARD_TOKENIZED_SUCCESS', 
        userId, 
        details: { provider: finalMetadata.provider, last4: finalMetadata.last4 } 
    });

    return finalMetadata;
}


// =========================================================================
// 💳 ADD PAYMENT METHOD
// =========================================================================

/**
 * @desc Adds a new payment method, ensuring atomicity for default status.
 * @param {Object} data - Card details and token.
 * @returns {Promise<Object>} - The newly created payment method.
 */
async function addPaymentMethod({ userId, type, provider, last4, expiryMonth, expiryYear, isDefault, token, idempotencyKey }) {
    
    // 1. Zenith Idempotency Check (Service-level protection)
    // The idempotency key from the tokenization step is re-used here for service-level protection
    const cacheKey = `PM_ADD:${idempotencyKey}`;
    const cachedResult = await IdempotencyCache.get(cacheKey);

    if (cachedResult) {
        // 🎯 FIXED: Removed 'await' from auditLog
        auditLog({ level: 'WARN', event: 'ADD_PM_IDEMPOTENCY_HIT', userId, details: { key: idempotencyKey } });
        return JSON.parse(cachedResult);
    }
    
    // 2. Database Uniqueness Check (Prevent duplicate card saving)
    const duplicateCheck = await PaymentMethod.findOne({ user: userId, token });
    if (duplicateCheck) {
        throw new ConflictError("This card token has already been saved for this user.");
    }

    const result = await runInTransaction(async (session) => {
        let actualIsDefault = isDefault;

        // 3. Handle default flag atomically
        if (actualIsDefault) {
            await PaymentMethod.updateMany(
                { user: userId, isDefault: true },
                { $set: { isDefault: false } },
                { session }
            );
        } else {
            // Zenith Enhancement: If no other card exists, make this the default
            const existingCount = await PaymentMethod.countDocuments({ user: userId }).session(session);
            if (existingCount === 0) {
                actualIsDefault = true;
            }
        }

        const newMethod = await PaymentMethod.create([{
            user: userId,
            type,
            provider,
            last4,
            expiryMonth,
            expiryYear,
            isDefault: actualIsDefault || false,
            token,
            idempotencyKey // Used for audit trail
        }], { session });

        const finalMethod = newMethod[0].toObject({ virtuals: true, getters: true });

        // 🎯 FIXED: Removed 'await' from auditLog
        auditLog({ 
            level: 'INFO', 
            event: 'PAYMENT_METHOD_ADDED', 
            userId, 
            details: { methodId: finalMethod._id, provider, last4, isDefault: finalMethod.isDefault } 
        });
        
        return finalMethod;
    });
    
    // 4. Cache the successful result upon successful transaction commit
    await IdempotencyCache.set(cacheKey, JSON.stringify(result), 3600); 

    return result;
}


// =========================================================================
// 🛡️ LIFECYCLE MANAGEMENT
// =========================================================================

/**
 * @desc Proactively identifies and logs cards that are about to expire.
 * This is designed to be called by a daily cron job.
 * @param {number} daysAhead - Number of days in the future to check expiry.
 * @returns {Promise<number>} - Count of cards found expiring soon.
 */
async function checkTokenExpiry(daysAhead = 30) {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + daysAhead);

    const expiringCards = await PaymentMethod.find({
        // Find cards where the expiry year is before the target year,
        // OR the expiry year matches the target year and the month is before or equal to the target month.
        $or: [
            { expiryYear: { $lt: expiryDate.getFullYear() } },
            { 
                expiryYear: expiryDate.getFullYear(), 
                expiryMonth: { $lte: expiryDate.getMonth() + 1 } 
            }
        ]
    })
    .select('_id user provider last4 expiryMonth expiryYear')
    .lean();

    expiringCards.forEach(card => {
        // 🎯 FIXED: Removed 'await' from auditLog
        auditLog({
            level: 'WARNING',
            event: 'CARD_EXPIRY_NOTIFICATION',
            userId: card.user,
            details: {
                methodId: card._id,
                last4: card.last4,
                expiry: `${card.expiryMonth}/${card.expiryYear}`,
                daysAhead: daysAhead
            }
        });
    });

    return expiringCards.length;
}


// =========================================================================
// 💳 RETRIEVALS, UPDATE, SET DEFAULT (As optimized in previous versions)
// =========================================================================

async function getPaymentMethods(userId) {
    const methods = await PaymentMethod.find({ user: userId })
        .sort({ isDefault: -1, createdAt: -1 })
        .select('-token') 
        .lean();
    return methods;
}

async function updatePaymentMethod(userId, methodId, updates) {
    return runInTransaction(async (session) => {
        let method = await PaymentMethod.findOne({ _id: methodId, user: userId }).session(session);
        if (!method) throw new NotFoundError("Payment method not found.");
        
        const { isDefault, ...otherUpdates } = updates;

        if (isDefault === true && method.isDefault === false) {
            await PaymentMethod.updateMany(
                { user: userId, isDefault: true, _id: { $ne: methodId } },
                { $set: { isDefault: false } },
                { session }
            );
        } 
        
        Object.assign(method, otherUpdates); 
        if (isDefault !== undefined) method.isDefault = isDefault;

        await method.save({ session });
        // 🎯 FIXED: Removed 'await' from auditLog
        auditLog({ level: 'INFO', event: 'PAYMENT_METHOD_UPDATED', userId, details: { methodId, updatedFields: Object.keys(updates) } });
        return method.toObject({ getters: true, virtuals: true });
    });
}

async function setDefaultPaymentMethod(userId, methodId) {
    const methodCheck = await PaymentMethod.findOne({ _id: methodId, user: userId });
    if (!methodCheck) throw new NotFoundError("Payment method not found or does not belong to user.");
    if (methodCheck.isDefault) return methodCheck.toObject({ getters: true, virtuals: true });

    return runInTransaction(async (session) => {
        await PaymentMethod.updateMany(
            { user: userId, isDefault: true },
            { $set: { isDefault: false } },
            { session }
        );

        const newDefault = await PaymentMethod.findByIdAndUpdate(
            methodId,
            { $set: { isDefault: true } },
            { new: true, session }
        );

        if (!newDefault) throw new NotFoundError("Payment method not found after update.");
        
        // 🎯 FIXED: Removed 'await' from auditLog
        auditLog({ level: 'INFO', event: 'DEFAULT_CARD_SWITCHED', userId, details: { newDefaultId: methodId, provider: newDefault.provider } });
        return newDefault.toObject({ virtuals: true, getters: true });
    });
}


// =========================================================================
// 💳 DELETE PAYMENT METHOD (Soft Delete + PSP Token Removal)
// =========================================================================

/**
 * @desc Deletes a payment method, requiring re-authentication and using a soft-delete (archiving) pattern.
 */
async function deletePaymentMethod(userId, methodId, password) {
    
    // 1. Zenith Security: Re-authentication Check
    const isAuthenticated = await AuthService.verifyPassword(userId, password); 
    if (!isAuthenticated) {
        // 🎯 FIXED: Removed 'await' from auditLog
        auditLog({ 
            level: 'SECURITY', 
            event: 'DELETE_AUTH_FAILED', 
            userId, 
            details: { methodId, reason: 'Invalid password provided.' } 
        });
        throw new UnauthorizedError("Invalid password for re-authentication. Cannot delete payment method.");
    }

    // 2. Use transaction for the critical data modification steps
    await runInTransaction(async (session) => {
        const methodToDelete = await PaymentMethod.findOne({ _id: methodId, user: userId }).session(session);
        
        if (!methodToDelete) throw new NotFoundError("Payment method not found");
        
        // **CRITICAL SECURITY STEP:** Delete the token from the PSP first.
        try {
            await PSPService.deletePaymentToken(methodToDelete.token);
            
            // 🎯 FIXED: Removed 'await' from auditLog
            auditLog({ 
                level: 'SECURITY', 
                event: 'PSP_TOKEN_DELETED', 
                userId, 
                details: { provider: methodToDelete.provider, last4: methodToDelete.last4 } 
            });
        } catch (pspError) {
             // Throw TransientPaymentError to signal an external, retryable failure.
             throw new TransientPaymentError(`Failed to delete token at PSP: ${pspError.message}. DB operation aborted.`);
        }

        // 3. Soft Delete: Move to Soft Delete Audit Collection
        await PaymentMethodSoftDelete.create([{ 
            ...methodToDelete.toObject(), 
            deletedAt: new Date(), 
            originalId: methodToDelete._id
        }], { session });

        // 4. Hard Delete from Active Collection
        await PaymentMethod.deleteOne({ _id: methodId }).session(session);

        // 5. Handle default card fallback
        if (methodToDelete.isDefault) {
            const newDefault = await PaymentMethod.findOneAndUpdate(
                { user: userId },
                { $set: { isDefault: true } },
                { new: true, sort: { createdAt: -1 }, session }
            );
            
            if (newDefault) {
                // 🎯 FIXED: Removed 'await' from auditLog
                auditLog({ level: 'INFO', event: 'NEW_DEFAULT_CARD_SELECTED', userId, details: { newDefaultId: newDefault._id } });
            }
        }

        // 🎯 FIXED: Removed 'await' from auditLog
        auditLog({ 
            level: 'SECURITY', // Elevated to SECURITY level for a permanent deletion record
            event: 'PAYMENT_METHOD_SOFT_DELETED', 
            userId, 
            details: { methodId, provider: methodToDelete.provider, last4: methodToDelete.last4 } 
        });
    });
}


module.exports = {
    tokenizeAndValidate,
    addPaymentMethod,
    getPaymentMethods,
    updatePaymentMethod,
    setDefaultPaymentMethod,
    deletePaymentMethod,
    // CRITICAL: Export new lifecycle management function
    checkTokenExpiry, 
};