const mongoose = require("mongoose");
const EventEmitter = require("events");

// --- REPOSITORY IMPORT ---
const referralRepository = require('./repositories/referralRepository');

// --- Mongoose Model Imports ---
const Referral = require("../model/Referral");
const User = require('../model/userModel'); 
const IdempotencyRecord = require('../model/idempotencySchema'); 
const Order = require('../model/order'); 
const PayoutAccount = require('../model/PayoutAccount'); 
const PayoutTransaction = require('../model/PayoutTransaction');

// --- Production Service Imports ---
const { addPayoutJob } = require('../queue/payoutQueue'); 
const { scheduleReferralPayout} = require("../queue/referralPayoutProduce")
const { trackEvent } = require('../utils/analyticsTracker'); 
const { emitWebhook } = require('../utils/webhookEmitter'); 

// !!! --- CACHE IMPORTS (UPDATED: Removed code-specific cache helpers) --- !!!
const { 
    referralCacheKey, 	 // Key Generator for user data -> KEEP
    adminListKey, 	 // Key Generator for admin lists -> KEEP
    idempotencyKey, 	 // Key Generator for transaction lock -> KEEP
    cacheGet, 	 	 // CRUD Read -> KEEP for non-code cache
    cacheSet, 	 	 // CRUD Write -> KEEP for non-code cache
    cacheDel, 	 	 // CRUD Delete -> KEEP for non-code cache
    cacheSetNX, 	 // Critical Concurrency Lock -> KEEP
    invalidateAdminReferralCaches, // Special Invalidation -> KEEP
    DEFAULT_REFERRAL_TTL, // Constant -> KEEP
    DEFAULT_ADMIN_TTL, 	 // Constant -> KEEP
} = require('../utils/referralCache'); 

// Utility Imports
const { generateReferralCode, BASE62_REGEX } = require("../utils/base62");

// Error Handlers
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const InternalServerError = require("../errors/internalServerError");
const ConflictError = require("../errors/conflictError");

// --- CONSTANTS ---
const LOCK_TTL_SECONDS = 30; 
const REFERRAL_SIGNUP_LOCK_PREFIX = 'referral_signup_lock:';
const COMMISSION_ORDER_LOCK_PREFIX = 'referral_order_lock:'; 
const REFERRAL_COMMISSION_RATE = 0.05; 
const REFERRAL_WINDOW_DAYS = 30; 
const PAYOUT_LOCK_DAYS = 30; 
const REQUIRED_ORDER_STATUS = 'delivered'; 

// --- EVENT SETUP ---
const eventEmitter = new EventEmitter();
const REFERRAL_EVENTS = {
    CODE_GENERATED: 'referral.code.generated', 
    COMMISSION_CREDITED: 'referral.commission.credited', 
    PAYOUT_SCHEDULED: 'referral.payout.scheduled', 
    PAYOUT_COMPLETED: 'referral.payout.completed', 
    CODE_DEACTIVATED: 'referral.code.deactivated',
};

// --- Utility Functions (Normalization) ---

