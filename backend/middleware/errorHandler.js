// middleware/errorHandler.js (COSMOS HYPER-FABRIC FINAL TIER)
// - Focuses on Traceability, Self-Correction, and Robust State Management.
// - Ensures that logging failure does not cause application crash.

const { StatusCodes } = require("http-status-codes");
const AuditLogger = require("../services/auditLogger"); 
const { DomainError } = require("../errors/customErrors"); 

// =============================================================================
// 💡 LOGGING ABSTRACTION (Context-Aware and Resilient)
// =============================================================================

const structuredLog = (level, error, req, statusCode, message, internalCode) => {
    try {
        // Determine which details to log based on severity
        const isCritical = statusCode >= 500;
        
        // 💡 UPGRADE: Explicitly retrieve and ensure context IDs for traceability
        const correlationId = req.headers['x-correlation-id'] || 'N/A';
        const traceId = req.headers['x-request-id'] || `GEN_${Date.now()}`;

        const requestDetails = {
            url: req.originalUrl,
            method: req.method,
            ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
            userId: req.user ? req.user.id : 'SYSTEM_GUEST',
            
            // 💡 UPGRADE: Context IDs prioritized for searchability
            correlationId,
            traceId,
            
            // Only log body and stack for critical errors (5xx)
            ...(isCritical ? {
                body: req.body, 
                stack: error.stack,
            } : {}),
            query: req.query,
            
            // Log the error classification details
            httpStatus: statusCode,
            errorMessage: message,
            errorName: error.name,
            internalCode: internalCode,
            rawCode: error.code,
        };
        
        // Use the resilient AuditLogger (which uses process.nextTick for non-blocking dispatch)
        AuditLogger.log({
            level: isCritical ? AuditLogger.LEVELS.CRITICAL : AuditLogger.LEVELS.WARN,
            event: internalCode || (isCritical ? 'UNHANDLED_SERVER_ERROR' : 'OPERATIONAL_ERROR'),
            userId: requestDetails.userId,
            details: requestDetails, // Pass the entire, unified context object
        });

    } catch (loggingError) {
        // 💡 UPGRADE: Graceful Logging Failure - Log locally and continue
        console.error(
            `🔥 FATAL: AUDIT LOGGER FAILED. The error itself will not stop the response. Error: ${loggingError.message}`,
            { originalError: error.message, loggingErrorStack: loggingError.stack }
        );
        // The primary error response mechanism below will still function.
    }
};

// =============================================================================
// 👑 CORE ERROR HANDLER
// =============================================================================

const errorHandler = (err, req, res, next) => {
    // 1. Check if headers have already been sent
    if (res.headersSent) return next(err);

    let statusCode = StatusCodes.INTERNAL_SERVER_ERROR;
    let message = "An unexpected server error occurred.";
    let internalCode = 'INTERNAL_SERVER_ERROR';
    let isClientError = false; 
    
    // 2. 💡 UPGRADE: Handle Express Fallbacks (404 and 405)
    // These errors often come from the router or other Express middleware
    if (err.status === StatusCodes.NOT_FOUND) {
        statusCode = StatusCodes.NOT_FOUND;
        message = `The requested resource/route was not found: ${req.method} ${req.originalUrl}`;
        internalCode = 'ROUTE_NOT_FOUND';
        isClientError = true;
    } else if (err.status === StatusCodes.METHOD_NOT_ALLOWED) {
        statusCode = StatusCodes.METHOD_NOT_ALLOWED;
        message = `Method ${req.method} not allowed for this route.`;
        internalCode = 'METHOD_NOT_ALLOWED';
        isClientError = true;
    } 
    
    // --- A. Handle Custom/Operational Errors (DomainError and custom statusCode) ---
    
    else if (err instanceof DomainError) {
        statusCode = err.statusCode || StatusCodes.BAD_REQUEST;
        message = err.message;
        internalCode = err.code || 'CUSTOM_DOMAIN_ERROR';
        isClientError = statusCode < 500;
    }
    
    // --- B. Handle Infrastructure/Framework Errors ---

    // Mongoose Validation Error (400)
    else if (err.name === "ValidationError") {
        statusCode = StatusCodes.BAD_REQUEST;
        message = Object.values(err.errors).map((e) => e.message).join(", ");
        internalCode = 'MONGO_VALIDATION_FAILED';
        isClientError = true;
    } 
    // Mongoose Duplicate Key Error (400)
    else if (err.code === 11000) {
        statusCode = StatusCodes.BAD_REQUEST;
        message = `Duplicate value entered for: ${Object.keys(err.keyValue).join(", ")}. Please use a different value.`;
        internalCode = 'MONGO_DUPLICATE_KEY';
        isClientError = true;
    } 
    // Mongoose Cast Error (404/400)
    else if (err.name === "CastError") {
        statusCode = StatusCodes.NOT_FOUND;
        message = `Resource not found. Invalid ID format: ${err.value}`;
        internalCode = 'MONGO_CAST_ERROR';
        isClientError = true;
    }

    // JWT Errors (401)
    else if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
        statusCode = StatusCodes.UNAUTHORIZED;
        message = (err.name === "TokenExpiredError") ? "Token expired. Please login again." : "Invalid token. Authorization denied.";
        internalCode = (err.name === "TokenExpiredError") ? 'JWT_EXPIRED' : 'JWT_INVALID';
        isClientError = true;
    }

    // Body Parsing/File Errors (400)
    else if (err.type === "entity.parse.failed" || err.code === "LIMIT_FILE_SIZE") {
        statusCode = StatusCodes.BAD_REQUEST;
        message = (err.type === "entity.parse.failed") ? "Invalid JSON payload in the request body." : "File too large. Maximum size limit exceeded.";
        internalCode = 'EXPRESS_PARSING_ERROR';
        isClientError = true;
    }

    // 💡 UPGRADE: Generic catch-all for errors that explicitly set statusCode
    else if (err.statusCode && err.statusCode >= 400) {
        statusCode = err.statusCode;
        message = err.message;
        internalCode = err.code || 'HTTP_CLIENT_ERROR';
        isClientError = true;
    }
    
    // --- C. Observability & Logging ---
    
    // Log the error with full context and stack trace if it's a server error
    if (statusCode >= 500) {
        // Log all 5xx errors as CRITICAL
        structuredLog(AuditLogger.LEVELS.CRITICAL, err, req, statusCode, message, internalCode);

        // Security: Mask the message for production 5xx errors
        if (process.env.NODE_ENV === "production") {
            message = "An unexpected internal server error occurred. We are investigating this issue.";
        }
    } else {
        // Log all 4xx errors as WARN (Operational)
        structuredLog(AuditLogger.LEVELS.WARN, err, req, statusCode, message, internalCode);
    }
    
    // --- D. Send Response ---
    // 
    return res.status(statusCode).json({
        success: false,
        message,
        code: internalCode, // Always return the machine-readable internal code
        // Only send the stack trace in non-production environments for security
        ...(process.env.NODE_ENV !== "production" ? { stack: err.stack } : {}),
    });
};

module.exports = errorHandler;