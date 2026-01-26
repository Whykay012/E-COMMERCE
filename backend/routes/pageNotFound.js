const express = require("express");
const router = express.Router();
// Assuming you have a custom error class for 404s
const NotFoundError = require('../errors/notFoundError'); 

// -------------------------------------------------------------
// This router is the 404 handler. It must be mounted LAST in server.js 
// (before the final error handling middleware stack).
// -------------------------------------------------------------

/**
 * Catches all requests that have fallen through the main route handlers.
 * Creates a NotFoundError and forwards it to the centralized error middleware.
 */
router.use((req, res, next) => {
    // If the request reaches here, no previous route matched the request path/method.
    const error = new NotFoundError(`Resource not found: ${req.originalUrl}`);
    next(error); 
});

module.exports = router;