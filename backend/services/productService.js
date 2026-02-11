// services/productService.js (OMNIA-NEXUS - Full Infrastructure Integration)

const mongoose = require("mongoose");
const { StatusCodes } = require("http-status-codes");
const { performance } = require('perf_hooks');

// --- Infrastructure Imports (OMNIA-NEXUS) ---
const logger = require("../config/logger");
const { CircuitBreaker, ServiceUnavailableError } = require("./circuitBreaker"); 
const auditLogger = require("./auditLogger"); 

// 💡 THE ONLY DATA SERVICE YOU NEED:
const { 
  getProductDetailsByIds, 
  rebuildProductCacheAndNotify, 
} = require('./productDataService');
// 💡 MODIFIED IMPORT: Use structured import from the multi-tiered service
const { 
  getProductDetailsByIds, 
  rebuildProductCacheAndNotify, 
} = require('./productDataService'); 

// --- Core App Imports ---
const Product = require("../model/product");
const CloudinaryService = require("./cloudinaryService"); // External dependency
const FeatureFlagService = require("./featureFlagService"); 
const UserHistoryService = require("./userHistoryService"); 
const { queueJob, GENERAL_QUEUE_NAME } = require("../queue/jobQueue"); 

// --- Domain/Pattern Imports ---
const ProductValidator = require("../validators/productValidator");
const ProductEventEmitter = require("../events/productEventEmitter");
const  BadRequestError = require("../errors/bad-request-error");
const notFoundError = require("../errors/notFoundError");
const DomainError = require("../errors/domainError");
const ConflictError = require("../errors/onflictError");
const FeatureDisabledError = require("../errors/featureDisabledError");
const MediaUploadError = require("../errors/mediaUploadError");
const { ProductInputDTO, ProductOutputDTO } = require("../dtos/productDTO"); 
const Tracer = require("../utils/tracer"); 


// ----------------------------------------------------
// --- Configuration & Setup ---
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const PRODUCT_CACHE_TTL_SECONDS = 3600; // 1 hour (NOTE: Still used for related products logic below)
const PRODUCT_CACHE_STALE_SECONDS = 7200; // 2 hours stale fallback (Used by CacheUtil)

// Circuit Breaker Initialization (TITAN NEXUS: Bind action for correct 'this')
const cloudinaryBreaker = new CircuitBreaker(CloudinaryService.uploadBuffer.bind(CloudinaryService), {
 name: 'CloudinaryMediaUpload',
 failureThreshold: 5, 
 resetTimeout: 30000, // 30 seconds
});
// ----------------------------------------------------


// -------------------------------
// Core File Processing Utilities
// -------------------------------

/**
* @desc Extracts image and video files from the request files object.
*/
function extractFiles(files) { 
 const imagesFiles = Array.isArray(files?.images) ? files.images : [];
 let videoFile = null;
 if (files.file && ALLOWED_VIDEO_TYPES.includes(files.file.mimetype)) {
  videoFile = files.file;
 } else if (Array.isArray(files?.video) && files.video.length > 0) {
  videoFile = files.video[0];
 } else if (files?.video && files.video.buffer && ALLOWED_VIDEO_TYPES.includes(files.video.mimetype)) {
  videoFile = files.video;
 }
 return { imagesFiles, videoFile };
}

