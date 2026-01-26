// services/queueAdapters/BullMQAdapter.js

const { Queue, Worker, Connection } = require('bullmq'); 
const logger = require('../../config/logger'); // Assume standard logger
const REDIS_CONNECTION_OPTS = { 
    host: process.env.REDIS_HOST || 'localhost', 
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null, // Let BullMQ handle reconnections
    enableReadyCheck: true,
};

class BullMQAdapter {
    constructor() {
        this.queues = {}; 
        this.workers = {}; 
        this.connection = null; // Central Redis connection instance
        this.workerDefaults = {
            concurrency: 5,
            limiter: { max: 100, duration: 1000 }, // Global Rate Limit (100 jobs/sec)
            settings: { 
                lockDuration: 30000, 
                stalledInterval: 30000, 
                maxStalledCount: 5,
            }
        };
    }
    
    async connect() {
        if (this.connection) return;
        
        // 💡 EFFICIENCY: Use a single connection for all Queues/Workers
        this.connection = new Connection(REDIS_CONNECTION_OPTS);
        
        this.connection.on('error', (err) => {
            logger.error(`[BullMQ] Connection Error:`, err.message);Q
            // BullMQ handles most reconnects internally
        });
        
        // Wait for the connection to be ready before proceeding
        return new Promise((resolve, reject) => {
            this.connection.once('error', reject);
            this.connection.once('ready', () => {
                logger.info('[BullMQ] Redis connection established and ready.');
                resolve();
            });
        });
    }

    send(queueName, payload, options = {}) {
        if (!this.connection) throw new Error("BullMQ connection not initialized.");
        
        if (!this.queues[queueName]) {
            // Lazy initialization of Queue instance
            this.queues[queueName] = new Queue(queueName, { 
                connection: this.connection,
                defaultJobOptions: { 
                    attempts: 3, 
                    backoff: { type: 'exponential', delay: 5000 },
                }
            });
        }
        
        const jobName = options.jobName || 'default'; 
        delete options.jobName; 
        
        return this.queues[queueName].add(jobName, payload, options);
    }

    process(queueName, processor, options = {}) {
        if (!this.connection) throw new Error("BullMQ connection not initialized.");
        if (this.workers[queueName]) return; 

        // 💡 EFFICIENCY: Merge defaults with provided options
        const workerOptions = { ...this.workerDefaults, ...options };
        
        const worker = new Worker(queueName, processor, { 
            connection: this.connection, 
            ...workerOptions 
        });
        
        worker.on('failed', (job, err) => {
            logger.warn(`BullMQ Worker [${queueName}] Job ${job?.id} failed (${job?.attemptsMade} attempts):`, err.message);
        });
        
        worker.on('error', (err) => {
            logger.error(`BullMQ Worker [${queueName}] Worker Error:`, err.message);
        });
        
        this.workers[queueName] = worker;
        logger.info(`[BullMQ] Worker started for queue: ${queueName}.`);
    }
    
    async close() {
        // Gracefully close all workers first (to finish jobs)
        await Promise.allSettled(
            Object.values(this.workers).map(w => w.close())
        );
        // Then close all queue instances
        await Promise.allSettled(
            Object.values(this.queues).map(q => q.close())
        );
        // Finally, close the underlying connection
        if (this.connection) {
            await this.connection.close();
        }
        logger.info("BullMQ system shut down gracefully.");
    }
}

module.exports = BullMQAdapter;