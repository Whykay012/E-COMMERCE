// utils/lockManager.js (Simulated/Abstraction over Redlock or similar)

const redisClient = require('../lib/redisClient'); 
const logger = require('./logger');

// Lock TTL in milliseconds
const LOCK_TTL = 30000; 

const LOCK_KEY = (id) => `lock:geocode:${id}`;

class LockManager {
    /**
     * @desc Acquires a distributed lock using SET NX PX.
     * @param {string} resourceId - The ID of the resource to lock (e.g., addressId).
     * @returns {Promise<boolean>} True if the lock was acquired, false otherwise.
     */
    static async acquireLock(resourceId) {
        const key = LOCK_KEY(resourceId);
        // SET key value NX PX milliseconds
        const result = await redisClient.set(key, 'locked', 'NX', 'PX', LOCK_TTL);
        
        if (result === 'OK') {
            logger.debug('LOCK_ACQUIRED', { resourceId });
            return true;
        }
        return false;
    }

    /**
     * @desc Releases a distributed lock.
     * @param {string} resourceId - The ID of the resource.
     */
    static async releaseLock(resourceId) {
        const key = LOCK_KEY(resourceId);
        // Using DEL is simple, but a proper solution requires a LUA script 
        // to check ownership before deleting (for robustness against slow workers).
        await redisClient.del(key);
        logger.debug('LOCK_RELEASED', { resourceId });
    }
}

module.exports = LockManager;