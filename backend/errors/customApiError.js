// Extends the built-in Error class to create custom, categorized HTTP errors.
class CustomApiError extends Error {
  constructor(message, statusCode) {
    super(message); // Set the error message
    this.statusCode = statusCode; // Attach a status code (like 400, 401, etc.)
    // Captures the error stack trace, excluding the constructor call, 
    // making the stack more relevant for debugging.
    Error.captureStackTrace(this, this.constructor); 
  }
}

module.exports = CustomApiError;