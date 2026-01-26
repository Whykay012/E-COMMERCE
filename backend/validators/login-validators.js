const { checkSchema } = require("express-validator");

const loginSchema = checkSchema({
  identifier: {
    in: ["body"],
    notEmpty: {
      errorMessage: "Username, email, or phone is required",
    },
  },
  password: {
    in: ["body"],
    isString: {
      errorMessage: "Password must be a string", // optional
    },
    notEmpty: {
      errorMessage: "Password is required",
    },
    isLength: {
      options: { min: 6 },
      errorMessage: "Password must be at least 6 characters long",
    },
  },
});

module.exports = loginSchema;
