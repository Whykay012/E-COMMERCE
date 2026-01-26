// queues/jobQueue.js
const { Queue } = require("bullmq");

// Configuration loaded from environment variables
const connection = {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: +(process.env.REDIS_PORT || 6379),
};

// 🚀 COSMIC UPGRADE 1: Dedicated Queue for Domain Events
// We separate the event queue from the general 'jobs' queue for priority management.
// The ProductEventEmitter will use the 'domain-events' queue.
const DOMAIN_QUEUE_NAME = "domain-events";
const eventQueue = new Queue(DOMAIN_QUEUE_NAME, { connection });

// The general queue for other, non-critical background jobs
const GENERAL_QUEUE_NAME = "general-jobs";
const generalQueue = new Queue(GENERAL_QUEUE_NAME, { connection });


/**
 * @desc Queues a job (event or general task) with built-in resilience options.
 * @param {string} queueName - The specific queue to use (e.g., 'domain-events' or 'general-jobs').
 * @param {string} jobName - The specific name/type of the job (e.g., 'ProductCreated', 'MediaRollback').
 * @param {Object} data - The payload for the job.
 * @param {Object} [opts={}] - Custom options, including resilience settings.
 * @param {number} [opts.attempts] - Max retry attempts (default 5).
 * @param {number} [opts.priority] - Job priority (higher number = lower priority).
 * @param {string} [opts.jobId] - Explicit ID for idempotency/tracing.
 * @returns {Promise<Object>} The queued job object.
 */
async function queueJob(queueName, jobName, data, opts = {}) {
    const queueMap = {
        [DOMAIN_QUEUE_NAME]: eventQueue,
        [GENERAL_QUEUE_NAME]: generalQueue,
        // ... extend with other specific queues (e.g., 'high-volume-notifications')
    };

    const targetQueue = queueMap[queueName] || generalQueue; // Default to general if name is unknown
    const jobId = opts.jobId || undefined;

    // Use jobName as the name argument for the BullMQ add method
    return targetQueue.add(jobName, data, {
        removeOnComplete: 1000,
        removeOnFail: false, // Keep failed jobs for inspection/manual retry
        
        // Use custom options from EventEmitter/Caller
        attempts: opts.attempts || 5,
        priority: opts.priority || 0,
        
        // Standard backoff for resilience
        backoff: { type: "exponential", delay: 5000 },
        
        // Idempotency hook
        jobId,

        // Allow passing any raw BullMQ options (e.g., delay, repeat)
        ...opts.bullOptions, 
    });
}

// Helper for the ProductEventEmitter to use the correct queue name
queueJob.DOMAIN_QUEUE_NAME = DOMAIN_QUEUE_NAME;
queueJob.GENERAL_QUEUE_NAME = GENERAL_QUEUE_NAME;


module.exports = { 
    eventQueue, 
    generalQueue, 
    queueJob,
    DOMAIN_QUEUE_NAME,
    GENERAL_QUEUE_NAME,
};