/**
* @desc Uploads images using the protected Cloudinary Circuit Breaker.
*/
async function uploadImagesToCloudinary(files = []) {
 const uploadPromises = files.slice(0, MAX_IMAGES).map(async (file) => {
  if (file.size > MAX_IMAGE_SIZE_BYTES || !ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
   logger.warn("Service: Skipping image file due to size or type mismatch.", { size: file.size, type: file.mimetype });
   return null;
  }

  try {
   // TITAN NEXUS: Use the Circuit Breaker
   const res = await cloudinaryBreaker.execute(file.buffer, {
    folder: "ecommerce/products/images",
    use_filename: true,
    unique_filename: true,
   });
   return {
    url: res.secure_url, public_id: res.public_id, size: file.size, mimeType: file.mimetype
   };
  } catch (error) {
   // Check for the custom ServiceUnavailableError code
   if (error.code === 'EOPENBREAKER') { 
    throw new ServiceUnavailableError("Media service is temporarily unavailable. Circuit is open."); 
   }
   logger.error("Cloudinary image upload failed (Service internal error).", { error: error.message });
   throw new MediaUploadError(`Failed to upload image: ${file.originalname}`);
  }
 });

 const uploaded = (await Promise.all(uploadPromises)).filter(Boolean);
 if (uploaded.length < files.length && files.length > 0) {
  logger.warn(`Only ${uploaded.length} of ${files.length} images were successfully processed.`);
 }
 return uploaded;
}

/**
* @desc Uploads video using the protected Cloudinary Circuit Breaker.
*/
async function uploadVideoToCloudinary(file) {
 if (!file || !ALLOWED_VIDEO_TYPES.includes(file.mimetype)) { return null; }

 try {
  // TITAN NEXUS: Use the Circuit Breaker
  const res = await cloudinaryBreaker.execute(file.buffer, {
   folder: "ecommerce/products/videos",
   resource_type: "video", use_filename: true, unique_filename: true,
  });
  return {
   url: res.secure_url, public_id: res.public_id, resource_type: "video", size: file.size, mimeType: file.mimetype
  };
 } catch (error) {
  // Check for the custom ServiceUnavailableError code
  if (error.code === 'EOPENBREAKER') {
   throw new ServiceUnavailableError("Media service is temporarily unavailable. Circuit is open.");
  }
  logger.error("Cloudinary video upload failed (Service internal error).", { error: error.message });
  throw new MediaUploadError(`Failed to upload video: ${file.originalname}`);
 }
}

/**
* @desc Queues a compensation job to clean up media if the DB transaction fails.
*/
async function queueCompensationJob(images, video) {
 if (images.length === 0 && !video) return;
 
 // Enqueue a job to asynchronously clean up orphaned cloud media
 const job = await queueJob(
  GENERAL_QUEUE_NAME,  
  "product.media.rollback",  
  {   
   images: images.map(img => ({ public_id: img.public_id })),
   video: video ? { public_id: video.public_id } : null,
  }
 );
 logger.error(`MongoDB transaction failed. Queued Cloudinary rollback job.`, { jobId: job.id });
}

function validateId(id) {
 if (!mongoose.Types.ObjectId.isValid(id)) {
  throw new BadRequestError("Invalid product ID format");
 }
}


// -------------------------------
// Read / Query Services (Utilizing TITAN NEXUS Caching)
// -------------------------------

exports.getProducts = async (queryParams) => {
 const traceId = Tracer.getTraceId(queryParams);
 logger.info("Executing getProducts query.", { traceId, filters: queryParams });

 const Model = Product;
 
 const {
  page = 1, limit = 12, search, category, subCategory,
  minPrice, maxPrice, sortBy, isFeatured, includeDeleted = "false",
 } = queryParams;

 const q = {};
 if (includeDeleted !== "true") q.status = { $ne: "deleted" };

 if (search) q.$text = { $search: search };
 if (category) q.category = category;
 if (subCategory) q.subCategory = subCategory;
 if (typeof isFeatured !== "undefined") q.isFeatured = isFeatured === "true";

 if (minPrice || maxPrice) {
  q.price = {};
  if (minPrice) q.price.$gte = Number(minPrice);
  if (maxPrice) q.price.$lte = Number(maxPrice);
 }

 const isRandom =
  !search && !category && !subCategory && typeof isFeatured === "undefined" && !minPrice && !maxPrice && !sortBy;

 let products;
 let total;

 if (isRandom) {
  total = await Model.countDocuments(q);
  products = await Model.aggregate([
   { $match: q },
   { $sample: { size: Number(limit) } },
  ]);
 } else {
  let sortOption = { createdAt: -1 };
  if (sortBy === "priceAsc") sortOption = { price: 1 };
  else if (sortBy === "priceDesc") sortOption = { price: -1 };
  else if (sortBy === "discount") sortOption = { discount: -1 };

  total = await Model.countDocuments(q);
  products = await Model.find(q)
   .populate("createdBy", "username email")
   .skip((page - 1) * limit)
   .limit(Number(limit))
   .sort(sortOption)
   .lean();
 }
 
 const totalPages = Math.ceil(total / limit);
 const outputProducts = products.map(p => new ProductOutputDTO(p));

 return { products: outputProducts, total, page: Number(page), totalPages };
};