const generateUniquePayoutId = () => {
    return `pout-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
};

function normalizeUserId(userId) {
    if (!userId) throw new BadRequestError("User ID is required.");
    if (mongoose.Types.ObjectId.isValid(userId)) {
        return new mongoose.Types.ObjectId(userId);
    }
    throw new BadRequestError("Invalid user ID format.");
}

function normalizeOrderId(orderRef) {
    if (!orderRef || typeof orderRef !== 'string' || orderRef.trim() === '') {
        throw new BadRequestError("Order reference string is required.");
    }
    return orderRef.trim();
}

async function fetchReferrerPayoutDetails(userId) {
    const normalizedUserId = normalizeUserId(userId);
    const payoutAccount = await PayoutAccount.findOne({
        user: normalizedUserId,
        isActive: true,
        isConfirmed: true 
    }).lean().exec();

    if (!payoutAccount) {
        throw new BadRequestError(`No active and confirmed Payout Account found for referrer: ${userId}.`);
    }
    return payoutAccount;
}

/**
 * Helper: Locates the canonical Referral document based on a system or custom code.
 * !!! REFACTORED TO USE REPOSITORY !!!
 */
async function findReferrerInfoByCode(code) {
    if (!code || typeof code !== 'string' || !BASE62_REGEX.test(code)) {
        throw new BadRequestError("Invalid referral code format.");
    }
    
    // 1. Use the repository's cached lookup for the canonical code
    const referrerDoc = await referralRepository.findActiveCodeByCode(code); 

    // 2. If not found in canonical codes, check User collection (Custom Code)
    if (!referrerDoc) {
        const userWithCustomCode = await User.findOne({ ownReferralCode: code }).select('_id').lean().exec();
        if (userWithCustomCode) {
            // If a custom code is found, we fetch the canonical document by user ID
            const canonicalDoc = await Referral.findOne({ user: userWithCustomCode._id, isActive: true }).lean().exec();
            if (canonicalDoc) return canonicalDoc;
        }
    }

    if (!referrerDoc) {
        throw new NotFoundError("The provided referral code is invalid, inactive, or does not exist.");
    }
    return referrerDoc;
}

// -----------------------------------------------------------------------
// --- Internal Commission Function (Executed within the BullMQ Worker) ---
// -----------------------------------------------------------------------

async function recordReferralCommission(referrerUserId, referredUserId, orderRef, commissionAmount, orderTotal, session) {
    const normalizedReferrerId = normalizeUserId(referrerUserId);

    const update = {
        $inc: { totalEarned: commissionAmount }, 
        $push: {
            referrals: {
                orderRef: normalizeOrderId(orderRef), 
                referredUser: normalizeUserId(referredUserId),
                commissionRate: REFERRAL_COMMISSION_RATE,
                commissionAmount: commissionAmount,
                orderTotal: orderTotal,
                creditedAt: new Date(),
            }
        },
        $set: { updatedAt: new Date() },
    };

    const options = {
        new: true,
        runValidators: true,
        lean: true,
        session,
    };

    // Find the canonical Referral document for the referrer and update it
    const referrerDoc = await Referral.findOneAndUpdate({ user: normalizedReferrerId }, update, options).exec();

    if (!referrerDoc) {
        throw new InternalServerError(`Referrer document not found during commission recording for user: ${referrerUserId}. Transaction failure.`);
    }
    
    // --- INTEGRATION: Analytics and Webhook Dispatch ---
    const payload = {
        referrerId: referrerUserId.toString(),
        referredUserId: referredUserId.toString(),
        orderRef,
        commissionAmount,
        orderTotal,
    };

    trackEvent('Referral', 'Commission Credited', payload);
    emitWebhook('referral.commission.credited', payload);
    eventEmitter.emit(REFERRAL_EVENTS.COMMISSION_CREDITED, payload);
    
    // Invalidate the user's cached referral data after a balance update 
    await cacheDel(referralCacheKey(referrerUserId));
    // Invalidate the administrative list cache
    await invalidateAdminReferralCaches();

    return referrerDoc;
}

async function executeCommissionCreditTransaction(jobData) {
    const { referrerId, referredUserId, orderRef, commissionAmount, orderTotal } = jobData;
    let session = null;
    let result = null;
    
    try {
        session = await mongoose.startSession();
        session.startTransaction();

        const referrerDoc = await recordReferralCommission(
            referrerId, 
            referredUserId, 
            orderRef, 
            commissionAmount, 
            orderTotal, 
            session
        );

        await session.commitTransaction();
        result = { status: 'success', message: 'Commission transaction committed.', data: referrerDoc };
        
        await scheduleReferralPayout(
            referrerDoc._id, 
            referrerId,
            commissionAmount,
            PAYOUT_LOCK_DAYS 
        );

        return result;

    } catch (error) {
        if (session && session.inTransaction()) {
            await session.abortTransaction();
        }
        console.error(`[WORKER] Transactional Commission/Payout Scheduling Failed for Order ${orderRef}:`, error.message);
        throw new InternalServerError(`Transaction failed: ${error.message}`);
    } finally {
        if (session) {
            session.endSession();
        }
    }
}


async function processReferralPayout(jobData) {
    const { referralId, referrerId, commissionAmount } = jobData;
    let session = null;
    const payoutId = generateUniquePayoutId(); 

    try {
        const payoutDetails = await fetchReferrerPayoutDetails(referrerId);
        
        console.log(`[PAYOUT] Simulating transfer of ${commissionAmount} to account ID: ${payoutDetails.accountNumber}. External ID: ${payoutId}`);
        const externalTransferStatus = 'success'; 

        if (externalTransferStatus !== 'success') {
            throw new InternalServerError('External payment processor failed to execute transfer.');
        }

        session = await mongoose.startSession();
        session.startTransaction();

        const transaction = await PayoutTransaction.create([{
            user: normalizeUserId(referrerId),
            referralDoc: normalizeUserId(referralId),
            amount: commissionAmount,
            externalPayoutId: payoutId,
            status: 'completed',
            payoutMethod: payoutDetails.methodType,
            payoutAccount: payoutDetails._id, 
        }], { session });

        const update = {
            $inc: { 
                totalPaidOut: commissionAmount,
                totalEarned: -commissionAmount 
            }, 
            $set: { updatedAt: new Date() },
        };

        const updatedReferral = await Referral.findByIdAndUpdate(
            referralId,
            update,
            { new: true, runValidators: true, lean: true, session }
        ).exec();

        if (!updatedReferral) {
            throw new NotFoundError('Referral document not found during payout update.');
        }

        await session.commitTransaction();

        await cacheDel(referralCacheKey(referrerId));
        await invalidateAdminReferralCaches();
        
        eventEmitter.emit(REFERRAL_EVENTS.PAYOUT_COMPLETED, {
            referralId,
            referrerId,
            commissionAmount,
            payoutId,
        });

        return { status: 'success', message: 'Payout successfully transferred and recorded.', transactionId: transaction[0]._id };

    } catch (error) {
        if (session && session.inTransaction()) {
            await session.abortTransaction();
        }
        console.error(`[PAYOUT WORKER] Financial Transfer Failed for Referrer ${referrerId}:`, error.message);
        throw new InternalServerError(`Payout failed: ${error.message}`);
    } finally {
        if (session) {
            session.endSession();
        }
    }
}

// ---------------------------------------------
// --- PUBLIC/EXPORTED MANAGEMENT FUNCTIONS ---
// ---------------------------------------------

/**
 * generateReferralForUser (Exported)
 * Atomically ensures each user has a single Referral document.
 * (Retaining findOneAndUpdate/upsert logic here as the repository lacks this compound operation)
 */
async function generateReferralForUser(userId, opts = {}) {
    const { maxAttempts = 5, session = null } = opts;
    const normalizedUserId = normalizeUserId(userId);

    let attempt = 0;
    let lastErr = null;

    while (attempt < maxAttempts) {
        attempt += 1;
        const code = generateReferralCode({}); 

        try {
            // 1. Attempt to create the code and the canonical document
            const query = { user: normalizedUserId };
            const update = {
                $setOnInsert: { 
                    user: normalizedUserId,
                    code,
                    referrals: [],
                    totalEarned: 0,
                    totalPaidOut: 0, 
                    isActive: true,
                    createdAt: new Date(),
                },
            };

            const options = {
                new: true,
                upsert: true, 
                setDefaultsOnInsert: true,
                runValidators: true,
                lean: true,
                session,
            };

            const doc = await Referral.findOneAndUpdate(query, update, options).exec();
            
            if (!doc) {
                throw new InternalServerError(`DB operation failed for user: ${userId}`);
            }
            
            const wasCreated = doc.code === code;
            
            // --- CACHE INVALIDATION ---
            await cacheDel(referralCacheKey(userId));
            await invalidateAdminReferralCaches();
            
            // NOTE: If the code was *created*, the repository's Write-Through logic in 
            // `referralRepository.createCode` would handle code caching, but since we 
            // use `findOneAndUpdate` here, we rely only on cache invalidation.

            eventEmitter.emit(REFERRAL_EVENTS.CODE_GENERATED, {
                userId: doc.user.toString(),
                code: doc.code,
                wasCreated: wasCreated,
            });

            return doc;
        } catch (err) {
            lastErr = err;
            const isDupKey = err.code === 11000;

            if (isDupKey) {
                const backoffMs = Math.floor(Math.random() * 50) + 100 * attempt;
                await new Promise((r) => setTimeout(r, backoffMs));
                continue;
            }

            console.error(`ReferralService Error (Attempt ${attempt}):`, err.message);
            throw new InternalServerError(`Database error during code generation: ${err.message}`);
        }
    }
    throw new InternalServerError("Could not guarantee unique referral code generation after multiple retries.");
}

/**
 * getReferralForUser (Exported)
 * Retrieves the canonical referral document for a specific user using Cache-Aside pattern.
 */
async function getReferralForUser(userId) {
    if (!userId) return null;
    
    try {
        const normalizedUserId = normalizeUserId(userId);
        const key = referralCacheKey(userId); 

        // --- CACHE HIT (Uses generic cache utility) ---
        const cachedData = await cacheGet(key);
        if (cachedData) {
            return cachedData;
        }

        // --- CACHE MISS: Hit DB ---
        const dbData = await Referral.findOne({ user: normalizedUserId }).lean().exec();
        
        if (dbData) {
            // --- CACHE SET (Uses generic cache utility) ---
            await cacheSet(key, dbData, DEFAULT_REFERRAL_TTL);
        }
        
        return dbData;
    } catch (err) {
        if (err instanceof BadRequestError) {
            throw err;
        }
        console.error("getReferralForUser database error:", err);
        throw new InternalServerError("Failed to retrieve referral information due to a service error.");
    }
}

/**
 * validateReferralCode (Exported)
 * Validates a referral code by deferring to the internal find function, which uses the repository.
 */
async function validateReferralCode(code) {
    // The underlying findReferrerInfoByCode now uses the repository's cached lookup.
    const referrerInfo = await findReferrerInfoByCode(code); 
    
    // findReferrerInfoByCode throws NotFoundError if invalid/inactive, so we just return here.
    return referrerInfo;
}


/**
 * processNewReferralSignup (Exported)
 * Primary entry point: Links the referred user to the referrer using Redis and Mongoose Idempotency.
 */
async function processNewReferralSignup(code, referredUserId, idempotencyKey) {
    // ---------------------------------------------
    // 1. IDEMPOTENCY RECORD CHECK (Persistent Audit)
    // ---------------------------------------------
    const existingRecord = await IdempotencyRecord.findOne({ key: idempotencyKey });
    if (existingRecord) {
        console.log(`Idempotency: Replay detected for key ${idempotencyKey}. Returning stored response.`);
        return existingRecord.responseBody;
    }

    const lockKey = REFERRAL_SIGNUP_LOCK_PREFIX + idempotencyKey;
    let lockAcquired = false;

    try {
        // ---------------------------------------------
        // 2. CONCURRENCY LOCK ACQUISITION (Cache Lock using cacheSetNX)
        // ---------------------------------------------
        lockAcquired = await cacheSetNX(lockKey, Date.now(), LOCK_TTL_SECONDS);
        if (!lockAcquired) {
            throw new Error('Signup transaction in progress. Please retry momentarily.');
        }

        // Uses the refactored lookup which relies on the repository cache
        const referrerDoc = await findReferrerInfoByCode(code);
        const normalizedReferredUserId = normalizeUserId(referredUserId);

        if (referrerDoc.user.equals(normalizedReferredUserId)) {
            throw new ConflictError("A user cannot refer themselves.");
        }
        
        // ---------------------------------------------
        // 3. ESTABLISH PERMANENT LINK ON NEW USER'S ACCOUNT
        // ---------------------------------------------
        const updatedUser = await User.findByIdAndUpdate(
            normalizedReferredUserId,
            { 
                $set: { 
                    referredByUserId: referrerDoc.user, 
                    referredAt: new Date(),
                    referralCodeUsed: code
                } 
            },
            { new: true, runValidators: true }
        ).lean().exec();
        
        if (!updatedUser) {
            throw new NotFoundError("Referred user not found for linking.");
        }

        const transactionResponse = {
            status: 201,
            message: 'Referral link established successfully (No immediate reward).',
            data: { 
                referrerUserId: referrerDoc.user.toString(), 
                referredUserId: referredUserId,
                referredAt: updatedUser.referredAt,
                commissionRate: REFERRAL_COMMISSION_RATE
            }
        };

        // ---------------------------------------------
        // 4. PERSIST RESPONSE TO IDEMPOTENCY RECORD
        // ---------------------------------------------
        await IdempotencyRecord.create({
            key: idempotencyKey,
            responseBody: transactionResponse,
            status: 'success',
            createdAt: new Date(),
        });
        
        return transactionResponse;

    } catch (error) {
        if (error instanceof ConflictError || error instanceof BadRequestError || error instanceof NotFoundError) {
            throw error;
        }
        throw new InternalServerError(`Failed to link referral: ${error.message}`);
    } finally {
        if (lockAcquired) {
            await cacheDel(lockKey); 
        }
    }
}


/**
 * creditOrderReferralCommission (Exported - Commission Queue Orchestrator - Stage 1 Producer)
 * Performs audit checks and dispatches the commission crediting job to the queue.
 */
async function creditOrderReferralCommission(orderRef, referredUserId) {
    const normalizedOrderRef = normalizeOrderId(orderRef); 
    const normalizedReferredUserId = normalizeUserId(referredUserId);
    const lockKey = COMMISSION_ORDER_LOCK_PREFIX + normalizedOrderRef; 
    let lockAcquired = false;
    
    try {
        // 1. CONCURRENCY LOCK ACQUISITION (Cache Lock on Order Reference)
        lockAcquired = await cacheSetNX(lockKey, Date.now(), LOCK_TTL_SECONDS);
        if (!lockAcquired) {
            return { status: 202, message: `Order ${normalizedOrderRef} commission is already being processed or queued. No action needed.` };
        }

        // 2. CHECK FOR EXISTING COMMISSION RECORD (Database Check)
        const checkExisting = await Referral.findOne({ "referrals.orderRef": normalizedOrderRef }).lean().exec();
        if (checkExisting) {
            console.log(`Order reference ${normalizedOrderRef} already credited for commission. Skipping.`);
            return { status: 200, message: "Commission already processed." };
        }

        // 3. Get the referred user's link information
        const referredUser = await User.findById(normalizedReferredUserId).select('referredByUserId referredAt').lean().exec();

        if (!referredUser || !referredUser.referredByUserId || !referredUser.referredAt) {
            return { status: 204, message: "User was not referred. No commission to process." };
        }
        
        const referrerId = referredUser.referredByUserId;
        const referredDate = referredUser.referredAt;
        const now = new Date();
        
        // 4. Check the 30-Day Window
        const cutoffDate = new Date(referredDate);
        cutoffDate.setDate(cutoffDate.getDate() + REFERRAL_WINDOW_DAYS);
        
        if (now > cutoffDate) {
            return { status: 200, message: "Order placed outside the 30-day referral window. No commission credited." };
        }

        // 5. Fetch Order Details (Using Real Mongoose Model)
        const orderDetails = await Order.findOne({ 
            reference: normalizedOrderRef, 
            orderStatus: REQUIRED_ORDER_STATUS 
        }).lean().exec();
        
        if (!orderDetails) {
            throw new NotFoundError(`Order reference ${normalizedOrderRef} not found or is not in the required status (${REQUIRED_ORDER_STATUS}).`);
        }
        
        // CRITICAL AUDIT
        if (orderDetails.user.toString() !== referredUserId.toString()) {
            throw new BadRequestError("Order user ID mismatch. Commission audit failed: Order placed by wrong user.");
        }
        
        const commissionAmount = orderDetails.totalAmount * REFERRAL_COMMISSION_RATE;
        if (commissionAmount <= 0) {
            return { status: 200, message: "Order total too low for commission." };
        }

        // 6. DISPATCH JOB TO PAYOUT QUEUE (Decoupling)
        const jobData = {
            orderRef: normalizedOrderRef,
            referredUserId: referredUserId.toString(),
            referrerId: referrerId.toString(),
            commissionAmount: commissionAmount,
            orderTotal: orderDetails.totalAmount,
        };
        
        await addPayoutJob(
            'executeCommissionCredit', 
            jobData,
            { jobId: `commission:${normalizedOrderRef}` }
        );

        return {
            status: 202, 
            message: `Commission payout job successfully queued for processing.`,
            commission: commissionAmount,
            orderRef: normalizedOrderRef,
            referrerUserId: referrerId.toString()
        };

    } catch (error) {
        if (error instanceof BadRequestError || error instanceof NotFoundError) {
            throw error;
        }
        console.error('Commission Queueing Failed:', error.message);
        throw new InternalServerError(`Failed to process order commission: ${error.message}`);
    } finally {
        if (lockAcquired) {
            await cacheDel(lockKey); 
        }
    }
}


/**
 * updateReferralCode (Exported)
 * Allows a user to set or update their custom referral code.
 */
async function updateReferralCode(userId, newCode) {
    const normalizedUserId = normalizeUserId(userId).toString(); 

    // 1. COLLISION CHECK (Custom Code vs. Other Users' Custom Codes)
    const existingCodeUser = await User.findOne({ ownReferralCode: newCode }).select('_id').lean().exec();

    if (existingCodeUser && existingCodeUser._id.toString() !== normalizedUserId) {
        throw new ConflictError('This custom code is already taken by another user.');
    }
    
    // 2. COLLISION CHECK (Custom Code vs. System Codes)
    // Check repository's underlying data model for collision
    const existingSystemCode = await Referral.findOne({ code: newCode }).select('_id').lean().exec();
    if (existingSystemCode) {
        throw new ConflictError('This custom code collides with an existing system-generated code.');
    }

    // 3. UPDATE USER RECORD
    const updatedUser = await User.findByIdAndUpdate(
        normalizedUserId,
        { $set: { ownReferralCode: newCode } },
        { new: true, select: 'ownReferralCode' } 
    ).lean().exec();

    if (!updatedUser) {
        throw new NotFoundError('User not found.');
    }
    
    const canonicalReferral = await Referral.findOne({ user: normalizedUserId }).select('code').lean().exec();
    
    // --- CACHE INVALIDATION ---
    // The repository handles the cache for the referral code itself, but since this is a custom code
    // stored on the User model, we rely on the canonical document lookup on next hit.
    // Invalidate the user's personal referral data cache
    await cacheDel(referralCacheKey(userId));
    
    return {
        userId: normalizedUserId,
        systemCode: canonicalReferral ? canonicalReferral.code : null,
        customCode: updatedUser.ownReferralCode,
        customCodeStatus: 'updated'
    };
}


/**
 * deactivateReferralCode (Exported)
 * Administrator function to disable a referral code.
 * !!! REFACTORED TO USE REPOSITORY !!!
 */
async function deactivateReferralCode(code) {
    if (!code || typeof code !== 'string') {
        throw new BadRequestError("Referral code is required.");
    }
    
    // 1. Use the repository's logic to atomically update the DB and invalidate the code cache
    const success = await referralRepository.deactivateCode(code);

    if (!success) {
        throw new BadRequestError("This referral code is already inactive or not found.");
    }
    
    // 2. Find the user ID associated with the code to invalidate the user-specific cache
    const referrerDoc = await Referral.findOne({ code: code }).select('user').lean().exec();

    if (referrerDoc) {
        // 3. Clear the specific user's cached referral data
        await cacheDel(referralCacheKey(referrerDoc.user.toString()));
    }
    
    // 4. Clear the admin list cache, as a deactivation changes list totals/counts
    await invalidateAdminReferralCaches();

    eventEmitter.emit(REFERRAL_EVENTS.CODE_DEACTIVATED, {
        code: code,
        userId: referrerDoc ? referrerDoc.user.toString() : 'unknown',
        deactivatedAt: new Date().toISOString()
    });

    return { code, status: 'deactivated', userId: referrerDoc ? referrerDoc.user.toString() : null };
}

/**
 * getReferredUsersList (Exported)
 * Retrieves a paginated list of users successfully referred by the given referrer ID.
 * Uses standard Mongoose offset pagination (as the repository's keyset method is for Referral codes).
 */
async function getReferredUsersList(referrerId, options = {}) {
    const normalizedReferrerId = normalizeUserId(referrerId);
    const { page = 1, limit = 10, sortBy = 'referredAt', sortOrder = -1 } = options;
    const skip = (page - 1) * limit;

    try {
        const query = { referredByUserId: normalizedReferrerId };

        // 1. Get the total count for pagination metadata
        const totalUsers = await User.countDocuments(query).exec();

        // 2. Fetch the paginated list of users, selecting necessary display fields
        const referredUsers = await User.find(query)
            .select('email firstName lastName referredAt referralCodeUsed') 
            .sort({ [sortBy]: sortOrder })
            .skip(skip)
            .limit(limit)
            .lean()
            .exec();

        return {
            users: referredUsers,
            page,
            limit,
            totalPages: Math.ceil(totalUsers / limit),
            totalUsers,
        };
    } catch (err) {
        console.error("getReferredUsersList database error:", err);
        throw new InternalServerError("Failed to retrieve referred users list.");
    }
}

/**
 * getCommissionHistoryList (Exported)
 * Retrieves the detailed commission history for a referrer, including the audit trail.
 */
async function getCommissionHistoryList(userId) {
    const normalizedUserId = normalizeUserId(userId);
    
    // Use the canonical getter which utilizes caching
    const referrerDoc = await getReferralForUser(userId);

    if (!referrerDoc) {
        throw new NotFoundError("Referral profile not found for this user.");
    }
    
    const history = referrerDoc.referrals || [];
    
    // Fetch detailed payout audit trail from PayoutTransaction model
    const payoutTransactions = await PayoutTransaction.find({ user: normalizedUserId })
        .sort({ createdAt: -1 })
        .lean()
        .exec();

    return {
        userId: userId,
        totalEarned: referrerDoc.totalEarned,
        totalPaidOut: referrerDoc.totalPaidOut,
        history: history,
        payouts: payoutTransactions, 
        count: history.length
    };
}

/**
 * getAdminReferralList (Exported - Admin Function)
 * Retrieves a paginated and sorted list of all Referral documents using cache-aside pattern.
 */
async function getAdminReferralList({ page = 1, limit = 25, sortBy = 'totalEarned', sortOrder = -1 }) {
    const options = { page, limit, sortBy, sortOrder };
    const key = adminListKey(options);
    
    // 1. Check cache
    const cachedList = await cacheGet(key);
    if (cachedList) {
        return cachedList;
    }

    // 2. Cache Miss: Query DB
    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder };

    try {
        const [dbList, totalCount] = await Promise.all([
            Referral.find({})
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .lean()
                .exec(),
            Referral.countDocuments({})
        ]);

        const result = {
            data: dbList,
            page,
            limit,
            totalCount,
            totalPages: Math.ceil(totalCount / limit)
        };

        // 3. Set cache
        await cacheSet(key, result, DEFAULT_ADMIN_TTL);

        return result;
    } catch (error) {
        console.error("getAdminReferralList database error:", error.message);
        throw new InternalServerError("Failed to retrieve admin referral list.");
    }
}

// -----------------------------------
// --- MODULE EXPORTS (REPOSITORY) ---
// -----------------------------------
module.exports = {
    // Management/Public APIs
    generateReferralForUser,
    getReferralForUser,
    validateReferralCode,
    updateReferralCode,
    deactivateReferralCode,
    processNewReferralSignup,
    creditOrderReferralCommission,
    getReferredUsersList,
    getCommissionHistoryList, 
    getAdminReferralList,     

    // Worker/Internal APIs (for BullMQ consumers)
    executeCommissionCreditTransaction, 
    processReferralPayout,              
    
    // Constants
    REFERRAL_COMMISSION_RATE,
    REFERRAL_WINDOW_DAYS,
    PAYOUT_LOCK_DAYS,
    REQUIRED_ORDER_STATUS,

    // Events
    REFERRAL_EVENTS,
    eventEmitter,
};