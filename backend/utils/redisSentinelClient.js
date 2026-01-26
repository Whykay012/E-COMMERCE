/**
 * utils/redisSentinelClient.js
 * Sentinel Cluster Health Utility
 */
const { cacheConnection } = require("../lib/redisCacheClient");

/**
 * Executes Sentinel commands to check health of the master.
 * @param {string} masterName - Must match REDIS_MASTER_NAME (e.g., 'my-ecom-master')
 */
async function querySentinelStatus(masterName) {
    const client = cacheConnection;

    // Safety check: ensure client is actually using Sentinels
    if (!client.options.sentinels || client.options.sentinels.length === 0) {
        return {
            status: 'NON_HA',
            message: 'Redis Client is not configured for Sentinel access.',
            masterName: masterName,
        };
    }

    try {
        // Querying the sentinel network via the current connection
        const masterInfo = await client.sentinel('master', masterName);
        const replicasInfo = await client.sentinel('replicas', masterName);

        const statusMap = parseSentinelArray(masterInfo);
        
        // Flags check: 's_down' = Subjectively Down, 'o_down' = Objectively Down
        const flags = statusMap.flags || '';
        const isMasterDown = flags.includes('s_down') || flags.includes('o_down');
        
        return {
            status: isMasterDown ? 'FAILOVER_IN_PROGRESS' : 'OK',
            masterName: masterName,
            masterIp: statusMap.ip,
            masterPort: statusMap.port,
            replicaCount: replicasInfo.length,
            quorum: statusMap.quorum,
            message: isMasterDown ? 'Master reported DOWN. Failover likely in progress.' : 'HA cluster is nominal.'
        };

    } catch (error) {
        return {
            status: 'CRITICAL',
            message: `Sentinel query failed: ${error.message}`,
            errorDetail: error.message
        };
    }
}

/**
 * Helper to convert Redis Sentinel key/value array responses to an object.
 */
function parseSentinelArray(arr) {
    if (!arr || !Array.isArray(arr)) return {};
    const obj = {};
    for (let i = 0; i < arr.length; i += 2) {
        obj[arr[i]] = arr[i + 1];
    }
    return obj;
}

module.exports = { 
    querySentinelStatus
};