exports.getRandomProducts = async (size, userId = null) => {
 const traceId = Tracer.getTraceId();
 logger.info("Executing getRandomProducts with session awareness.", { traceId, size, userId });

 if (!await FeatureFlagService.isEnabled('product_personalization_active', userId)) {
  logger.warn(`[${traceId}] Product personalization is disabled. Falling back to basic random sample.`);
  return Product.aggregate([
   { $match: { status: { $ne: "deleted" } } },
   { $sample: { size } },
  ]).then(products => products.map(p => new ProductOutputDTO(p)));
 }


 const matchQuery = { status: { $ne: "deleted" } };
 const excludedIds = await UserHistoryService.getRecentProductIds(userId);

 if (excludedIds.length > 0) {
  matchQuery._id = { $nin: excludedIds }; 
  logger.debug(`[${traceId}] Excluding ${excludedIds.length} products from random sample.`);
 }

 const products = await Product.aggregate([
  { $match: matchQuery },
  { $sample: { size } },
 ]);

 const productIdsShown = products.map(p => p._id.toString());
 
 if (userId) {
  // Enterprise Grade: Fire-and-forget logging to history service
  UserHistoryService.logProductsShown(userId, productIdsShown).catch(err => {
   logger.error(`Failed to log user history: ${err.message}`);
  }); 
 }

 return products.map(p => new ProductOutputDTO(p));
};

/**
 * @name exports.getProductById
 * @desc Retrieves a product using the multi-tiered caching service (L1/L2/Redlock/DB).
 * @param {string} id - The ID of the product.
 */
exports.getProductById = async (id) => {
  validateId(id);
  
  try {
    const start = performance.now();
    
    // 💡 CALL THE ENGINE
    // This now handles L1, L2, and the DB Circuit Breaker internally
    const productDetails = await getProductDetailsByIds([id]);
    const productOutput = productDetails[0];

    // If the DB is down and the Circuit is OPEN, 
    // the line above will throw an Error('CIRCUIT_BREAKER_OPEN')
    
    if (!productOutput) {
      throw new notFoundError(`Product with ID ${id} not found.`);
    }

    // Related products: Still a DB call, but we wrap it in a secondary try/catch
    // so that if related products fail, the main product still loads!
    let related = [];
    try {
      related = await Product.find({
        _id: { $ne: productOutput._id }, 
        category: productOutput.category, 
        status: "active",
      }).limit(5).lean();
    } catch (e) {
      logger.warn("Related products failed to load, continuing with main product.");
    }

    return { 
      product: productOutput, 
      related: related.map(p => new ProductOutputDTO(p)) 
    };

  } catch (error) {
    // 💡 NEW: Handle the Circuit Breaker "Open" state
    if (error.message === 'CIRCUIT_BREAKER_OPEN') {
       throw new ServiceUnavailableError("Database is under heavy load. Please try again in a moment.");
    }
    
    if (error instanceof notFoundError) throw error;
    
    logger.error(`Critical failure in getProductById: ${error.message}`);
    throw new DomainError("Internal system error.");
  }
};


// -------------------------------
// Write / Mutate Services (Utilizing TITAN NEXUS Audit Logging & Resilience)
// -------------------------------

