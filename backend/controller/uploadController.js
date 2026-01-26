const CloudinaryService = require("../services/cloudinaryService");
const deleteOldAsset = require("../utils/deleteOldCloudinaryAsset");
const { StatusCodes } = require("http-status-codes");
const asyncHandler = require("../middleware/asyncHandler");
const uploadQueue = require("../jobs/uploadQueue");
const Product = require("../model/product");
const User = require("../model/userModel");
const Banner = require("../model/banner");
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");


// --- USER CONTROLLERS ---

// USER avatar
const uploadAvatar = asyncHandler(async (req, res) => {
    if (!req.file) {
        return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ message: "No avatar uploaded" });
    }
    const user = await User.findById(req.user._id || req.user.id);
    if (!user) {
        return res
            .status(StatusCodes.NOT_FOUND)
            .json({ message: "User not found" });
    }

    // Upload buffer directly to Cloudinary
    const result = await CloudinaryService.uploadBuffer(req.file.buffer, {
        folder: "ecommerce/avatars",
        transformation: { width: 500, height: 500, crop: "fill" },
    });

    // delete old asset
    if (user.profilePic) await deleteOldAsset(user.profilePic, "image");

    user.profilePic = result.secure_url || result.url;
    await user.save();
    res
        .status(StatusCodes.OK)
        .json({ success: true, profilePic: user.profilePic });
});

// --- PRODUCT UPLOADS (ADMIN) ---

// ADMIN product images — attach to product (Async Queue)
const uploadProductImages = asyncHandler(async (req, res) => {
    if (!req.files || !req.files.length) {
        return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ message: "No images uploaded" });
    }
    const { productId } = req.body;
    if (!productId) {
        return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ message: "productId required" });
    }

    const product = await Product.findById(productId);
    if (!product) {
        return res
            .status(StatusCodes.NOT_FOUND)
            .json({ message: "Product not found" });
    }

    // enqueue background job that processes each file and updates DB
    const job = await uploadQueue.add("product-images", {
        files: req.files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })),
        productId,
    });
    res
        .status(StatusCodes.ACCEPTED)
        .json({ message: "Upload job queued", jobId: job.id });
});

// ADMIN product video (Synchronous)
const uploadProductVideo = asyncHandler(async (req, res) => {
    if (!req.file) {
        return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ message: "No video uploaded" });
    }
    const { productId } = req.body;
    if (!productId) {
        return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ message: "productId required" });
    }

    const product = await Product.findById(productId);
    if (!product) {
        return res
            .status(StatusCodes.NOT_FOUND)
            .json({ message: "Product not found" });
    }

    // remove existing video
    if (product.video?.public_id) {
        try {
            await CloudinaryService.deleteByPublicId(product.video.public_id, {
                resource_type: "video",
            });
        } catch (e) {
            /* ignore */
        }
    } else if (product.video) {
        await deleteOldAsset(product.video, "video");
    }

    const uploaded = await CloudinaryService.uploadBuffer(req.file.buffer, {
        folder: "ecommerce/products/videos",
        resource_type: "video",
    });
    product.video = { url: uploaded.secure_url, public_id: uploaded.public_id };
    await product.save();
    res.status(StatusCodes.CREATED).json({ success: true, video: product.video });
});

// --- BANNER UPLOADS (ADMIN) ---

// ADMIN banner upload (using CloudinaryService)
const uploadFestiveBanner = asyncHandler(async (req, res) => {
    if (!req.file) {
        return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ message: "No banner uploaded" });
    }

    const uploaded = await CloudinaryService.uploadBuffer(req.file.buffer, {
        folder: "ecommerce/banners",
    });

    const banner = await Banner.create({
        title: req.body.title || "Festive Banner",
        imageUrl: uploaded.secure_url,
        public_id: uploaded.public_id,
        active: !!req.body.active,
    });

    res.status(StatusCodes.CREATED).json({ success: true, banner });
});

// --- GENERIC MEDIA MANAGEMENT (ADMIN) ---

/**
 * Generic media replacement handler (Fixes the TypeError)
 * Assumes req.file exists and req.body.publicIdToDelete exists
 */
const replaceMedia = asyncHandler(async (req, res) => {
    if (!req.file) {
        throw new BadRequestError("New file is required for replacement.");
    }
    // assetType can be passed in the body (e.g., 'video', 'image')
    const { publicIdToDelete, assetType = "image" } = req.body; 

    // 1. Upload the new file
    const uploadOptions = {
        folder: `ecommerce/media/${assetType}s`,
        resource_type: assetType,
    };
    const newAsset = await CloudinaryService.uploadBuffer(req.file.buffer, uploadOptions);

    // 2. Delete the old file if ID is provided
    if (publicIdToDelete) {
        try {
            await CloudinaryService.deleteByPublicId(publicIdToDelete, {
                resource_type: assetType,
            });
        } catch (error) {
            console.warn(`Failed to delete old asset ${publicIdToDelete}:`, error.message);
            // Log warning but proceed with success response
        }
    }

    res.status(StatusCodes.OK).json({
        success: true,
        message: "Media replaced successfully",
        newUrl: newAsset.secure_url,
        newPublicId: newAsset.public_id,
        assetType,
    });
});

/**
 * Generic media deletion handler (Fixes the missing export)
 * Deletes a file based on its public ID
 */
const deleteMedia = asyncHandler(async (req, res) => {
    const { publicId, assetType = "image" } = req.body;

    if (!publicId) {
        throw new BadRequestError("publicId is required to delete media.");
    }

    try {
        await CloudinaryService.deleteByPublicId(publicId, {
            resource_type: assetType,
        });

        res.status(StatusCodes.OK).json({
            success: true,
            message: `Asset ${publicId} deleted successfully.`,
        });
    } catch (error) {
        if (error.http_code === 404) {
            return res.status(StatusCodes.OK).json({
                success: true,
                message: `Asset ${publicId} not found, but deletion request processed.`,
            });
        }
        console.error(`Error deleting asset ${publicId}:`, error);
        throw new Error("Failed to delete media asset.");
    }
});


// Corrected and expanded export syntax (VITAL FIX)
module.exports = { 
    uploadAvatar, 
    uploadProductImages, 
    uploadProductVideo,
    uploadFestiveBanner,
    replaceMedia, // <<< ADDED
    deleteMedia, // <<< ADDED
};