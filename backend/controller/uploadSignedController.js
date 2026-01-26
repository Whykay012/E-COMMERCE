const CloudinaryService = require("../services/cloudinaryService");
const { StatusCodes } = require("http-status-codes");
const asyncHandler = require("../middleware/asyncHandler");

// Create a server-side signature for a client to upload directly
// Note: for direct unsigned uploads use upload preset and skip signature.
exports.getUploadSignature = asyncHandler(async (req, res) => {
 const {
  folder = "ecommerce/uploads",
  timestamp = Math.floor(Date.now() / 1000),
 } = req.body;
 // payload keys used in signature must match client-provided params
 const payload = {
  timestamp,
  folder,
  // you can add eager transformations, public_id, etc.
 };
 const signature = CloudinaryService.createSignature(payload);
 res.status(StatusCodes.OK).json({
  signature,
  timestamp,
  api_key: process.env.CLOUDINARY_API_KEY,
  folder,
 });
});