exports.createProduct = async ({ files, creatorId, idempotencyKey, ...payload }) => {
 const traceId = Tracer.getTraceId(payload);

 if (!await FeatureFlagService.isEnabled('product_creation_enabled')) {
  auditLogger.dispatchLog({ level: 'SECURITY', event: 'PRODUCT_CREATE_BLOCKED', userId: creatorId, details: { reason: 'Feature Flag Disabled', traceId } });
  throw new FeatureDisabledError("Product creation is temporarily disabled for maintenance.");
 }
 
 if (idempotencyKey) {
  const existingProduct = await Product.findOne({ idempotencyKey });
  if (existingProduct) {
   logger.warn("Idempotent create detected, returning existing resource.", { idempotencyKey });
   return new ProductOutputDTO(existingProduct);
  }
 }

 const inputDTO = new ProductInputDTO({ ...payload, creatorId, idempotencyKey });
 const dbPayload = { ...inputDTO };
 ProductValidator.validateCreationPayload(dbPayload);

 const session = await mongoose.startSession();
 session.startTransaction();

 let uploadedImages = [];
 let uploadedVideo = null;

 try {
  const { imagesFiles, videoFile } = extractFiles(files);
  uploadedImages = await uploadImagesToCloudinary(imagesFiles);
  uploadedVideo = await uploadVideoToCloudinary(videoFile);

  const [product] = await Product.create([{
   ...dbPayload, images: uploadedImages, video: uploadedVideo, status: "active",
  }], { session });

  await session.commitTransaction();
  await ProductEventEmitter.emit('ProductCreated', new ProductOutputDTO(product), 'ProductService', { traceId });

  // TITAN NEXUS: Audit Log
  auditLogger.dispatchLog({ 
   level: 'INFO', 
   event: 'PRODUCT_CREATED', 
   userId: creatorId, 
   details: { productId: product._id.toString(), name: product.name, traceId } 
  });

  // 🔑 CACHE INVALIDATION: Use the full write-through/publish logic from the new service
  await rebuildProductCacheAndNotify(product._id.toString()); 

  logger.info(`Product created successfully.`, { traceId, productId: product._id });
  return new ProductOutputDTO(product);

 } catch (error) {
  await session.abortTransaction();
  
  // COMPENSATION: Only queue rollback if *we* successfully uploaded media, but DB failed.
  if (uploadedImages.length > 0 || uploadedVideo) {
    await queueCompensationJob(uploadedImages, uploadedVideo); 
  }

  if (error.code === 'EOPENBREAKER') {
   auditLogger.dispatchLog({ level: 'CRITICAL', event: 'MEDIA_SERVICE_DOWN', userId: creatorId, details: { breaker: cloudinaryBreaker.name, traceId } });
   throw new ServiceUnavailableError("Media service is temporarily unavailable.");
  }
  
  if (error instanceof DomainError) throw error; 
  
  logger.error(`Product creation failed: ${error.message}`, { traceId, error: error.name });
  throw new DomainError("Failed to create product due to an internal system error.", StatusCodes.INTERNAL_SERVER_ERROR);
 } finally {
  session.endSession();
 }
};

