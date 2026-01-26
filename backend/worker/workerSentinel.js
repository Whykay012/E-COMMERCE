/**
 * scripts/workerSentinel.js
 * High-Availability Watchdog for BullMQ Workers.
 * Monitors queue backlogs and worker presence via Redis Sentinel.
 */

const { Queue } = require('bullmq');
const { cacheConnection } = require('../lib/redisCacheClient');
const logger = require('../utils/logger');

// Define the queues we want to monitor and their criticality
const QUEUES_TO_MONITOR = [
    { name: 'jobs', critical: true, minWorkers: 1 },             // Generic Worker
    { name: 'address-processing', critical: false, minWorkers: 1 }, // Address Worker
    { name: 'referral-commission', critical: true, minWorkers: 1 }  // Financial Worker
];

/**
 * Probes each queue for active workers and pending job counts.
 */
async function checkWorkerHealth() {
    console.log(`\n--- 🛡️  OMEGA SENTINEL: ${new Date().toISOString()} ---`);
    let clusterHealthy = true;

    for (const q of QUEUES_TO_MONITOR) {
        // Use the HA-aware cacheConnection for queue attachment
        const queue = new Queue(q.name, { connection: cacheConnection });

        try {
            // Parallel check for performance
            const [workers, jobCounts] = await Promise.all([
                queue.getWorkers(),
                queue.getJobCounts('waiting', 'active', 'delayed')
            ]);

            const activeWorkerCount = workers.length;
            const waitingJobs = jobCounts.waiting;

            // 1. CRITICAL FAILURE: Zero workers active
            if (activeWorkerCount === 0) {
                clusterHealthy = false;
                const status = q.critical ? '🔴 CRITICAL' : '⚠️ WARNING';
                
                logger.error(`WORKER_OFFLINE: Queue [${q.name}] has 0 workers!`);
                console.error(`${status}: No worker process found for "${q.name}"!`);
                
                if (q.critical) {
                    // Placeholder for high-priority alerts (e.g., PagerDuty, SMS)
                    triggerEmergencyAlert(q.name);
                }
            } 
            
            // 2. DEGRADED STATE: Backlog piling up with insufficient workers
            else if (waitingJobs > 100 && activeWorkerCount < 2) {
                logger.warn(`QUEUE_BACKLOG: [${q.name}] has ${waitingJobs} jobs with only ${activeWorkerCount} workers.`);
                console.warn(`⚠️  DEGRADED: Backlog detected in "${q.name}". Consideration: Scale worker instances.`);
            } 
            
            // 3. NOMINAL STATE
            else {
                console.log(`✅ Queue [${q.name}]: ${activeWorkerCount} worker(s) active. (Backlog: ${waitingJobs})`);
            }

        } catch (err) {
            clusterHealthy = false;
            logger.error(`SENTINEL_PROBE_FAILED: Unable to reach queue [${q.name}]`, { error: err.message });
            console.error(`❌ ERROR: Failed to probe queue "${q.name}". Check Redis Sentinel health.`);
        } finally {
            // Always close the local queue reference to prevent memory leaks
            await queue.close();
        }
    }

    if (clusterHealthy) {
        console.log("--- RESULT: ALL SYSTEMS OPERATIONAL ---\n");
    } else {
        console.log("--- RESULT: SYSTEM DEGRADED/OFFLINE ---\n");
    }
}

/**
 * Logic for emergency notifications
 */
function triggerEmergencyAlert(queueName) {
    // Integration logic for Slack/Email/PagerDuty goes here
    console.log(`🚨 [ALERTING] Dispatching emergency notification for ${queueName}...`);
}

// --- INITIALIZATION ---

// Wait for Redis to be "Ready" before starting the loop
cacheConnection.on('ready', () => {
    console.log('🛡️ Sentinel Watchdog connected to Redis HA Cluster.');
    
    // Run immediately on start
    checkWorkerHealth();

    // Set interval for continuous monitoring (every 30 seconds)
    setInterval(checkWorkerHealth, 30000);
});

cacheConnection.on('error', (err) => {
    logger.error('SENTINEL_REDIS_ERROR', { message: err.message });
});