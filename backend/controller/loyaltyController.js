// controllers/loyalty.controller.js

const { StatusCodes } = require("http-status-codes");
const LoyaltyService = require("../services/LoyaltyService");
const NotFoundError = require("../errors/notFoundError"); // Assuming this is defined

// --- Helper to extract Idempotency Key ---
const extractIdempotencyKey = (req) => {
    // Standard practice is to look in headers first, or fallback to body/query if necessary
    return req.headers['x-idempotency-key'] || req.headers['idempotency-key'] || req.body.idempotencyKey;
};

// -------------------- GET USER BALANCE --------------------
const getLoyaltyBalance = async (req, res, next) => {
    try {
        // Assume req.user.userID is populated by prior authentication middleware
        const userID = req.user.userID;
        
        // 🔑 Delegation: Read operation handled by Service
        const balance = await LoyaltyService.getBalance(userID);

        res.status(StatusCodes.OK).json({
            userID,
            loyaltyPoints: balance,
        });
    } catch (err) {
        next(err);
    }
};

// -------------------- AWARD POINTS (WRITE) --------------------
const awardPoints = async (req, res, next) => {
    try {
        const { points, description, orderId } = req.body;
        const rawIdempotencyKey = extractIdempotencyKey(req);

        // 🔑 Command Pattern: Delegate transactional write to the Service
        const result = await LoyaltyService.awardPoints(req.user.userID, {
            points,
            description,
            orderId,
            rawIdempotencyKey,
        });

        // The Service handles all idempotency/caching; we just return the final result.
        res.status(StatusCodes.CREATED).json({
            message: "Points awarded successfully.",
            ...result, // { entry, loyaltyPoints }
        });
    } catch (err) {
        next(err); // Pass error to Express error handling middleware
    }
};

// -------------------- REDEEM POINTS (WRITE) --------------------
const redeemPoints = async (req, res, next) => {
    try {
        const { points, description } = req.body;
        const rawIdempotencyKey = extractIdempotencyKey(req);

        // 🔑 Command Pattern: Delegate transactional write and policy enforcement
        const result = await LoyaltyService.redeemPoints(req.user.userID, {
            points,
            description,
            rawIdempotencyKey,
        });

        res.status(StatusCodes.OK).json({
            message: "Points redeemed successfully.",
            ...result, // { entry, loyaltyPoints }
        });
    } catch (err) {
        next(err);
    }
};

// -------------------- ADMIN ADJUST POINTS (CRITICAL WRITE) --------------------
const adjustPoints = async (req, res, next) => {
    try {
        // Assume req.user.userID is the admin making the request
        const adminID = req.user.userID; 
        const { targetUserID, points, description } = req.body;
        const rawIdempotencyKey = extractIdempotencyKey(req);

        // Input validation check (simplified)
        if (!targetUserID) {
            return next(new NotFoundError("Target user ID is required."));
        }

        // 🔑 Command Pattern: Delegate critical administrative action
        const result = await LoyaltyService.adjustPoints(adminID, targetUserID, {
            points,
            description,
            rawIdempotencyKey,
        });

        res.status(StatusCodes.OK).json({
            message: "Points adjusted by administrator.",
            ...result,
        });
    } catch (err) {
        next(err);
    }
};

// -------------------- GET LOYALTY HISTORY --------------------
// This function would query the database directly or call another service function
// It typically does not need idempotency or transaction management as it is a read operation
const getLoyaltyHistory = async (req, res, next) => {
    try {
        // ... (Implementation to fetch history, likely using a separate service or model)
        res.status(StatusCodes.OK).json({
             message: "History endpoint placeholder."
        });
    } catch (err) {
        next(err);
    }
};


module.exports = {
    getLoyaltyBalance,
    awardPoints,
    redeemPoints,
    adjustPoints,
    getLoyaltyHistory,
};