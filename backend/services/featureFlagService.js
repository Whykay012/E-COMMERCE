// services/featureFlagService.js (TITAN NEXUS - Robust Initialization & Defaults)

const logger = require("../config/logger");
const config = require("../config/features"); 
const FLAG_CACHE_TTL_SECONDS = 300; 
const DEFAULT_FLAG_VALUE = false; // TITAN NEXUS: Explicit default for safety

class FeatureFlagService {
    
    static flagsCache = new Map();
    static lastRefreshTime = 0;
    static refreshTimeoutHandle = null;
    static initializationPromise = null; // TITAN NEXUS: Promise to track initialization status

    /**
     * @static
     * @desc Initializes the cache and starts the auto-refresh cycle.
     */
    static async initialize() {
        if (this.lastRefreshTime > 0) return this.initializationPromise; // Return existing promise if already running

        const initProcess = async () => {
            logger.info("FeatureFlagService: Initializing and performing first cache refresh.");
            await this.refreshCache(true); // Immediate blocking refresh for first run
            this.scheduleRefresh();
        };

        this.initializationPromise = initProcess();
        return this.initializationPromise;
    }

    // ... (scheduleRefresh and refreshCache remain functionally the same)
    static scheduleRefresh() {
        if (this.refreshTimeoutHandle) {
            clearTimeout(this.refreshTimeoutHandle);
        }
        
        const refreshDelayMs = (FLAG_CACHE_TTL_SECONDS + 10) * 1000;
        
        this.refreshTimeoutHandle = setTimeout(async () => {
            await this.refreshCache(false); 
            this.scheduleRefresh(); 
        }, refreshDelayMs);
        
        this.refreshTimeoutHandle.unref(); 
    }

    static async refreshCache(isBlocking) {
        try {
            const latestFlags = config.featureFlags; 

            const newCache = new Map();
            for (const [key, value] of Object.entries(latestFlags)) {
                newCache.set(key, value);
            }
            this.flagsCache = newCache;
            this.lastRefreshTime = Date.now();
            
            logger.info(`FeatureFlagService: Cache successfully refreshed with ${newCache.size} flags.`);
        } catch (error) {
            if (isBlocking) {
                logger.error("FeatureFlagService: CRITICAL BLOCKING REFRESH FAILED. Cannot start application.", { error: error.message });
                throw error; 
            }
            logger.error("FeatureFlagService: Asynchronous cache refresh failed. Serving potentially stale flag data.", { error: error.message });
        }
    }


    /**
     * @private
     * @desc Retrieves the value of a feature flag from the internal CACHE.
     */
    static getFlagValue(key) {
        const flag = this.flagsCache.get(key);
        
        if (typeof flag === 'undefined') {
            // TITAN NEXUS: Use explicit default
            logger.warn(`Feature flag key '${key}' not found in internal cache. Defaulting to ${DEFAULT_FLAG_VALUE}.`);
            return DEFAULT_FLAG_VALUE;
        }
        
        return flag;
    }

    /**
     * @desc Determines if a specific feature is enabled for a given user context.
     */
    static async isEnabled(key, userId = null) {
        // TITAN NEXUS: Wait for initialization to complete if needed
        if (this.initializationPromise && this.lastRefreshTime === 0) {
            await this.initializationPromise;
        }
        
        const flagValue = this.getFlagValue(key); 

        if (flagValue === true) { return true; }

        if (typeof flagValue === 'object' && flagValue !== null) {
            // ... (Targeting logic remains the same)
            
            // Example: Check if feature is enabled for specific users
            if (flagValue.type === 'user_list' && userId) {
                const isTargeted = flagValue.targetUsers?.includes(userId);
                if (isTargeted) {
                    logger.debug(`Flag '${key}' enabled via user list targeting for user ${userId}.`);
                    return true;
                }
            }
            
            // Example: Canary/Percentage Rollout
            if (flagValue.type === 'percentage_rollout' && userId) {
                const hash = this.getUserHash(userId) % 100;
                if (hash < flagValue.percentage) {
                    logger.debug(`Flag '${key}' enabled via ${flagValue.percentage}% rollout for user ${userId}.`);
                    return true;
                }
            }
            return DEFAULT_FLAG_VALUE; // Return default if targeting object found but rules don't match
        }
        
        return DEFAULT_FLAG_VALUE;
    }

    /**
     * @private
     * @desc Simple non-cryptographic hash function for percentage rollouts.
     */
    static getUserHash(str) {
        let hash = 0;
        if (str.length === 0) return hash;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32bit integer
        }
        return Math.abs(hash);
    }
}

module.exports = FeatureFlagService;
// ⚠️ IMPORTANT: Export the service and the initialize method.
// The main application startup code (e.g., server.js) MUST call:
// await FeatureFlagService.initialize();

