// utils/correlation.js
const crypto = require("crypto");

function attachCorrelation(req, res, next) {
  req.ingressRequestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.ingressRequestId);
  next();
}

module.exports = {
  attachCorrelation
};
