const CustomApiError = require("./customApiError");

/**
 * @class TooManyRequestsError
 * @description Custom error for rate-limiting scenarios (HTTP 429).
 * Used when a user or service exceeds the allowed threshold of requests
 * within a specific window.
 */
class TooManyRequestsError extends CustomApiError {
    /**
     * @param {string} message - Error description.
     * @param {number} retryAfter - Seconds until the client should retry.
     * @param {number} statusCode - HTTP 429.
     */
    constructor(
        message = "Too many requests. Please try again later.", 
        retryAfter = 60, 
        statusCode = 429
    ) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'TooManyRequestsError';
        
        // Zenith Polish: Attach the Retry-After header value to the error object
        // This allows your error handler middleware to set the 'Retry-After' header automatically.
        this.retryAfter = retryAfter;

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, TooManyRequestsError);
        }
    }
}

module.exports = TooManyRequestsError;