// routes/uploadRoutes.js
const express = require("express");
const router = express.Router();
const { uploadLimiter } = require("../../middleware/uploadLimiter");
const uploadValidator = require("../../middleware/uploadValidator");
const uploadController = require("../../controller/uploadController");
const cloudinaryErrorHandler = require("../../middleware/cloudinaryErrorHandler");

// Use your existing auth middleware names
const { authenticate } = require("../../middleware/authMiddleware");

// USER: avatar
router.post(
  "/user/avatar",
  authenticate,
  uploadLimiter,
  uploadValidator.avatarUpload,
  uploadController.uploadAvatar,
  cloudinaryErrorHandler
);

module.exports = router;
