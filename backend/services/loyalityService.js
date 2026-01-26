// services/LoyaltyService.js

const mongoose = require("mongoose");
const { StatusCodes } = require("http-status-codes"); 
const LoyaltyHistory = require("../model/loyaltyHistory");
const User = require("../model/userModel");
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");

// 🚀 TELEMETRY UTILITIES INTEGRATION
const Logger = require('../utils/logger'); // ULTIMATE PINO LOGGER
const Tracing = require('../utils/tracingClient'); // OPEN-TELEMETRY
const Metrics = require('../utils/metricsClient'); // STATSD CLIENT

const redis = require("ioredis");

// Import specific functions from the sophisticated Idempotency service
const { 
    acquireLock, 
    getCachedResponse, 
    persistResponse, 
    normalizeKey,
    sanitizeKey,
} = require("./idempotencyService"); 

// --- POLICY CONSTANTS ---
const MAX_DAILY_REDEMPTIONS = 5;
const MAX_REDEMPTION_AMOUNT = 10000; 

// Initialize Redis client using the same pattern as the idempotencyService
const REDIS_CLIENT = new redis(process.env.REDIS_URL); 

// --- ROLE-BASED PERMISSION CHECK ---
// Checks if a user has an elevated role (admin or lead_engineer)
const hasElevatedRole = async (userID) => {
    // 💡 Improvement: Fetch role directly from DB if not available from context/JWT
    const user = await User.findById(userID).select('role').lean();
    if (!user) return false;
    
    // Check against defined elevated roles
    return ['admin', 'lead_engineer'].includes(user.role);
}; 

class LoyaltyService {
    
    /**
     * Retrieves the current loyalty balance for a user.
     * @param {string} userID 
     * @returns {number}
     */
    static async getBalance(userID) {
        return Tracing.withSpan("LoyaltyService:getBalance", async (span) => {
            span.setAttribute('user.id', userID);
            
            const user = await User.findById(userID).select('loyaltyPoints').lean();
            if (!user) {
                Metrics.increment("loyalty.balance.user_not_found");
                throw new NotFoundError('User not found.');
            }
            
            const balance = user.loyaltyPoints || 0;
            span.setAttribute('loyalty.points', balance);
            return balance;
        });
    }

