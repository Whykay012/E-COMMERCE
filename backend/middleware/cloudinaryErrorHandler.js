// middleware/cloudinaryErrorHandler.js
const { StatusCodes } = require("http-status-codes");
const logger = require("../config/logger");

function cloudinaryErrorHandler(err, req, res, next) {
  if (!err) return next();
  logger.error("Cloudinary error", { message: err.message, stack: err.stack });

  if (err.code === "LIMIT_FILE_SIZE") {
    return res
      .status(StatusCodes.BAD_REQUEST)
      .json({ message: "File too large", details: err.message });
  }
  if (
    err.message &&
    (err.message.includes("Invalid file type") ||
      err.message.includes("Allowed"))
  ) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: err.message });
  }
  if (err.http_code || (err.message && /cloudinary/i.test(err.message))) {
    return res
      .status(StatusCodes.BAD_GATEWAY)
      .json({ message: "Cloudinary error", details: err.message });
  }
  next(err);
}

module.exports = cloudinaryErrorHandler;
