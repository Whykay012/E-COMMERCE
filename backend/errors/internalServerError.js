const { StatusCodes } = require("http-status-codes");
const CustomApiError = require("./customApiError");

class InternalServerError extends CustomApiError {
  constructor(message = "Internal Server Error") {
    super(message, StatusCodes.INTERNAL_SERVER_ERROR);
    this.name = "InternalServerError";
  }
}

module.exports = { InternalServerError };
