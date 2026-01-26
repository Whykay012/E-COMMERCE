// utils/distributedLockClient.js (Distributed Locking using Redis SET NX/EX)

const RedisClient = require('./redisClient'); 
const { v4: uuidv4 } = require('uuid');

const DistributedLock = {

    async acquire(key, ttlMs) {
        const token = uuidv4(); 
        
        // Use Redis SET with NX (Not Exists) and PX (Milliseconds Expiry)
        const result = await RedisClient.set(key, token, 'PX', ttlMs, 'NX');
        
        return result === 'OK' ? token : null;
    },

    async release(key, token) {
        // Lua script ensures the GET and DELETE are atomic (preventing race conditions)
        const luaScript = `
            if redis.call("get",KEYS[1]) == ARGV[1] then
                return redis.call("del",KEYS[1])
            else
                return 0
            end
        `;
        
        // NOTE: This assumes RedisClient has an 'eval' method mapped to the Redis EVAL command.
        const result = await RedisClient.eval(luaScript, 1, key, token);
        
        return result === 1;
    },

    initialize: async () => { /* Connection setup */ },
    connect: async () => { await DistributedLock.initialize(); }
};

module.exports = DistributedLock;