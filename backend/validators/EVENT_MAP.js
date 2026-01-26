const EVENT_MAP = {
    // ------------------------------------
    // CORE LIFECYCLE EVENTS (Existing)
    // ------------------------------------
    ProductCreated: { 
        type: 'com.ecommerce.product.ProductCreated', 
        version: '1.0.0',
        maxRetries: 5, 
        priority: 10, 
    },
    ProductUpdated: { 
        type: 'com.ecommerce.product.ProductUpdated', 
        version: '1.0.1', 
        maxRetries: 3, 
        priority: 5, 
    },
    ProductSoftDeleted: { 
        type: 'com.ecommerce.product.ProductSoftDeleted', 
        version: '1.0.0',
        maxRetries: 5, 
        priority: 10,
    },
    ProductRestored: { 
        type: 'com.ecommerce.product.ProductRestored', 
        version: '1.0.0',
        maxRetries: 5, 
        priority: 5,
    },
    ProductHardDeleted: { 
        type: 'com.ecommerce.product.ProductHardDeleted', 
        version: '1.0.0',
        maxRetries: 3, 
        priority: 1, 
    },

    // ------------------------------------
    // INVENTORY & STOCK EVENTS (New additions)
    // ------------------------------------
    
    /**
     * @desc Fired when product stock crosses a low-water mark (e.g., stock < 10).
     * Used by Inventory Management, Procurement, and Alerting services.
     */
    ProductStockLow: { 
        type: 'com.ecommerce.product.ProductStockLow', 
        version: '1.0.0', 
        maxRetries: 10, // High resilience needed for alerts
        priority: 15,  // Critical for business
    },
    
    /**
     * @desc Fired when product stock hits zero. Used to instantly update frontend availability.
     * Often decoupled as this state change is high-volume and critical.
     */
    ProductStockDepleted: { 
        type: 'com.ecommerce.product.ProductStockDepleted', 
        version: '1.0.0', 
        maxRetries: 5, 
        priority: 20, // Highest priority for customer experience
    },
    
    // ------------------------------------
    // VISIBILITY & FEATURE FLAG EVENTS (New additions)
    // ------------------------------------

    /**
     * @desc Fired when the product's 'isFeatured' flag is toggled on/off.
     * Used by the Search/Discovery service to re-index the promotion status.
     */
    ProductFeatureToggled: { 
        type: 'com.ecommerce.product.ProductFeatureToggled', 
        version: '1.0.0', 
        maxRetries: 3, 
        priority: 7, 
    },

    /**
     * @desc Fired when a product's primary image/video is updated.
     * Used by Content Delivery Networks (CDN) and Cache services for targeted invalidation.
     */
    ProductMediaUpdated: { 
        type: 'com.ecommerce.product.ProductMediaUpdated', 
        version: '1.0.0', 
        maxRetries: 3, 
        priority: 8, 
    },
};

// Export the updated map
module.exports = EVENT_MAP;