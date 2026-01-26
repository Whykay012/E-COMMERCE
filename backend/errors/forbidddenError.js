// backend/errors/notFoundError.js
const CustomApiError = require("./customApiError");
const { StatusCodes } = require("http-status-codes");

class ForbiddenError extends CustomApiError {
  constructor(message) {
    super(message, StatusCodes.FORBIDDEN); // 403 status code
  }
}

module.exports = ForbiddenError;
