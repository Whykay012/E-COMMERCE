const { StatusCodes } = require("http-status-codes");
const CustomApiError = require("./customApiError");

class UnauthorizedError extends CustomApiError {
  constructor(message = "Access denied") {
    super(message, StatusCodes.UNAUTHORIZED);
    this.name = "UnauthorizedError";
  }
}

module.exports = UnauthorizedError;
