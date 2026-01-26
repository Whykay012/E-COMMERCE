/**
 * lib/redisInitialization.js
 * ZENITH APEX - High-Performance Redis Script Orchestrator
 * Logic: Pre-loading LUA scripts for Atomic Security Operations.
 */

const { cacheConnection: redis } = require("./redisCacheClient");
const Logger = require("../utils/logger");

/**
 * 🚀 LUA SCRIPT DEFINITIONS
 * These are stored as strings and loaded into Redis RAM at startup.
 */
const SCRIPTS = {
  // LUA Script for the "Nuclear Purge"
  // Purpose: Atomic cleanup of user security state across multiple namespaces.
  NUCLEAR_WIPE: `
    local total_purged = 0
    
    -- 1. Atomic Deletion of specific high-priority keys (KEYS[1-3])
    -- These usually target: Challenge, Session Root, and Lockout Root.
    for i, key in ipairs(KEYS) do
        total_purged = total_purged + redis.call('del', key)
    end

    -- 2. Pattern-based wipe for sharded session metadata (ARGV[1])
    -- Targets wildcard namespaces like "zenith:auth:sess:USER_ID:*"
    local pattern = ARGV[1] .. '*'
    local dynamic_keys = redis.call('keys', pattern)
    if #dynamic_keys > 0 then
        total_purged = total_purged + redis.call('del', unpack(dynamic_keys))
    end
    
    return total_purged
  `,
};

// Internal registry for SHA hashes
const scriptHashes = {};

/**
 * @desc Pre-loads LUA scripts into Redis memory and returns SHA hashes.
 * Using EVALSHA (via these hashes) reduces network latency and CPU overhead.
 */
const initSecurityScripts = async () => {
  try {
    Logger.info("REDIS_LUA_INIT_START", { count: Object.keys(SCRIPTS).length });

    for (const [name, script] of Object.entries(SCRIPTS)) {
      // Load script and get the unique SHA1 identifier
      const sha = await redis.script("load", script);

      // Store in memory for the service layer to use
      scriptHashes[name] = sha;

      Logger.info(`REDIS_LUA_LOADED`, {
        scriptName: name,
        hash: sha,
        status: "READY",
      });
    }

    /**
     * ⭐ INTEGRITY CHECK
     * Verify at least the critical NUCLEAR_WIPE script is registered.
     */
    if (!scriptHashes.NUCLEAR_WIPE) {
      throw new Error("Critical LUA script (NUCLEAR_WIPE) failed to load.");
    }

    return scriptHashes;
  } catch (error) {
    Logger.error("REDIS_LUA_INIT_FAILED", {
      err: error.message,
      stack: error.stack,
    });
    // Critical failure: The security fabric cannot operate without these scripts.
    throw error;
  }
};

module.exports = {
  initSecurityScripts,
  scriptHashes,
};
