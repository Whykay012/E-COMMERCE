// services/cacheService.js (TITAN NEXUS - Pipelining and Advanced Resilience)
const Redis = require("ioredis"); 
const logger = require("../config/logger"); // Assuming this is the UTILITY PINO LOGGER

// --- Configuration ---
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const REDIS_PREFIX = "app_cache:";

let redisClient = null;

try {
  // TITAN NEXUS: Use a connection pool configured for production
  redisClient = new Redis(REDIS_URL, { 
    keyPrefix: REDIS_PREFIX,
    maxRetriesPerRequest: 3, 
    enableOfflineQueue: false // Fail fast if Redis is down
  });

  // 🚨 CRITICAL: Use logger.critical/error for connection issues that impact service availability
  redisClient.on("error", (err) => logger.critical("CRITICAL: Redis Cache Error. Connection lost/failed.", { error: err.message }));
  redisClient.on("connect", () => logger.info("Redis Cache Connected successfully."));
  
} catch (error) {
  logger.critical("Failed to initialize Redis client.", { error: error.message });
}


/**
* @desc Implements a robust caching layer with support for SWR, TTL, and Pipelining.
*/
class CacheService {

  static get isHealthy() {
    return redisClient && redisClient.status === 'ready';
  }

  static async set(key, value, ttlSeconds) {
    if (!this.isHealthy) { return logger.warn(`Cache: Unhealthy. Skipping set for ${key}.`); }
    try {
      await redisClient.set(key, value, "EX", ttlSeconds);
    } catch (error) {
      // 💡 OPERATIONAL: Set failures are usually transient or minor
      logger.warn(`Cache: Failed to set key ${key} (SET).`, { error: error.message });
    }
  }

  static async get(key) {
    if (!this.isHealthy) { return null; }
    try {
      return await redisClient.get(key);
    } catch (error) {
      // 💡 OPERATIONAL: Get failures result in a cache miss, but are generally operational
      logger.warn(`Cache: Failed to get key ${key} (GET). Serving MISS.`, { error: error.message });
      return null;
    }
  }

  static async del(key) {
    if (!this.isHealthy) { return; }
    try {
      await redisClient.del(key);
      // 💡 OPERATIONAL: Debug-level detail
      logger.debug(`Cache: Deleted key ${key}.`);
    } catch (error) {
      logger.warn(`Cache: Failed to delete key ${key} (DEL).`, { error: error.message });
    }
  }
  
  /**
  * @desc TITAN NEXUS: Deletes multiple keys using a pipeline for efficiency.
  * @param {string[]} keys - Array of cache keys to delete.
  * @returns {Promise<void>}
  */
  static async delMulti(keys) {
    if (!this.isHealthy || keys.length === 0) { return; }
    try {
      const pipeline = redisClient.pipeline();
      keys.forEach(key => pipeline.del(key));
      await pipeline.exec();
      // 💡 OPERATIONAL: Debug-level detail
      logger.debug(`Cache: Pipelined deletion of ${keys.length} keys.`);
    } catch (error) {
      logger.warn(`Cache: Failed to delete multiple keys (DELMULTI).`, { error: error.message, keys: keys.join(',') });
    }
  }

  // ... (setWithStale and getWithStale remain functionally the same, ensuring they call .set/.get which check health)

  static async setWithStale(key, value, ttlSeconds, staleSeconds) {
    if (!this.isHealthy) { return; }
    const expiresAt = Date.now() + (ttlSeconds * 1000);
    const staleAt = Date.now() + (staleSeconds * 1000);

    const metadata = JSON.stringify({
      value,
      expiresAt, 
      staleAt  
    });
    
    await this.set(key, metadata, ttlSeconds);
  }
  
  static async getWithStale(key) {
    if (!this.isHealthy) { return { data: null, stale: false }; }
    try {
      const raw = await this.get(key);
      if (!raw) {
        return { data: null, stale: false };
      }

      const metadata = JSON.parse(raw);
      const now = Date.now();
      
      if (now >= metadata.expiresAt) {
        return { data: null, stale: false };
      }

      const isStale = now >= metadata.staleAt;

      return {
        data: metadata.value,
        stale: isStale
      };
    } catch (error) {
      // 🚨 CRITICAL: Failed to process SWR metadata is a data integrity/logic error
      logger.error(`Cache: Error processing SWR metadata for key ${key}. (SWR GET)`, { error: error.message });
      return { data: null, stale: false };
    }
  }
}

module.exports = CacheService;