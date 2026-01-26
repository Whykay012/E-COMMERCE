const express = require("express");
const router = express.Router();
const { authenticate } = require("../../middleware/authMiddleware");
const  uploadLimiter  = require("../../middleware/uploadLimiter");
const {avatarUpload} = require("../../validators/uploadValidator");
// const uploadController = require("../../controller/uploadController");
const {uploadAvatar} = require("../../controller/uploadController");
const cloudinaryErrorHandler = require("../../middleware/cloudinaryErrorHandler");

// USER avatar
router.post(
 "/user/avatar",
 authenticate,
 uploadLimiter,
 avatarUpload,  // ✅ multer applied here
 uploadAvatar, // ✅ controller receives req.file
 cloudinaryErrorHandler
);

module.exports = router;