exports.updateProduct = async ({ id, files, traceId, ...updates }) => {
 validateId(id);
 traceId = Tracer.getTraceId({ traceId });

 if (!await FeatureFlagService.isEnabled('product_updates_enabled')) {
  auditLogger.dispatchLog({ level: 'SECURITY', event: 'PRODUCT_UPDATE_BLOCKED', details: { productId: id, reason: 'Feature Flag Disabled', traceId } });
  throw new FeatureDisabledError("Product updates are temporarily disabled for maintenance.");
 }

 const inputDTO = new ProductInputDTO(updates);
 const dbUpdates = { ...inputDTO }; 
 delete dbUpdates.createdBy; delete dbUpdates.idempotencyKey; 
 ProductValidator.validateUpdatePayload(dbUpdates);

 const session = await mongoose.startSession();
 session.startTransaction();

 let jobData = { images: [], video: null }; // Media to be deleted (old media)
 let uploadedImages = []; // Newly uploaded media
 let uploadedVideo = null;

 try {
  const product = await Product.findById(id).session(session);
  if (!product || product.status === "deleted") { throw new NotFoundError(`Product with ID ${id} not found.`); }

  const { imagesFiles, videoFile } = extractFiles(files);
  
  if (imagesFiles.length > 0) {
   // Collect old media public_ids for cleanup job
   if (product.images && product.images.length > 0) { jobData.images.push(...product.images.map(img => ({ public_id: img.public_id }))); }
   uploadedImages = await uploadImagesToCloudinary(imagesFiles);
   product.images = uploadedImages;
  }

  if (videoFile) {
   // Collect old video public_id for cleanup job
   if (product.video) { jobData.video = { public_id: product.video.public_id }; }
   uploadedVideo = await uploadVideoToCloudinary(videoFile);
   product.video = uploadedVideo;
  }

  Object.assign(product, dbUpdates);
  product.updatedAt = new Date(); 
  await product.save({ session });
  
  await session.commitTransaction();
  await ProductEventEmitter.emit('ProductUpdated', new ProductOutputDTO(product), 'ProductService', { traceId });

  // TITAN NEXUS: Audit Log
  auditLogger.dispatchLog({ 
   level: 'INFO', 
   event: 'PRODUCT_UPDATED', 
   details: { productId: product._id.toString(), updatedFields: Object.keys(dbUpdates).join(','), traceId } 
  });

  // 🔑 CACHE INVALIDATION: Use the full write-through/publish logic from the new service
  await rebuildProductCacheAndNotify(id); 

  // ASYNC Cleanup of OLD media
  if (jobData.images.length > 0 || jobData.video) {
   await queueJob(GENERAL_QUEUE_NAME, "product.media.delete", jobData); 
  }
  
  logger.info(`Product updated successfully.`, { traceId, productId: id });
  return new ProductOutputDTO(product);

 } catch (error) {
  await session.abortTransaction();
  
  // COMPENSATION: Rollback newly uploaded media if DB save failed
  if (uploadedImages.length > 0 || uploadedVideo) {
   await queueCompensationJob(uploadedImages, uploadedVideo); 
  }
  
  if (error.code === 'EOPENBREAKER') throw new ServiceUnavailableError("Media service is temporarily unavailable.");
  if (error instanceof DomainError) throw error;
  
  logger.error(`Product update failed: ${error.message}`, { traceId, productId: id });
  throw new DomainError("Failed to update product due to an internal system error.", StatusCodes.INTERNAL_SERVER_ERROR);
 } finally {
  session.endSession();
 }
};

// -------------------------------
// Stock Management (TITAN NEXUS: Audit Logging & Cache Invalidation)
// -------------------------------

exports.decrementStock = async (id, quantity) => {
 validateId(id);
 const traceId = Tracer.getTraceId({ id, quantity });
 
 if (quantity <= 0) { throw new BadRequestError("Quantity must be positive for stock decrement."); }

 try {
  const updatedProduct = await Product.findOneAndUpdate(
   { _id: id, stock: { $gte: quantity }, status: 'active' }, 
   { $inc: { stock: -quantity }, $set: { updatedAt: new Date() } },
   { new: true, runValidators: true, lean: true }
  );

  if (!updatedProduct) {
   const product = await Product.findById(id).lean();
   if (!product) throw new NotFoundError(`Product with ID ${id} not found.`);
   if (product.stock < quantity) throw new ConflictError(`Insufficient stock for product ${id}. Available: ${product.stock}`);
   throw new DomainError(`Product ${id} cannot be updated. Status is: ${product.status}`, StatusCodes.CONFLICT);
  }

  await ProductEventEmitter.emit('ProductStockDecremented', { id: updatedProduct._id.toString(), quantity: quantity, newStock: updatedProduct.stock }, 'InventoryService', { traceId });

  // TITAN NEXUS: Audit Log
  auditLogger.dispatchLog({ 
   level: 'RISK', 
   event: 'STOCK_DECREMENTED', 
   details: { productId: id, quantity, newStock: updatedProduct.stock, traceId } 
  });

  // 🔑 CACHE INVALIDATION: Use the full write-through/publish logic from the new service
  await rebuildProductCacheAndNotify(id); 
  
  logger.info(`Stock decremented successfully.`, { traceId, productId: id, newStock: updatedProduct.stock });
  return new ProductOutputDTO(updatedProduct);

 } catch (error) {
  logger.error(`Stock decrement failed for product ${id}.`, { traceId, error: error.message });
  if (error instanceof DomainError) throw error;
  throw new DomainError("Failed to update stock due to an internal system error.", StatusCodes.INTERNAL_SERVER_ERROR);
 }
};

