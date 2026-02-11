const express = require("express");
const router = express.Router();
const geo = require("../services/geoip/geoIpService");
const { checkHealth } = require("../event/lib/redisClient");
const { getFabricStatus } = require("../app_initializer");

router.get("/geoip", async (req, res) => {
    try {
        const sample = await geo.lookupLocation("8.8.8.8");
        const redisAlive = await checkHealth();
        const fabricReady = getFabricStatus();

        res.json({
            service: "hyper-fabric-omega",
            status: fabricReady ? "HEALTHY" : "DEGRADED",
            timestamp: new Date().toISOString(),
            components: {
                geoip: Boolean(sample),
                redis_cluster: redisAlive ? "UP" : "DOWN",
                rate_limiter: fabricReady ? "ENFORCING" : "FAIL_SAFE"
            }
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;