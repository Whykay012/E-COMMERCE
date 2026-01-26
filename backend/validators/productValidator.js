const { BadRequestError } = require("../errors/customErrors");

// --- Configuration/Domain Constants ---
const MAX_DISCOUNT_PERCENTAGE = 70;
const VALID_TAGS_MAX = 10;
const SKU_REGEX = /^[A-Z0-9]{3,20}(-[A-Z0-9]+)?$/; // Example: ABC-12345 or XYZ999

class ProductValidator {
    /**
     * @desc Validates core business fields before DB interaction.
     * @param {Object} payload - The product data (name, price, stock, category, discount, sku, tags, variants).
     * @throws {BadRequestError} If validation fails.
     */
    static validateCreationPayload(payload) {
        const { 
            name, 
            price, 
            stock, 
            category, 
            discount, 
            sku, 
            tags, 
            variants 
        } = payload;

        // --- 1. Basic Required Field & Type Validation (Core Rules) ---

        if (!name || typeof name !== 'string' || name.length < 3 || name.length > 255) {
            throw new BadRequestError("Product name must be a string between 3 and 255 characters.");
        }
        if (typeof price !== 'number' || price <= 0 || price > 999999) {
            throw new BadRequestError("Price must be a positive number and reasonable value.");
        }
        if (typeof stock !== 'number' || stock < 0) {
            throw new BadRequestError("Stock must be a non-negative number.");
        }
        if (!category || typeof category !== 'string' || category.length < 2) {
            throw new BadRequestError("Category is required and must be a valid string.");
        }

        // --- 2. Format/Pattern Validation (SKU and Tags) ---
        
        // SKU Format Check (Must be present for new products)
        if (!sku || typeof sku !== 'string' || !SKU_REGEX.test(sku)) {
            throw new BadRequestError(`SKU is invalid or missing. Must match pattern ${SKU_REGEX.source}.`);
        }

        // Tags Check (Optional, but must be correct format if provided)
        if (tags) {
            if (!Array.isArray(tags) || tags.length > VALID_TAGS_MAX) {
                throw new BadRequestError(`Tags must be an array and cannot exceed ${VALID_TAGS_MAX} items.`);
            }
            if (tags.some(tag => typeof tag !== 'string' || tag.length < 2 || tag.length > 50)) {
                throw new BadRequestError("All tags must be non-empty strings between 2 and 50 characters.");
            }
        }

        // --- 3. Referential/Cross-Field Validation (Discount Logic) ---
        
        if (typeof discount === 'number') {
            if (discount < 0) {
                throw new BadRequestError("Discount cannot be negative.");
            }
            if (discount > price) {
                 // Check if discount (monetary amount) exceeds the price (unlikely for a percentage, but safe)
                throw new BadRequestError("Discount value cannot be greater than the original price.");
            }
            
            // Assuming discount is a percentage (0-100) or a separate field handles the type:
            if (discount > MAX_DISCOUNT_PERCENTAGE) {
                throw new BadRequestError(`Discount percentage cannot exceed ${MAX_DISCOUNT_PERCENTAGE}%.`);
            }
        }

        // --- 4. Conditional/Business Logic Validation (Product Variants) ---

        if (Array.isArray(variants) && variants.length > 0) {
            // Rule: If product has variants, the main product's 'stock' must be 0 
            // because inventory is managed solely by the variants.
            if (stock !== 0) {
                throw new BadRequestError("If variants are present, the main product stock must be zero.");
            }

            // Rule: Validate each variant structure
            variants.forEach((variant, index) => {
                if (!variant.size || !variant.color || typeof variant.stock !== 'number' || variant.stock < 0) {
                    throw new BadRequestError(`Variant at index ${index} is missing required fields (size, color, stock).`);
                }
                // (Further checks like price, unique SKU within variants, etc. would go here)
            });
        }
        
        // Rule: If a product is marked as "digital" (hypothetical field), it cannot have a stock count.
        if (payload.isDigital === true && stock > 0) {
            throw new BadRequestError("Digital products should not carry a physical 'stock' count.");
        }
    }
    
    // An optional method for update payloads, where fields might be sparse
    static validateUpdatePayload(payload) {
        // Since many fields are optional in an update, we only check the format if the field exists.
        // For simplicity, we can reuse the main validator after basic existence checks, 
        // or create a dedicated sparse validator. For high-level enterprise, a dedicated 
        // sparse validator or DTO (Data Transfer Object) pattern is preferred.
        
        if (payload.sku !== undefined && !SKU_REGEX.test(payload.sku)) {
             throw new BadRequestError(`SKU format is invalid. Must match pattern ${SKU_REGEX.source}.`);
        }
        
        // Example: If price is updated, ensure it's positive.
        if (payload.price !== undefined && (typeof payload.price !== 'number' || payload.price <= 0)) {
            throw new BadRequestError("Updated price must be a positive number.");
        }
        
        // A full validation should ideally be run on the merged object (old product + new updates)
        // This is often handled in the service layer for consistency.
    }
}
module.exports = ProductValidator;