exports.incrementStock = async (id, quantity) => {
 validateId(id);
 const traceId = Tracer.getTraceId({ id, quantity });
 
 if (quantity <= 0) { throw new BadRequestError("Quantity must be positive for stock increment."); }

 try {
  const updatedProduct = await Product.findOneAndUpdate(
   { _id: id, status: 'active' },
   { $inc: { stock: quantity }, $set: { updatedAt: new Date() } },
   { new: true, runValidators: true, lean: true }
  );

  if (!updatedProduct) {
    const product = await Product.findById(id).lean();
    if (!product) throw new NotFoundError(`Product with ID ${id} not found.`);
    throw new DomainError(`Product ${id} cannot be updated. Status is: ${product.status}`, StatusCodes.CONFLICT);
  }

  await ProductEventEmitter.emit('ProductStockIncremented', { id: updatedProduct._id.toString(), quantity: quantity, newStock: updatedProduct.stock }, 'InventoryService', { traceId });

  // TITAN NEXUS: Audit Log
  auditLogger.dispatchLog({ 
   level: 'INFO', 
   event: 'STOCK_INCREMENTED', 
   details: { productId: id, quantity, newStock: updatedProduct.stock, traceId } 
  });

  // 🔑 CACHE INVALIDATION: Use the full write-through/publish logic from the new service
  await rebuildProductCacheAndNotify(id); 

  logger.info(`Stock incremented successfully.`, { traceId, productId: id, newStock: updatedProduct.stock });
  return new ProductOutputDTO(updatedProduct);

 } catch (error) {
  logger.error(`Stock increment failed for product ${id}.`, { traceId, error: error.message });
  if (error instanceof DomainError) throw error;
  throw new DomainError("Failed to update stock due to an internal system error.", StatusCodes.INTERNAL_SERVER_ERROR);
 }
};


// -------------------------------
// Delete and Restore Methods (TITAN NEXUS: Audit Logging & Cache Invalidation)
// -------------------------------

exports.softDeleteProduct = async (id, purgeMedia) => {
 validateId(id);
 const product = await Product.findById(id);
 if (!product || product.status === "deleted") { throw new NotFoundError(`Product with ID ${id} not found or already deleted.`); }

 const traceId = Tracer.getTraceId();
 const session = await mongoose.startSession();
 session.startTransaction();

 try {
  product.status = "deleted";
  product.deletedAt = new Date(); product.updatedAt = new Date(); 
  await product.save({ session });
  await session.commitTransaction();
  await ProductEventEmitter.emit('ProductSoftDeleted', new ProductOutputDTO(product), 'ProductService', { traceId });

  // TITAN NEXUS: Audit Log
  auditLogger.dispatchLog({ 
   level: 'SECURITY', 
   event: 'PRODUCT_SOFT_DELETED', 
   details: { productId: id, purgeMedia, traceId } 
  });

  // 🔑 CACHE INVALIDATION: Use the full write-through/publish logic from the new service
  await rebuildProductCacheAndNotify(id); 

  if (purgeMedia) {
   await queueJob(GENERAL_QUEUE_NAME, "product.media.delete", { images: product.images.map(img => ({ public_id: img.public_id })), video: product.video ? { public_id: product.video.public_id } : null });
   product.images = []; product.video = null; await product.save(); // Save changes outside session
  }
  
  logger.info(`Product soft-deleted successfully.`, { traceId, productId: id });
 } catch (error) {
  await session.abortTransaction();
  logger.error(`Soft delete failed: ${error.message}`, { traceId, productId: id });
  throw new DomainError("Failed to soft-delete product due to an internal system error.", StatusCodes.INTERNAL_SERVER_ERROR);
 } finally { session.endSession(); }
};

