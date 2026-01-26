// errors/mediaUploadError.js
const { StatusCodes } = require("http-status-codes");
const CustomApiError = require("./customApiError"); // Assumes CustomApiError is the base class

/**
 * @class MediaUploadError
 * @extends CustomApiError
 * @desc Specialized error for failures during external media upload (e.g., Cloudinary, S3).
 * It includes metadata necessary for rollback/compensation logic.
 */
class MediaUploadError extends CustomApiError {
    /**
     * @param {string} message - User-friendly message (e.g., "Failed to upload image: filename.jpg").
     * @param {string} [filename="unknown"] - The name of the file that failed to upload.
     * @param {Error} [originalError=null] - The underlying error caught from the external library (e.g., Cloudinary SDK error).
     */
    constructor(message, filename = "unknown", originalError = null) {
        // HTTP 422 Unprocessable Entity is often appropriate for file upload validation/service failures
        super(message || `Media upload failed for file: ${filename}.`, StatusCodes.UNPROCESSABLE_ENTITY); 
        
        // --- Custom Error Properties (for logging and tracking) ---
        this.name = 'MediaUploadError';
        this.filename = filename;
        
        // Serialize the original error for deep debugging in the logs
        this.originalErrorDetails = originalError ? {
            message: originalError.message,
            stack: originalError.stack,
            code: originalError.code // Useful for service-specific errors like Cloudinary's
        } : null;

        // Ensure the error instance is correctly set up
        Error.captureStackTrace(this, this.constructor);
    }
    
    /**
     * @desc Provides a clean object for logging or sending to monitoring systems.
     */
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            statusCode: this.statusCode,
            filename: this.filename,
            originalError: this.originalErrorDetails
        };
    }
}

module.exports = MediaUploadError;