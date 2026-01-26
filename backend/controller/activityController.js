const { StatusCodes } = require("http-status-codes");
const mongoose = require("mongoose");
// Assuming asyncHandler is available and imported from a path like "../middleware/asyncHandler"
const asyncHandler = require("../middleware/asyncHandler"); 
const ActivityLog = require("../model/activityLog");

// --- Constants for better readability and maintainability ---
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DEFAULT_SORT_FIELD = "createdAt";
const TEXT_SCORE_FIELD = "score"; // Explicit constant for the meta score field
const MONGO_TEXT_INDEX_ERROR = 27;

const SORT_ORDER_MAP = {
    asc: 1,
    desc: -1,
    [TEXT_SCORE_FIELD]: { $meta: "textScore" }, 
};
const DEFAULT_SORT_ORDER = SORT_ORDER_MAP.desc; 

/**
 * Robustly lists activities with pagination, deep filtering, and optimized text search.
 * NOTE: Wrapped in asyncHandler for automated error delegation.
 * @param {object} req - Express request object (expects req.user.userID)
 * @param {object} res - Express response object
 * @param {function} next - Express next middleware function (used by asyncHandler)
 */
const listActivities = async (req, res, next) => { // Removed outer try...catch
    
    // 1. Input Parameters (Assumes Joi validation has been run prior)
    let {
        page: rawPage,
        limit: rawLimit,
        type,
        startDate,
        endDate,
        keyword,
        sortBy,
        order,
        actorID, 
        objectID, 
    } = req.query;

    // 2. Pagination
    const page = Math.max(parseInt(rawPage) ?? DEFAULT_PAGE, 1);
    const limit = Math.min(
        Math.max(parseInt(rawLimit) ?? DEFAULT_LIMIT, 1),
        MAX_LIMIT
    );
    const skip = (page - 1) * limit;

    // 3. Dynamic Query Construction
    const query = {
        // Base Filter: Current User's logs
        user: req.user.userID,
    };
    
    // Simple indexed filters
    if (type) query.type = type;

    // Filtering by specific related IDs (requires pre-validation)
    // NOTE: Keep these checks if you are not using a dedicated validation middleware.
    if (actorID) {
        if (!mongoose.Types.ObjectId.isValid(actorID)) {
            return res.status(StatusCodes.BAD_REQUEST).json({ msg: "Invalid actorID format." });
        }
        query.actor = actorID; 
    }

    if (objectID) {
        if (!mongoose.Types.ObjectId.isValid(objectID)) {
            return res.status(StatusCodes.BAD_REQUEST).json({ msg: "Invalid objectID format." });
        }
        query.object = objectID; 
    }

    // Date Range Filter (createdAt is indexed)
    if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) {
            const start = new Date(startDate);
            if (isNaN(start))
                return res.status(StatusCodes.BAD_REQUEST).json({ msg: "Invalid startDate format." });
            query.createdAt.$gte = start;
        }
        if (endDate) {
            const end = new Date(endDate);
            if (isNaN(end))
                return res.status(StatusCodes.BAD_REQUEST).json({ msg: "Invalid endDate format." });
            // Set time to 23:59:59.999 for inclusive end-of-day search
            end.setHours(23, 59, 59, 999);
            query.createdAt.$lte = end;
        }
    }

    // 4. Optimized Keyword Search & Fallback Prep
    const projection = {};
    let sort = {};
    let useTextSearch = false;

    if (keyword) {
        // Attempt the fast Text Index search
        query.$text = { $search: keyword };
        projection[TEXT_SCORE_FIELD] = SORT_ORDER_MAP[TEXT_SCORE_FIELD]; // { score: { $meta: "textScore" } }
        sort[TEXT_SCORE_FIELD] = SORT_ORDER_MAP[TEXT_SCORE_FIELD];
        useTextSearch = true;
    }

    // 5. Sorting Parameters 
    const sortField = sortBy || DEFAULT_SORT_FIELD;
    const sortOrder = SORT_ORDER_MAP[order] ?? DEFAULT_SORT_ORDER;
    
    // Add the user's requested sort field.
    if (!useTextSearch || sortField !== TEXT_SCORE_FIELD) {
        sort[sortField] = sortOrder;
    }
    
    // 6. Execute Queries Concurrently with Text Index Error Handling
    let logs;
    let totalCount;

    try {
        [logs, totalCount] = await Promise.all([
            ActivityLog.find(query, projection).sort(sort).skip(skip).limit(limit).lean(),
            ActivityLog.countDocuments(query),
        ]);
    } catch (err) {
        // 🔥 Refined Text Index Error Catching: Handles the specific code for missing index
        if (useTextSearch && err.code === MONGO_TEXT_INDEX_ERROR) {
            console.warn("MongoDB Text Index is missing. Falling back to slower RegEx search.");
            
            // --- Fallback Strategy ---
            delete query.$text; // Remove the text query
            delete projection[TEXT_SCORE_FIELD]; // Remove score projection
            delete sort[TEXT_SCORE_FIELD]; // Remove score sort
            useTextSearch = false;

            // Apply RegEx search to relevant fields
            const regex = new RegExp(keyword, 'i');
            query.$or = [
                { description: regex }, 
                { details: regex }, 
                { type: regex }
            ];

            // Re-execute queries without text search (slower but functional)
            [logs, totalCount] = await Promise.all([
                ActivityLog.find(query, projection).sort(sort).skip(skip).limit(limit).lean(),
                ActivityLog.countDocuments(query),
            ]);
        } else {
            // Re-throw any other (non-text index) error. This will be caught by asyncHandler.
            throw err;
        }
    }

    // 7. Response
    const totalPages = Math.ceil(totalCount / limit);

    res.status(StatusCodes.OK).json({
        page,
        limit,
        totalCount,
        totalPages,
        count: logs.length,
        logs,
    });
};

// If using the external asyncHandler middleware:
module.exports = { listActivities: asyncHandler(listActivities) };
// Otherwise, use the original export:
// module.exports = { listActivities };