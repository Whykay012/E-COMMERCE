// dtos/productDTO.js

/**
 * @class ProductInputDTO
 * @desc Defines the structure and contract for data entering the service (Create/Update).
 * It filters out internal/calculated fields and includes only what the client can send.
 */
class ProductInputDTO {
    constructor({ 
        // Core Fields
        name, slug, description, price, discount, 
        // Categories/Brand
        category, subCategory, brand, 
        // Inventory/Flags
        stock, isAvailable, status, isFeatured, 
        // Media (Handled separately by file processing, but kept for clarity if JSON metadata is sent)
        images, video, 
        // Association/Metadata
        metadata, 
        // Internal Association
        creatorId, 
        // NEBULA: Idempotency Key
        idempotencyKey 
    }) {
        // --- Core Information ---
        this.name = name;
        this.slug = slug;
        this.description = description;

        // --- Pricing ---
        this.price = price;
        this.discount = discount; // Note: Validator handles percentage/range check

        // --- Categories ---
        this.category = category; // Note: Validator handles enum check
        this.subCategory = subCategory; // Note: Validator handles enum check
        this.brand = brand;

        // --- Inventory ---
        this.stock = stock;
        this.isAvailable = isAvailable;
        this.status = status;
        this.isFeatured = isFeatured;

        // --- Media (Public IDs for existing media updates, though usually handled by separate routes) ---
        this.images = images;
        this.video = video;
        
        // --- Association ---
        this.createdBy = creatorId;
        
        // --- Metadata ---
        this.metadata = metadata;
        
        // --- Idempotency ---
        this.idempotencyKey = idempotencyKey;
        
        // IMPORTANT: Internal fields like ratingsAverage, ratingsQuantity, createdAt, updatedAt 
        // must NOT be included here as they are managed by the service/database triggers.
    }
}

/**
 * @class ProductOutputDTO
 * @desc Defines the structure and contract for data leaving the service (Read/Response).
 * It converts the Mongoose object/document into a stable API response format.
 */
class ProductOutputDTO {
    /**
     * @param {Object} productModel - The Mongoose document or lean object.
     */
    constructor(productModel) {
        // Ensure consistent ID type and naming
        this.id = productModel._id ? productModel._id.toString() : null;

        // --- Core Information ---
        this.name = productModel.name;
        this.slug = productModel.slug;
        this.description = productModel.description;

        // --- Pricing ---
        this.price = productModel.price;
        this.discount = productModel.discount;
        
        // VIRTUAL FIELD: Calculate the price after discount for the client
        this.priceAfterDiscount = productModel.priceAfterDiscount !== undefined 
            ? productModel.priceAfterDiscount 
            : (
                productModel.price && productModel.discount !== undefined
                ? +(productModel.price * (1 - productModel.discount / 100)).toFixed(2)
                : productModel.price
            );

        // --- Categories ---
        this.category = productModel.category;
        this.subCategory = productModel.subCategory;
        this.brand = productModel.brand;

        // --- Inventory ---
        this.stock = productModel.stock;
        this.isAvailable = productModel.isAvailable;
        this.status = productModel.status;
        this.isFeatured = productModel.isFeatured;

        // --- Media ---
        // Project only the necessary fields (URL and ID)
        this.images = Array.isArray(productModel.images) 
            ? productModel.images.map(img => ({ url: img.url, public_id: img.public_id })) 
            : [];
            
        this.video = productModel.video 
            ? { url: productModel.video.url, public_id: productModel.video.public_id } 
            : null;

        // --- Rating System (Frontend Display) ---
        this.ratingsAverage = productModel.ratingsAverage;
        this.ratingsQuantity = productModel.ratingsQuantity;
        this.reviewsCount = productModel.reviewsCount;
        
        // --- Association ---
        this.createdBy = productModel.createdBy; // Full user object if populated, otherwise ID
        this.metadata = productModel.metadata;

        // --- Timestamps ---
        this.createdAt = productModel.createdAt;
        this.updatedAt = productModel.updatedAt;
    }
}

module.exports = { ProductInputDTO, ProductOutputDTO };