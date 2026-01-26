
const rateLimit = require('express-rate-limit');

// This middleware limits upload attempts to prevent abuse.
// Adjust the settings below based on your application's needs.
const uploadLimiter = rateLimit({
    // Window in milliseconds (15 minutes)
    windowMs: 15 * 60 * 1000, 
    // Max number of requests per IP within the window
    max: 10, 
    // Sets standard rate limit headers (RFC 6586)
    standardHeaders: true, 
    // Send rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, 
    message: {
        status: 429,
        message: 'Too many upload requests from this IP, please try again after 15 minutes.'
    },
    // Optional: Log when a limit is exceeded
    handler: (req, res, next, options) => {
        console.log(`Rate limit exceeded for IP: ${req.ip} on route: ${req.path}`);
        res.status(options.statusCode).send(options.message);
    }
});

module.exports = uploadLimiter;