// Assuming this is the content of: errors/domainError.js

const CustomApiError = require("./customApiError"); // <-- Import your base API class

class DomainError extends CustomApiError {
    /**
     * @param {string} [message] - A human-readable description of the error.
     * @param {number} [statusCode] - The HTTP status code (e.g., 400, 403).
     * @param {number} [code] - An optional, internal application-specific error code.
     * @param {Object} [data] - Optional additional information or context.
     */
    constructor(message = 'A business rule violation occurred.', statusCode = 400, code, data = {}) {
        
        // CRITICAL: Call the parent (CustomApiError) constructor, passing the message and status code.
        super(message, statusCode); 

        // Set the name of the error
        this.name = this.constructor.name;
        
        // Attach custom domain properties
        this.internalCode = code; // Use a distinct name for clarity
        this.data = data;
        this.isDomainError = true;
    }
}

module.exports = DomainError;