// errors/concurrencyError.js

/**
 * @class ConcurrencyError
 * @description Custom error used for conflicts during atomic operations, 
 * typically when attempting to reserve stock or update a counter that has 
 * already been changed by another process (e.g., MongoDB write conflict or 
 * Redis atomic check failure).
 */
class ConcurrencyError extends CustomApiError {
    constructor(message = "A concurrent operation failed due to resource conflict.", statusCode = 409) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'ConcurrencyError';

        // Ensures the correct prototype chain for 'instanceof' checks
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ConcurrencyError);
        }
    }
}

module.exports = ConcurrencyError;