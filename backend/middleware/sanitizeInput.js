const sanitize = require("sanitize-html");

// --- Production-Ready Sanitation Configuration ---
// This configuration allows minimal, safe HTML tags often useful in product reviews
// (e.g., bold, italic, lists, and safe links) while stripping everything dangerous.
const STANDARD_SANITIZE_OPTIONS = {
    // Allowed Tags: Basic formatting tags for better review readability
    allowedTags: [ 'b', 'i', 'em', 'strong', 'a', 'p', 'ul', 'ol', 'li', 'br', 'blockquote' ],
    
    // Allowed Attributes: Restrict attributes to only what is absolutely necessary (e.g., 'href' for links)
    allowedAttributes: {
        'a': [ 'href' ] 
    },
    
    // Allowed Schemes: Only allow standard, safe protocols for links
    allowedSchemes: [ 'http', 'https', 'mailto' ],
    
    // Explicitly forbid classes and styles to prevent abuse
    allowedClasses: {},
    allowedStyles: {},
};

// Configuration for absolute zero-tolerance (strips everything, resulting in plain text)
const STRICT_SANITIZE_OPTIONS = {
    allowedTags: [],
    allowedAttributes: {},
    allowedSchemes: [],
};

/**
 * Middleware to sanitize incoming string fields in req.body.
 * * Best practice for large scale: Apply this AFTER input validation (Joi/Schema) 
 * but BEFORE your controller logic.
 *
 * @param {string[]} fields - Array of field names to sanitize. Defaults to ['title', 'text'].
 * @param {boolean} [strict=false] - If true, strips ALL HTML tags (plain text only). 
 * If false (default), allows minimal safe formatting.
 */
function sanitizeInput(fields = ["title", "text"], strict = false) {
    
    // Determine the configuration options based on the 'strict' flag
    const options = strict ? STRICT_SANITIZE_OPTIONS : STANDARD_SANITIZE_OPTIONS;

    return (req, res, next) => {
        if (!req.body) {
            console.warn('Sanitization skipped: Request body is missing.');
            return next();
        }

        try {
            fields.forEach((f) => {
                const value = req.body[f];
                
                // Only sanitize if the value is a non-empty string.
                if (typeof value === "string" && value.length > 0) {
                    // Trim whitespace before sanitizing for cleaner data storage
                    const trimmedValue = value.trim();
                    
                    req.body[f] = sanitize(trimmedValue, options);
                }
            });
            next();
        } catch (error) {
            // Log the error but allow the request to proceed to avoid crashing the server
            // due to non-critical sanitation issues.
            console.error(`Sanitization error in field(s) [${fields.join(', ')}]`, error);
            next();
        }
    };
}

// Export the function directly for simple importing
module.exports = sanitizeInput;