"use strict";

const { getRedisClient } = require("../../utils/redisClient");
const logger = require("../../utils/logger");

/**
 * COSMOS HYPER-FABRIC: Rate Limit Analytics
 * -----------------------------------------
 * Fetches real-time blocking data for the Admin Dashboard.
 */
async function getBlockedUsers() {
    const redis = getRedisClient();
    const pattern = "blocklist:*";
    let blockedData = [];

    try {
        // In a Cluster, we must scan individual nodes or use a high-level scan
        // This helper assumes a standard cluster scan via ioredis
        const keys = await redis.keys(pattern);
        
        if (keys.length === 0) return [];

        const pipeline = redis.pipeline();
        keys.forEach(key => pipeline.ttl(key));
        
        const ttls = await pipeline.exec();

        blockedData = keys.map((key, index) => ({
            identifier: key.replace("blocklist:", ""),
            expiresIn: ttls[index][1], // TTL in seconds
            type: key.includes("ip:") ? "IP_ADDRESS" : "USER_ID"
        }));

        return blockedData;
    } catch (err) {
        logger.error({ err: err.message }, "DASHBOARD_METRICS_FAILURE");
        return [];
    }
}

module.exports = { getBlockedUsers };