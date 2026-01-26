const { StatusCodes } = require("http-status-codes");
const CustomApiError = require("./customApiError");

class UnauthenticatedError extends CustomApiError {
  constructor(message = "Authentication required") {
    super(message, StatusCodes.UNAUTHORIZED);
    this.name = "UnauthenticatedError";
  }
}

module.exports = UnauthenticatedError;
