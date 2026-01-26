// backend/errors/notFoundError.js
const CustomApiError = require("./customApiError");
const { StatusCodes } = require("http-status-codes");

class ConflictError extends CustomApiError {
  constructor(message) {
    super(message, StatusCodes.CONFLICT);
  }
}

module.exports = ConflictError;
