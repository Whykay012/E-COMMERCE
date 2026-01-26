// config/features.js
/**
 * @desc Advanced Feature Flag Configuration.
 * Each flag now includes metadata (description, owner, status) 
 * for better management, visibility, and compliance tracking.
 */
module.exports = {
    featureFlags: {
        // --- Core Application Stability Flags (Global Toggles) ---

        'product_creation_enabled': {
            description: "Master switch to enable/disable POST /products API globally for maintenance.",
            owner: "DevOps/Core Team",
            status: "RELEASED",
            type: "boolean", // New: Explicitly define type
            value: true,
        },
        
        'product_updates_enabled': {
            description: "Master switch to enable/disable PUT /products/:id API.",
            owner: "DevOps/Core Team",
            status: "RELEASED",
            type: "boolean",
            value: true,
        },

        // --- Personalization and Rollout Flags (Targeted) ---

        'product_personalization_active': {
            description: "Enables session-aware freshness filtering in getRandomProducts to reduce stale recommendations.",
            owner: "Personalization Team",
            status: "ROLLOUT_PHASE_1", // New: Track release status
            type: "percentage_rollout",
            percentage: 10, // 10% of users get the new logic
        },
        
        'new_checkout_flow': {
            description: "Routes traffic to the new microservice-based checkout page.",
            owner: "Payments Team",
            status: "CANARY_TESTING",
            type: "user_list",
            targetUsers: [
                '60c72b2f9e1e2d0015b67e7c', // Admin Tester 1
                '60c72b2f9e1e2d0015b67e7d', // Admin Tester 2
                // ... other specific user IDs
            ],
        },
        
        // --- Experimental/Sunset Flags ---

        'beta_search_enabled': {
            description: "Activates the new ML-based search engine endpoint.",
            owner: "Data Science Team",
            status: "EXPERIMENTAL",
            type: "boolean",
            value: false, // Currently disabled
        },

        'old_inventory_system_active': {
            description: "Legacy flag. If true, fall back to the old stock service. Should be set to false.",
            owner: "Legacy Support",
            status: "SUNSET", // New: Mark for eventual removal
            type: "boolean",
            value: false,
        },
    }
};