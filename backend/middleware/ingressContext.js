// middleware/ingressContext.js
const crypto = require("crypto");

/**
 * Adds root ingress correlation ID
 * and sets response header
 */
module.exports = function ingressContext(req, res, next) {
    req.ingressRequestId = crypto.randomUUID();
    res.setHeader("X-Request-Id", req.ingressRequestId);
    next();
};
