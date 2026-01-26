const multer = require("multer");

// memory storage
const storage = multer.memoryStorage();

// allowed MIME types & sizes
const IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const VIDEO_TYPES = ["video/mp4", "video/mov", "video/webm"];
const ALL_TYPES = [...IMAGE_TYPES, ...VIDEO_TYPES]; // Added generic support

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_BANNER_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_GENERIC_SIZE = 25 * 1024 * 1024; // 25MB for generic upload

const fileFilter = (allowedTypes) => (req, file, cb) => {
if (!allowedTypes.includes(file.mimetype)) {
 return cb(
 new Error(
  `Invalid file type: ${file.mimetype}. Allowed: ${allowedTypes.join(
  ", "
  )}`
 )
 );
}
cb(null, true);
};

module.exports = {
avatarUpload: multer({
 storage,
 limits: { fileSize: MAX_IMAGE_SIZE },
 fileFilter: fileFilter(IMAGE_TYPES),
}).single("avatar"),
productImagesUpload: multer({
 storage,
 limits: { fileSize: MAX_IMAGE_SIZE },
 fileFilter: fileFilter(IMAGE_TYPES),
}).array("images", 5),
productVideoUpload: multer({
 storage,
 limits: { fileSize: MAX_VIDEO_SIZE },
 fileFilter: fileFilter(VIDEO_TYPES),
}).single("video"),
bannerUpload: multer({
 storage,
 limits: { fileSize: MAX_BANNER_SIZE },
 fileFilter: fileFilter(IMAGE_TYPES),
}).single("banner"),
  // New generic single file upload (uses 'file' as the field name)
  singleFileUpload: multer({
    storage,
    limits: { fileSize: MAX_GENERIC_SIZE },
    fileFilter: fileFilter(ALL_TYPES),
  }).single("file"),
};