exports.restoreProduct = async (id) => {
 validateId(id);
 const product = await Product.findById(id);
 
 if (!product || product.status !== "deleted") { throw new NotFoundError(`Product with ID ${id} not found or is not currently deleted.`); }

 const traceId = Tracer.getTraceId();
 const session = await mongoose.startSession();
 session.startTransaction();

 try {
  product.status = "active";
  product.deletedAt = null; product.updatedAt = new Date(); 
  await product.save({ session });
  await session.commitTransaction();
  await ProductEventEmitter.emit('ProductRestored', new ProductOutputDTO(product), 'ProductService', { traceId });

  // TITAN NEXUS: Audit Log
  auditLogger.dispatchLog({ 
   level: 'INFO', 
   event: 'PRODUCT_RESTORED', 
   details: { productId: id, traceId } 
  });

  // 🔑 CACHE INVALIDATION: Use the full write-through/publish logic from the new service
  await rebuildProductCacheAndNotify(id); 

  logger.info(`Product restored successfully.`, { traceId, productId: id });
  return new ProductOutputDTO(product);
 } catch (error) {
  await session.abortTransaction();
  logger.error(`Restore failed: ${error.message}`, { traceId, productId: id });
  throw new DomainError("Failed to restore product due to an internal system error.", StatusCodes.INTERNAL_SERVER_ERROR);
 } finally { session.endSession(); }
};

exports.hardDeleteProduct = async (id) => {
 validateId(id);
 const product = await Product.findById(id);
 
 if (!product) { throw new NotFoundError(`Product with ID ${id} not found.`); }

 const traceId = Tracer.getTraceId();
 const session = await mongoose.startSession();
 session.startTransaction();
 let job;

 try {
  // Queue cleanup job BEFORE deleting the DB record (Crucial for atomicity/compensation)
  job = await queueJob(GENERAL_QUEUE_NAME, "product.media.delete", { images: product.images.map(img => ({ public_id: img.public_id })), video: product.video ? { public_id: product.video.public_id } : null, });
  
  await Product.deleteOne({ _id: id }).session(session);
  await session.commitTransaction();
  await ProductEventEmitter.emit('ProductHardDeleted', { id: id }, 'ProductService', { traceId });

  // TITAN NEXUS: Audit Log
  auditLogger.dispatchLog({ 
   level: 'CRITICAL', 
   event: 'PRODUCT_HARD_DELETED', 
   details: { productId: id, mediaJobId: job.id, traceId } 
  });

  // 🔑 CACHE INVALIDATION: Use the full write-through/publish logic from the new service
  // This ensures the L2 key is deleted and followers are notified.
  await rebuildProductCacheAndNotify(id); 

  logger.info(`Product permanently deleted. Media cleanup queued.`, { traceId, productId: id, jobId: job.id });

 } catch (error) {
  await session.abortTransaction();
  logger.error(`Hard delete failed: ${error.message}`, { traceId, productId: id });
  throw new DomainError("Failed to permanently delete product due to an internal system error.", StatusCodes.INTERNAL_SERVER_ERROR);
 } finally { session.endSession(); }
};


// -------------------------------
// Initialization and Exports
// -------------------------------

if (FeatureFlagService.initialize) {
 FeatureFlagService.initialize();
}

module.exports = {
 getProducts: exports.getProducts,
 getRandomProducts: exports.getRandomProducts,
 getProductById: exports.getProductById,
 createProduct: exports.createProduct,
 updateProduct: exports.updateProduct,
 decrementStock: exports.decrementStock, 
 incrementStock: exports.incrementStock, 
 softDeleteProduct: exports.softDeleteProduct,
 restoreProduct: exports.restoreProduct,
 hardDeleteProduct: exports.hardDeleteProduct,
};