    /**
     * Awards points to a user, ensuring atomicity, policy, and advanced idempotency.
     */
    static async awardPoints(userID, { points, description, orderId, rawIdempotencyKey }) {
        return Tracing.withSpan("LoyaltyService:awardPoints", async (span) => {
            if (!points || points <= 0) {
                Metrics.increment("loyalty.award.bad_request");
                throw new BadRequestError("Points must be positive to award.");
            }
            
            const addedPoints = Number(points);
            const requestPath = `/loyalty/award`; 
            const step = "default";
            span.setAttributes({
                'user.id': userID,
                'loyalty.points_awarded': addedPoints,
                'loyalty.order_id': orderId,
            });
            
            // --- 1. IDEMPOTENCY KEY HANDLING & CACHE CHECK ---
            let normalizedKey = null;
            let lockKey = null;
            
            try {
                const rawKey = sanitizeKey(rawIdempotencyKey);
                normalizedKey = normalizeKey(rawKey);
                span.setAttribute('idempotency.key', normalizedKey);
                
                // a. Fast Path: Check Redis cache
                const cached = await getCachedResponse(normalizedKey, step);
                if (cached) {
                    Metrics.increment("idempotency.hit", 1, { flow: 'award' });
                    Logger.info("LOYALTY_AWARD_IDEMPOTENT_HIT", { userId: userID, key: normalizedKey });
                    return { entry: cached.body.data, loyaltyPoints: cached.body.loyaltyPoints };
                }
                
                // b. Acquire Lock (Lock prevents concurrent execution)
                lockKey = await acquireLock(normalizedKey, step);
                if (!lockKey) {
                    Metrics.increment("idempotency.lock_failure", 1, { flow: 'award' });
                    Logger.warn("LOYALTY_AWARD_LOCK_FAIL", { userId: userID, key: normalizedKey, reason: 'Duplicate request in progress' });
                    throw new BadRequestError(`Duplicate request in progress for key: ${rawIdempotencyKey}`);
                }
                Metrics.increment("idempotency.lock_acquired", 1, { flow: 'award' });

                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    // 2. ATOMIC STEP: Update User's loyalty balance
                    const updatedUser = await User.findByIdAndUpdate(
                        userID,
                        { $inc: { loyaltyPoints: addedPoints } }, 
                        { new: true, session }
                    );
                    if (!updatedUser) throw new NotFoundError("User not found");

                    // 3. TRANSACTIONAL STEP: Create History Entry
                    const entry = await LoyaltyHistory.create([{
                        user: userID,
                        points: addedPoints,
                        type: 'earn',
                        description,
                        order: orderId || null,
                    }], { session });

                    await session.commitTransaction(); 
                    
                    Metrics.increment("loyalty.award.success");

                    // 4. PERSIST RESPONSE and RELEASE LOCK (Success path)
                    const finalResult = { 
                        message: "Points awarded",
                        entry: entry[0], 
                        loyaltyPoints: updatedUser.loyaltyPoints 
                    };
                    
                    await persistResponse(normalizedKey, requestPath, StatusCodes.CREATED, finalResult, step);
                    
                    try { await REDIS_CLIENT.del(lockKey); } catch (e) { 
                        Logger.error("REDIS_LOCK_RELEASE_FAIL", { err: e.message, lockKey });
                    }
                    
                    // 5. AUDIT LOG (Use the structured Logger.audit)
                    Logger.audit("LOYALTY_POINTS_AWARDED", {
                        entityId: userID, // The user entity being audited
                        action: 'EARN',
                        points: addedPoints, 
                        newTotal: updatedUser.loyaltyPoints, 
                        orderId, 
                        key: normalizedKey,
                        adminId: 'SYSTEM' // Implicit system action via Order Service
                    });

                    span.setAttribute('loyalty.new_total', updatedUser.loyaltyPoints);

                    return finalResult;
                } catch (txErr) {
                    await session.abortTransaction();
                    
                    try { await REDIS_CLIENT.del(lockKey); } catch (e) { 
                        Logger.error("REDIS_LOCK_RELEASE_FAIL_TX", { err: e.message, lockKey });
                    } 
                    
                    Metrics.increment("loyalty.award.transaction_fail");
                    span.recordException(txErr);
                    span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: txErr.message });
                    throw txErr;
                } finally {
                    session.endSession();
                }

            } catch (err) {
                if (lockKey) {
                    try { await REDIS_CLIENT.del(lockKey); } catch (e) { 
                        Logger.error("REDIS_LOCK_RELEASE_FAIL_CATCH", { err: e.message, lockKey });
                    } 
                }
                throw err;
            }
        });
    }

    /**
     * Redeems points from a user, ensuring atomicity, policy, and advanced idempotency.
     */
    static async redeemPoints(userID, { points, description, rawIdempotencyKey }) {
        return Tracing.withSpan("LoyaltyService:redeemPoints", async (span) => {
            if (!points || points <= 0) {
                Metrics.increment("loyalty.redeem.bad_request");
                throw new BadRequestError("Points must be positive to redeem.");
            }
            
            const redeemPoints = Number(points);
            const requestPath = `/loyalty/redeem`;
            const step = "default";

            span.setAttributes({
                'user.id': userID,
                'loyalty.points_redeemed': redeemPoints,
            });

            // --- 1. IDEMPOTENCY KEY HANDLING & CACHE CHECK ---
            let normalizedKey = null;
            let lockKey = null;
            
            try {
                const rawKey = sanitizeKey(rawIdempotencyKey);
                normalizedKey = normalizeKey(rawKey);
                span.setAttribute('idempotency.key', normalizedKey);

                // a. Fast Path: Check Redis cache
                const cached = await getCachedResponse(normalizedKey, step);
                if (cached) {
                    Metrics.increment("idempotency.hit", 1, { flow: 'redeem' });
                    Logger.info("LOYALTY_REDEEM_IDEMPOTENT_HIT", { userId: userID, key: normalizedKey });
                    return { entry: cached.body.data, loyaltyPoints: cached.body.loyaltyPoints };
                }

                // b. Acquire Lock
                lockKey = await acquireLock(normalizedKey, step);
                if (!lockKey) {
                    Metrics.increment("idempotency.lock_failure", 1, { flow: 'redeem' });
                    Logger.warn("LOYALTY_REDEEM_LOCK_FAIL", { userId: userID, key: normalizedKey, reason: 'Duplicate request in progress' });
                    throw new BadRequestError(`Duplicate request in progress for key: ${rawIdempotencyKey}`);
                }
                Metrics.increment("idempotency.lock_acquired", 1, { flow: 'redeem' });

                // --- 2. POLICY ENFORCEMENT (Pre-transactional Checks) ---
                if (redeemPoints > MAX_REDEMPTION_AMOUNT) {
                    Metrics.increment("loyalty.redeem.policy_fail", 1, { policy: 'max_amount' });
                    throw new BadRequestError(`Cannot redeem more than ${MAX_REDEMPTION_AMOUNT} points in a single transaction.`);
                }
                
                // Track daily redemptions (requires history lookup)
                const dailyRedemptions = await LoyaltyHistory.countDocuments({
                    user: userID,
                    type: 'redeem',
                    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } 
                });

                if (dailyRedemptions >= MAX_DAILY_REDEMPTIONS) {
                    Metrics.increment("loyalty.redeem.policy_fail", 1, { policy: 'max_daily' });
                    throw new BadRequestError(`Daily redemption limit of ${MAX_DAILY_REDEMPTIONS} reached.`);
                }

                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    // 3. ATOMIC STEP: Check sufficient balance AND deduct points
                    const updatedUser = await User.findOneAndUpdate(
                        // Atomically ensures balance is sufficient before decrementing
                        { _id: userID, loyaltyPoints: { $gte: redeemPoints } }, 
                        { $inc: { loyaltyPoints: -redeemPoints } },
                        { new: true, session }
                    ).lean();
                    
                    if (!updatedUser) {
                        const userCheck = await User.findById(userID).session(session).lean();
                        if (!userCheck) throw new NotFoundError("User not found");
                        
                        Metrics.increment("loyalty.redeem.insufficient_points");
                        throw new BadRequestError(`Insufficient points. Current balance: ${userCheck.loyaltyPoints}.`);
                    }

                    // 4. TRANSACTIONAL STEP: Create History Entry
                    const entry = await LoyaltyHistory.create([{
                        user: userID,
                        points: -redeemPoints, // Store as negative for debit
                        type: "redeem",
                        description,
                    }], { session });

                    await session.commitTransaction();

                    Metrics.increment("loyalty.redeem.success");

                    // 5. PERSIST RESPONSE and RELEASE LOCK (Success path)
                    const finalResult = { 
                        message: "Points redeemed",
                        entry: entry[0], 
                        loyaltyPoints: updatedUser.loyaltyPoints 
                    };
                    
                    await persistResponse(normalizedKey, requestPath, StatusCodes.OK, finalResult, step);

                    try { await REDIS_CLIENT.del(lockKey); } catch (e) { 
                        Logger.error("REDIS_LOCK_RELEASE_FAIL", { err: e.message, lockKey });
                    }

                    // 6. AUDIT/SECURITY LOG (Use Logger.security for high-risk actions like redemption)
                    Logger.security("LOYALTY_POINTS_REDEEMED", {
                        userId: userID, // Required by security contract
                        eventCode: 'POINT_REDEMPTION',
                        points: redeemPoints, 
                        newTotal: updatedUser.loyaltyPoints, 
                        key: normalizedKey 
                    });

                    span.setAttribute('loyalty.new_total', updatedUser.loyaltyPoints);

                    return finalResult;
                } catch (txErr) {
                    await session.abortTransaction();
                    try { await REDIS_CLIENT.del(lockKey); } catch (e) { 
                        Logger.error("REDIS_LOCK_RELEASE_FAIL_TX", { err: e.message, lockKey });
                    }
                    Metrics.increment("loyalty.redeem.transaction_fail");
                    span.recordException(txErr);
                    span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: txErr.message });
                    throw txErr;
                } finally {
                    session.endSession();
                }

            } catch (err) {
                if (lockKey) {
                    try { await REDIS_CLIENT.del(lockKey); } catch (e) { 
                        Logger.error("REDIS_LOCK_RELEASE_FAIL_CATCH", { err: e.message, lockKey });
                    }
                }
                throw err;
            }
        });
    }
    
    /**
     * ADMIN function to adjust points (Credit/Debit) for a user.
     * @param {string} adminID - The ID of the administrator performing the action.
     * @param {string} targetUserID - The ID of the user whose points are being adjusted.
     * @param {object} data - { points, description, rawIdempotencyKey }
     * @returns {object} { entry, loyaltyPoints }
     */
    static async adjustPoints(adminID, targetUserID, { points, description, rawIdempotencyKey }) {
        return Tracing.withSpan("LoyaltyService:adjustPoints", async (span) => {
            if (points === undefined || !description) {
                Metrics.increment("loyalty.adjust.bad_request");
                throw new BadRequestError("points and description are required for adjustment.");
            }

            const adminHasRole = await hasElevatedRole(adminID);
            if (!adminHasRole) {
                Metrics.increment("loyalty.adjust.permission_denied");
                Logger.security("PERMISSION_DENIED", {
                    userId: adminID,
                    eventCode: 'LOYALTY_ADJUST_ATTEMPT',
                    targetUserId: targetUserID,
                    attemptedPoints: points
                });
                throw new BadRequestError("Permission denied: Elevated privileges (admin/lead_engineer) required.");
            }

            const adjustment = Number(points); // Positive for credit, negative for debit
            const adjustmentType = adjustment >= 0 ? "earn" : "redeem";
            const absAdjustment = Math.abs(adjustment);
            const requestPath = `/loyalty/adjust`;
            const step = "default";
            
            span.setAttributes({
                'admin.id': adminID,
                'target_user.id': targetUserID,
                'loyalty.adjustment': adjustment,
                'loyalty.type': adjustmentType
            });
            
            // --- 1. IDEMPOTENCY CHECK & LOCK ACQUISITION ---
            let normalizedKey = null;
            let lockKey = null;

            try {
                const rawKey = sanitizeKey(rawIdempotencyKey);
                normalizedKey = normalizeKey(rawKey);
                span.setAttribute('idempotency.key', normalizedKey);

                const cached = await getCachedResponse(normalizedKey, step);
                if (cached) {
                    Metrics.increment("idempotency.hit", 1, { flow: 'adjust' });
                    Logger.info("LOYALTY_ADJUST_IDEMPOTENT_HIT", { userId: adminID, key: normalizedKey });
                    return { entry: cached.body.data, loyaltyPoints: cached.body.loyaltyPoints };
                }

                lockKey = await acquireLock(normalizedKey, step);
                if (!lockKey) {
                    Metrics.increment("idempotency.lock_failure", 1, { flow: 'adjust' });
                    throw new BadRequestError(`Duplicate request in progress for key: ${rawIdempotencyKey}`);
                }
                Metrics.increment("idempotency.lock_acquired", 1, { flow: 'adjust' });

                const session = await mongoose.startSession();
                session.startTransaction();

                try {
                    // 2. ATOMIC STEP: Update balance and ensure non-negative if debiting
                    const updateQuery = { $inc: { loyaltyPoints: adjustment } };
                    const findQuery = { _id: targetUserID };
                    
                    // If debiting, ensure the target user has sufficient points
                    if (adjustment < 0) {
                        findQuery.loyaltyPoints = { $gte: absAdjustment }; 
                    }

                    const updatedUser = await User.findOneAndUpdate(
                        findQuery,
                        updateQuery,
                        { new: true, session }
                    ).lean();

                    if (!updatedUser) {
                        const userCheck = await User.findById(targetUserID).session(session).lean();
                        if (!userCheck) throw new NotFoundError("Target user not found");
                        
                        Metrics.increment("loyalty.adjust.insufficient_points");
                        throw new BadRequestError(`Insufficient points to deduct ${absAdjustment}. User balance is ${userCheck.loyaltyPoints}.`);
                    }

                    // 3. TRANSACTIONAL STEP: Create History Entry
                    const entry = await LoyaltyHistory.create([{
                        user: targetUserID,
                        points: adjustment,
                        type: adjustmentType,
                        description: `Admin adjustment by ${adminID}: ${description}`,
                    }], { session });

                    await session.commitTransaction();

                    Metrics.increment("loyalty.adjust.success");

                    // 4. PERSIST RESPONSE and RELEASE LOCK
                    const finalResult = { 
                        message: "Points adjusted",
                        entry: entry[0], 
                        loyaltyPoints: updatedUser.loyaltyPoints 
                    };
                    
                    await persistResponse(normalizedKey, requestPath, StatusCodes.OK, finalResult, step);
                    
                    try { await REDIS_CLIENT.del(lockKey); } catch (e) {
                         Logger.error("REDIS_LOCK_RELEASE_FAIL", { err: e.message, lockKey });
                    }

                    // 5. AUDIT LOG (CRITICAL level for admin actions using Logger.audit)
                    Logger.audit("LOYALTY_POINTS_ADMIN_ADJUSTED", {
                        entityId: targetUserID, // The user entity being audited
                        action: adjustmentType.toUpperCase(),
                        actingUser: adminID, // Log the administrator
                        points: adjustment, 
                        newTotal: updatedUser.loyaltyPoints,
                        description: description,
                        key: normalizedKey,
                    });

                    span.setAttribute('loyalty.new_total', updatedUser.loyaltyPoints);

                    return finalResult;

                } catch (txErr) {
                    await session.abortTransaction();
                    try { await REDIS_CLIENT.del(lockKey); } catch (e) {
                        Logger.error("REDIS_LOCK_RELEASE_FAIL_TX", { err: e.message, lockKey });
                    }
                    Metrics.increment("loyalty.adjust.transaction_fail");
                    span.recordException(txErr);
                    span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: txErr.message });
                    throw txErr;
                } finally {
                    session.endSession();
                }

            } catch (err) {
                if (lockKey) {
                    try { await REDIS_CLIENT.del(lockKey); } catch (e) {
                        Logger.error("REDIS_LOCK_RELEASE_FAIL_CATCH", { err: e.message, lockKey });
                    }
                }
                throw err;
            }
        });
    }
}

module.exports = LoyaltyService;