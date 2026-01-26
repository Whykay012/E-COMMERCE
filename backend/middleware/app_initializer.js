const { connectRedis, checkHealth } = require("./utils/redisClient");
const { temporarilyBlock, isBlocked } = require("./utils/blocklist");
const { createRateLimiterFactory } = require("./services/rateLimiters/rateLimiterFactory");
const { SCRIPTS } = require("./services/rateLimiters/luaScripts");

let IS_FABRIC_HEALTHY = true;
let createRateLimiter = null;

// Background Heartbeat: Check every 5 seconds
setInterval(async () => {
    IS_FABRIC_HEALTHY = await checkHealth();
}, 5000);

async function initializeRateLimiting() {
    const redisCluster = connectRedis();
    const shas = {};

    try {
        // Wait for cluster ready
        if (redisCluster.status !== "ready") {
            await new Promise((resolve) => redisCluster.once("ready", resolve));
        }

        // Load scripts to ALL master nodes in the cluster
        const masters = redisCluster.nodes('master');
        for (const [algoName, scriptSource] of Object.entries(SCRIPTS)) {
            const results = await Promise.all(masters.map(node => node.script('LOAD', scriptSource)));
            shas[algoName] = results[0];
        }

        // Create the final factory
        createRateLimiter = createRateLimiterFactory({
            shas,
            redisClient: redisCluster,
            temporarilyBlock,
            isBlocked,
            getFabricStatus: () => IS_FABRIC_HEALTHY
        });

        module.exports.createRateLimiter = createRateLimiter;
        console.log("🚀 Rate Limiter Omega Fabric Ready.");
    } catch (error) {
        console.error("❌ Fatal Rate Limiter Initialization Error", error);
        process.exit(1);
    }
}

// Kick off initialization
initializeRateLimiting();

module.exports.getFabricStatus = () => IS_FABRIC_HEALTHY;