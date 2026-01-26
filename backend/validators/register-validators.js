// validators/registerValidator.js
const { checkSchema } = require("express-validator");

const registerSchema = checkSchema({
  firstName: {
    in: ["body"],
    isString: true,
    notEmpty: { errorMessage: "First name is required" },
  },
  lastName: {
    in: ["body"],
    isString: true,
    notEmpty: { errorMessage: "Last name is required" },
  },
  age: {
    in: ["body"],
    isInt: {
      options: { min: 13, max: 120 },
      errorMessage: "Age must be between 13 and 120",
    },
  },
  address: {
    in: ["body"],
    isString: true,
    notEmpty: { errorMessage: "Address is required" },
    isLength: {
      options: { min: 5, max: 100 },
      errorMessage: "Address must be 5-100 characters",
    },
  },
  state: {
    in: ["body"],
    isString: true,
    notEmpty: { errorMessage: "State is required" },
  },
  country: {
    in: ["body"],
    isString: true,
    notEmpty: { errorMessage: "Country is required" },
  },
  dob: {
    in: ["body"],
    isISO8601: { errorMessage: "Date of birth must be a valid date" },
  },
  email: {
    in: ["body"],
    isEmail: { errorMessage: "Invalid email format" },
    normalizeEmail: true,
  },
  password: {
    in: ["body"],
    isString: true,
    isLength: {
      options: { min: 6 },
      errorMessage: "Password must be at least 6 characters",
    },
  },
  phone: {
    in: ["body"],
    isString: true,
    matches: {
      options: [/^\+?[0-9]{7,15}$/],
      errorMessage: "Invalid phone number format",
    },
  },
  username: {
    in: ["body"],
    isString: true,
    matches: {
      options: [/^[a-zA-Z0-9_]+$/],
      errorMessage:
        "Username can only contain letters, numbers, and underscores",
    },
    isLength: {
      options: { min: 3, max: 30 },
      errorMessage: "Username must be 3–30 characters",
    },
  },
});

module.exports = registerSchema;
