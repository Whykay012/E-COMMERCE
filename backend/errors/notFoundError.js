// backend/errors/notFoundError.js
const CustomApiError = require("./customApiError");
const { StatusCodes } = require("http-status-codes");

class NotFoundError extends CustomApiError {
  constructor(message) {
    super(message, StatusCodes.NOT_FOUND); // 404 status code
  }
}

module.exports = NotFoundError;
