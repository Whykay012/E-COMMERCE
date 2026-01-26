// errors/featureDisabledError.js (TITAN NEXUS: Feature Flag Error)

const { StatusCodes } = require("http-status-codes");
// Assuming CustomApiError is the base class (like DomainError in your customErrors.js)
const CustomApiError = require("./customApiError"); 

/**
 * @class FeatureDisabledError
 * @extends CustomApiError
 * @desc Specialized error thrown when a user attempts to access or use a feature 
 * controlled by a Feature Flag that is currently disabled.
 * It provides context on which flag prevented the operation.
 */
class FeatureDisabledError extends CustomApiError {
    /**
     * @param {string} message - User-friendly message (e.g., "Product creation is temporarily disabled.").
     * @param {string} [featureKey="unknown_feature"] - The key of the feature flag that is disabled.
     * @param {string} [userId=null] - Optional ID of the user who triggered the error.
     */
    constructor(message, featureKey = "unknown_feature", userId = null) {
        // Use 503 Service Unavailable for maintenance, or 403 Forbidden for access control.
        // Sticking with 503 as used in the productService for temporary maintenance.
        super(message || `Feature '${featureKey}' is currently disabled.`, StatusCodes.SERVICE_UNAVAILABLE); 
        
        // --- Custom Error Properties (for logging and tracking) ---
        this.name = 'FeatureDisabledError';
        this.featureKey = featureKey;
        this.userId = userId;

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
            featureKey: this.featureKey,
            userId: this.userId,
            isOperational: true, // Often used to distinguish expected runtime errors
        };
    }
}

module.exports = FeatureDisabledError;