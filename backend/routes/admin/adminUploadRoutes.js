const express = require("express");
const router = express.Router();
const { authenticate, adminOnly } = require("../middleware/authMiddleware");
const uploadLimiter = require("../middleware/uploadLimiter");
const { validate } = require("../../middleware/validate"); // Import validate
const { 
    deleteMediaSchema, 
    replaceMediaSchema 
} = require("../../validators/admin.validators"); 
const {
 uploadProductImages,
 uploadProductVideo,
 deleteMedia,
 replaceMedia,
} = require("../controller/adminUploadController");

const {
 uploadProductImage, // Multer + Cloudinary config for images
 uploadProductVideo: cloudVideo, // Multer + Cloudinary config for video
} = require("../config/cloudinary");

// Protect all admin upload endpoints
router.use(authenticate, adminOnly, uploadLimiter);

// upload multiple images (field name 'images')
router.post(
 "/product/images",
 uploadProductImage[0], // Multer processing
 uploadProductImage[1], // Cloudinary upload
 uploadProductImages
);

// upload single video (field 'video')
router.post("/product/video", cloudVideo[0], cloudVideo[1], uploadProductVideo);

// replace media (single file) - Requires validation of publicIdToDelete in body
router.post(
 "/media/replace",
 uploadProductImage[0], // Multer processing (for the new file)
 uploadProductImage[1], // Cloudinary upload (for the new file)
 validate(replaceMediaSchema), // Validate body fields (publicIdToDelete, folder)
 replaceMedia
);

// delete by public id - Requires validation of publicId in body
router.post("/media/delete", 
    validate(deleteMediaSchema), // Validate body fields (publicId)
    deleteMedia
);

module.exports = router;