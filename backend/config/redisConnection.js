// config/redisConnection.js

const config = require('../config');

/**
 * @description Extract Redis connection details for single-node mode
 */
function getRedisConnectionDetails() {
    return {
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        password: config.REDIS_PASSWORD,
        db: config.REDIS_DB || 0,
    };
}

module.exports = {
    getRedisConnectionDetails,
};
