// queue/emailQueue.js (MAXIMUM ROBUSTNESS: Isolated Connection Manager)

const { Queue, Connection } = require('bullmq');
const logger = require('../config/logger');
// Assuming getRedisConnectionDetails returns an object like { host: '...', port: ... }
const { getRedisConnectionDetails } = require('../config/redisConnection');

// --- 0. Queue Configuration Constants ---
const EMAIL_QUEUE_NAMES = {
  TRANSACTIONAL: 'TransactionalEmailQueue', // Priority 1 (Highest)
  REPORTING: 'ReportingEmailQueue',    // Priority 2 (Medium)
  MARKETING: 'MarketingEmailQueue',    // Priority 3 (Lowest)
};

// --- 1. Connection Factory (Isolated and Resilient) ---
/**
 * Creates a new, isolated, and monitored Redis connection instance.
 */
function createMonitoredConnection(name) {
    // 💡 UPGRADE: Isolated connection for better resilience
    const conn = new Connection(getRedisConnectionDetails());
    
    // 💡 UPGRADE: Add Connection-level listeners for Redis health monitoring
    conn.on('error', (err) => {
        logger.error(`[Redis Connection Error - ${name}] Disruption detected.`, { 
            error: err.message, 
            stack: err.stack 
        });
    });
    conn.on('ready', () => {
        logger.info(`[Redis Connection - ${name}] Connection is ready.`);
    });

    return conn;
}


// --- 2. Job Options Template (Abstracted defaults) ---
const getJobOptions = (priority) => ({
  // Standard cleanup for memory management
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
  priority: priority, // 1 (highest) to N (lowest)
  timeout: 5 * 60 * 1000,
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
    // NOTE: Removed jobId from defaults here; it's added only in addEmailJob for uniqueness.
});

// --- 3. Initialize the Queues (The Manager) ---
const emailQueues = {};

/**
* Initializes a single queue with its own dedicated connection and monitoring.
*/
function initializeQueue(name, priority) {
    const connection = createMonitoredConnection(name); // 💡 UPGRADE: Use dedicated connection
    
  const queue = new Queue(name, {
    connection: connection,
    defaultJobOptions: getJobOptions(priority),
  });

  // CRITICAL: Queue-level monitoring listeners
  queue.on('error', (err) => {
    logger.error(`BullMQ Queue Error [${name}]`, { error: err.message, stack: err.stack, level: 'CRITICAL' });
  });
  queue.on('paused', () => {
    logger.warn(`BullMQ Queue [${name}] has been PAUSED. Action required.`);
  });
 
  return queue;
}

// Initialize all required queues using the isolated connection pattern
emailQueues.TRANSACTIONAL = initializeQueue(EMAIL_QUEUE_NAMES.TRANSACTIONAL, 1); 
emailQueues.REPORTING = initializeQueue(EMAIL_QUEUE_NAMES.REPORTING, 2); 
emailQueues.MARKETING = initializeQueue(EMAIL_QUEUE_NAMES.MARKETING, 3); 

// --- 4. Centralized Job Adding Utility ---

/**
* Utility function to add a job to the appropriate email queue.
* @param {string} type - The job type (e.g., 'forgotPassword', 'orderConfirmation').
* @param {string} queueType - The target queue type ('TRANSACTIONAL', 'MARKETING', etc.).
* @param {object} data - The job payload.
* @returns {Promise<Job>}
*/
const addEmailJob = async (type, queueType, data) => {
  const targetQueue = emailQueues[queueType];

  if (!targetQueue) {
    logger.error(`Attempted to add job to unknown queue type: ${queueType}`, { jobType: type, data });
    throw new Error(`Invalid queueType specified: ${queueType}`);
  }
 
  // The job name tells the worker *what* function to execute 
  const jobName = `send${type.charAt(0).toUpperCase() + type.slice(1)}Email`;
 
  // Set a unique Job ID for better tracing (this is an override to the default)
  const jobOptions = {
    jobId: `${type}-${data.to}-${Date.now()}-${Math.floor(Math.random() * 100)}`, // Added random suffix for absolute uniqueness
  };
 
  try {
    const job = await targetQueue.add(jobName, data, jobOptions);
    logger.info(`Dispatched job (ID: ${job.id}) to ${queueType} queue.`, {
      jobId: job.id,
      jobName: jobName,
      recipient: data.to,
      queue: targetQueue.name
    });
    return job;
  } catch (error) {
    logger.error(`Failed to add job (${jobName}) to ${queueType} queue.`, {
      jobData: data,
      error: error.message,
      queueName: targetQueue.name
    });
    throw error;
  }
};

module.exports = {
  ...emailQueues, 
  addEmailJob, 
  EMAIL_QUEUE_NAMES, 
};