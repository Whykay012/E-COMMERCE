const express = require("express");
const router = express.Router();
const uploadLimiter = require("../../middleware/uploadLimiter");
const uploadValidator = require("../../validators/uploadValidator"); 
const uploadController = require("../../controller/uploadController"); 
const cloudinaryErrorHandler = require("../../middleware/cloudinaryErrorHandler");
const { getUploadSignature } = require("../../controller/uploadSignedController");
// Use your existing auth middleware names
const { authenticate, adminOnly } = require("../../middleware/authMiddleware");

// USER: avatar
// Upload field name must match validator: 'avatar'
router.post(
 "/user/avatar",
 authenticate,
 uploadLimiter,
 uploadValidator.avatarUpload,
 uploadController.uploadAvatar,
 cloudinaryErrorHandler
);

// ADMIN: product images (field name 'images', body.productId required)
router.post(
 "/admin/product/images",
 authenticate,
 adminOnly,
 uploadLimiter,
 uploadValidator.productImagesUpload, // Multer middleware
 uploadController.uploadProductImages,
 cloudinaryErrorHandler
);

// ADMIN: product video (field 'video', body.productId required)
router.post(
 "/admin/product/video",
 authenticate,
 adminOnly,
 uploadLimiter,
 uploadValidator.productVideoUpload, // Multer middleware
 uploadController.uploadProductVideo,
 cloudinaryErrorHandler
);

// ADMIN: Cloudinary signature endpoint for client-side direct uploads
router.post(
 "/cloudinary-signature",
 authenticate,
 adminOnly,
 getUploadSignature
);

// ADMIN: banners (field 'banner')
router.post(
 "/admin/banner",
 authenticate,
 adminOnly,
 uploadLimiter,
 uploadValidator.bannerUpload, // Multer middleware
 uploadController.uploadFestiveBanner,
 cloudinaryErrorHandler
);

// ADMIN: replace media (single file upload for generic replacement)
// Field name must be 'file' to match validator, body must contain publicIdToDelete
router.post(
 "/admin/media/replace",
 authenticate,
 adminOnly,
 uploadLimiter,
 uploadValidator.singleFileUpload, // Using generic single file upload
 uploadController.replaceMedia, 
 cloudinaryErrorHandler
);

// ADMIN: delete media by public id
router.post(
 "/admin/media/delete",
 authenticate,
 adminOnly,
 uploadLimiter,
 // No file upload middleware needed here
 uploadController.deleteMedia 
);

module.exports = router;