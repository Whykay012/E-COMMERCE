"use strict";

/**
 * COSMOS HYPER-FABRIC OMEGA: Job Queue (BullMQ)
 * --------------------------------------------
 * Features: 
 * 1. Shared Cluster Connection (Prevents connection bloat).
 * 2. Dedicated Domain vs. General Queues.
 * 3. Exponential Backoff & Idempotency.
 */

const { Queue } = require("bullmq");
const { Redis } = require("../utils/redisClient"); // 💡 OMEGA: Reuse the Redis class/logic
const { getRedisConnectionDetails } = require("../config/redisConnection");
const { REDIS_NODES } = require("../config/redisNodes");

// 🚀 OMEGA CONNECTION: Use a Cluster-aware connection for BullMQ
// Note: BullMQ requires 'maxRetriesPerRequest' to be null for blocking commands.
const queueConnection = new Redis.Cluster(REDIS_NODES, {
    redisOptions: {
        ...getRedisConnectionDetails(),
        enableReadyCheck: true,
        maxRetriesPerRequest: null, // 🚨 CRITICAL for BullMQ
        connectTimeout: 10000,
    },
});

const DOMAIN_QUEUE_NAME = "domain-events";
const GENERAL_QUEUE_NAME = "general-jobs";

// Initialize Queues
const eventQueue = new Queue(DOMAIN_QUEUE_NAME, { connection: queueConnection });
const generalQueue = new Queue(GENERAL_QUEUE_NAME, { connection: queueConnection });

/**
 * @desc Queues a job with built-in resilience and cluster-aware sharding.
 * @param {string} queueName - 'domain-events' or 'general-jobs'.
 * @param {string} jobName - e.g., 'order.process', 'ProductCreated'.
 * @param {Object} data - Payload.
 * @param {Object} [opts={}] - Retry and priority settings.
 */
async function queueJob(queueName, jobName, data, opts = {}) {
    const queueMap = {
        [DOMAIN_QUEUE_NAME]: eventQueue,
        [GENERAL_QUEUE_NAME]: generalQueue,
    };

    const targetQueue = queueMap[queueName] || generalQueue;
    const jobId = opts.jobId || undefined;

    return targetQueue.add(jobName, data, {
        // Hygiene: Remove completed jobs but keep 1000 for audit
        removeOnComplete: {
            count: 1000,
            age: 24 * 3600, // 24 hours
        },
        removeOnFail: false, // Keep for SRE/Manual intervention
        
        attempts: opts.attempts || 5,
        priority: opts.priority || 0,
        
        // 🔄 Exponential Backoff: 5s, 10s, 20s, 40s, 80s
        backoff: { 
            type: "exponential", 
            delay: 5000 
        },
        
        jobId, // Idempotency
        ...opts.bullOptions, 
    });
}

// Map helper properties
queueJob.DOMAIN_QUEUE_NAME = DOMAIN_QUEUE_NAME;
queueJob.GENERAL_QUEUE_NAME = GENERAL_QUEUE_NAME;

module.exports = { 
    eventQueue, 
    generalQueue, 
    queueJob,
    DOMAIN_QUEUE_NAME,
    GENERAL_QUEUE_NAME,
};