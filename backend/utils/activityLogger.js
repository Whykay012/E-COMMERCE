// utils/activityLogger.js (COSMOS HYPER-FABRIC ZENITH: Event Sourcing Utility)
// Provides secure, non-blocking logging and efficient querying of user activity records.

const ActivityLog = require("../model/activityLog");
const logger = require("../config/logger"); // Winston/Pino logger for internal errors
const mongoose = require("mongoose");

// -------------------- CONSTANTS & CONFIG --------------------

// 💡 UPGRADE: Expanded and standardized list of allowed activity types
const allowedTypes = Object.freeze([
    "LOGIN",
    "LOGOUT",
    "REGISTER",
    "PASSWORD_RESET",
    "EMAIL_VERIFICATION",
    "CART_UPDATE",
    "CHECKOUT",
    "PAYMENT_INIT",
    "PAYMENT_SUCCESS",
    "ORDER_CREATED",
    "PROFILE_UPDATE",
    "WISHLIST_UPDATE",
    "ADMIN_ACTION",
    "RECENTLY_VIEWED", // 💡 REQUIRED ADDITION for recentlyViewedController
    "INVOICE_DOWNLOAD",
    "API_CALL_FAIL",
]);

// 💡 UPGRADE: Dynamic list of sensitive keys for robust masking
const SENSITIVE_KEYS = [
    "password", "otp", "token", "card", "ccv", "secret", "auth", "sessionid"
];

const DEFAULT_ACTIVITY_LIMIT = 50;

// -------------------- UTILITIES --------------------

/**
 * @desc Recursively sanitizes sensitive data fields in the meta object.
 * @param {object} data - The data structure to clean.
 * @returns {object} The sanitized data.
 */
const sanitizeMeta = (data) => {
    if (typeof data !== 'object' || data === null) {
        return data;
    }

    if (Array.isArray(data)) {
        return data.map(sanitizeMeta);
    }

    const sanitized = {};
    for (const key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;

        const lowerKey = key.toLowerCase();
        
        // 💡 UPGRADE: Dynamic and case-insensitive check for sensitive keys
        if (SENSITIVE_KEYS.some(sensitiveKey => lowerKey.includes(sensitiveKey))) {
            sanitized[key] = '[MASKED_ACTIVITY_DATA]';
        } else if (typeof data[key] === 'object' && data[key] !== null) {
            sanitized[key] = sanitizeMeta(data[key]); // Recurse
        } else {
            sanitized[key] = data[key];
        }
    }
    return sanitized;
};


// --------------------------------------------------------------------------------------------------
// CORE FUNCTION 1: LOG ACTIVITY (WRITE)
// --------------------------------------------------------------------------------------------------

/**
 * @desc Logs a single activity event asynchronously.
 * @param {object} params - Activity parameters.
 * @param {string|mongoose.Types.ObjectId} params.user - The user ID.
 * @param {string} params.type - The type of activity (must be in allowedTypes).
 * @param {string} params.description - A brief description.
 * @param {string} params.ipAddress - IP address of the request.
 * @param {object} [params.meta={}] - Additional context, sanitized before saving.
 */
async function logActivity({ user, type, description, ipAddress, meta = {} }) {
    // Non-blocking approach: immediately yield control if validation fails or user is missing.
    if (!user) {
        logger.warn("Activity log called without a user ID.");
        return;
    }

    try {
        // 1. Validation
        if (type && !allowedTypes.includes(type)) {
            logger.warn(`Unknown activity type: ${type}. Using 'MISC'.`);
            type = 'MISC'; 
        }

        // 2. 🛡️ Security: Sanitize sensitive data recursively
        const sanitizedMeta = sanitizeMeta(meta);
        
        // 3. Convert user ID if it's an object (Mongoose document)
        const userId = typeof user === "object" ? user._id : user;

        // 4. Persistence (Non-critical write)
        await ActivityLog.create({
            user: userId,
            type,
            description,
            ipAddress,
            meta: sanitizedMeta,
        });

    } catch (err) {
        // Must not break the main application thread.
        logger.error(`[FATAL] Failed to persist activity log for user ${user}:`, err.message);
    }
}


// --------------------------------------------------------------------------------------------------
// CORE FUNCTION 2: GET ACTIVITIES BY USER (READ) - Meeting the Prerequisite
// --------------------------------------------------------------------------------------------------

/**
 * @desc Retrieves specific activity logs for a given user, filtered by type.
 * @param {string} userId - The user ID to search for.
 * @param {string} eventType - The specific activity type (e.g., 'RECENTLY_VIEWED').
 * @param {number} [limit=50] - The maximum number of results to return.
 * @returns {Promise<Array<object>>} The list of matching activity log entries (lean objects).
 */
async function getActivitiesByUser(userId, eventType, limit = DEFAULT_ACTIVITY_LIMIT) {
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        logger.error(`Attempted to query activities with invalid userId: ${userId}`);
        return [];
    }
    
    // Build query filters
    const query = {
        user: userId,
    };
    
    if (eventType && allowedTypes.includes(eventType)) {
        query.type = eventType;
    } else if (eventType) {
        // Optionally throw for unknown events, but logging a warning is safer
        logger.warn(`Query requested unknown eventType: ${eventType}. Ignoring filter.`);
    }

    try {
        // 💡 UPGRADE: Use .lean() for faster query performance (returning plain JS objects)
        const activities = await ActivityLog.find(query)
            .sort({ createdAt: -1 }) // Most recent first
            .limit(parseInt(limit))
            .select('-__v') // Exclude Mongoose version key
            .lean(); 

        return activities;

    } catch (err) {
        logger.error(`Failed to retrieve activities for user ${userId}:`, err.message);
        // Fail gracefully by returning an empty array
        return [];
    }
}


module.exports = { 
    logActivity, 
    getActivitiesByUser, // 💡 EXPOSED: The required read function
    allowedTypes,
};