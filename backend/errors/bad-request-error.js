const CustomApiError = require("./customApiError");
const { StatusCodes } = require("http-status-codes");

class BadRequestError extends CustomApiError {
  constructor(message) {
    super(message, StatusCodes.BAD_REQUEST); // 400 status code
  }
}

module.exports = BadRequestError;
