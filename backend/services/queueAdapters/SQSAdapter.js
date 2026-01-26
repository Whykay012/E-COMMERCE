// services/queueAdapters/SQSAdapter.js

// Import required AWS SDK classes (using AWS SDK v3 client for modern node environments)
const { SQSClient, SendMessageCommand, DeleteMessageCommand, ReceiveMessageCommand } = require('@aws-sdk/client-sqs');
const logger = require('../../config/logger'); // Assume standard logger
const InternalServerError = require("../errors/internal-server-error");


/* ===========================
   ⚙️ Configuration Constants
   =========================== */
const MAX_MESSAGES = 10; // Process up to 10 messages per poll (efficiency)
const WAIT_TIME_SECONDS = 20; // SQS Long Polling (efficiency and cost reduction)
const VISIBILITY_TIMEOUT_SECONDS = 300; // 5 minutes for job processing

class SQSAdapter {
    /**
     * @type {SQSClient | null}
     */
    sqsClient = null;
    
    /**
     * @type {Map<string, { intervalId: NodeJS.Timeout, isRunning: boolean }>}
     */
    pollingWorkers = new Map();

    constructor() {
        // Initialization is done in the connect method to handle async setup
    }
    
    /**
     * @desc Initializes the SQS client and verifies basic configuration.
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.sqsClient) return;

        if (!process.env.AWS_REGION || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            logger.error("❌ SQSAdapter: Missing critical AWS credentials/region in environment.");
            throw new InternalServerError("SQS Configuration is incomplete.");
        }

        // 💡 EFFICIENCY: Create a single SQS client instance for all operations
        this.sqsClient = new SQSClient({ region: process.env.AWS_REGION });
        logger.info(`✅ SQS Client initialized for region: ${process.env.AWS_REGION}`);
        // No need for a connection check, the client handles retries on first use.
    }

    /**
     * @desc Sends a message to the specified SQS queue.
     * @param {string} queueName - The name of the SQS queue.
     * @param {any} payload - The message data.
     * @param {object} [options] - Additional SQS parameters.
     * @returns {Promise<object>} The send result.
     */
    async send(queueName, payload, options = {}) {
    if (!this.sqsClient) throw new InternalServerError("SQS Client not connected.");

    const QueueUrl = process.env[`SQS_QUEUE_URL_${queueName.toUpperCase()}`];

    // 🚀 OMEGA UNIFICATION: 
    // If payload doesn't have 'name', we use the options.jobName or 'default'
    const unifiedPayload = {
        name: payload.name || options.jobName || 'default',
        data: payload.data || payload
    };

    const command = new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(unifiedPayload), // Now contains {name, data}
        ...options,
    });
        try {
            const result = await this.sqsClient.send(command);
            logger.debug(`SQS: Message sent to ${queueName}. ID: ${result.MessageId}`);
            return result;
        } catch (error) {
            logger.error(`❌ SQS Send Error to ${queueName}:`, error.message);
            throw new InternalServerError(`Failed to send message to SQS queue ${queueName}.`);
        }
    }

    /**
     * @desc Starts a dedicated long-polling worker for the specified queue.
     * @param {string} queueName - The SQS queue name to consume from.
     * @param {Function} processor - The job processing function (async (job) => {}).
     * @param {object} [options] - Worker-specific configuration.
     */
    process(queueName, processor, options = {}) {
        if (!this.sqsClient) throw new InternalServerError("SQS Client not connected.");
        if (this.pollingWorkers.has(queueName) && this.pollingWorkers.get(queueName).isRunning) return;

        // 💡 ROBUSTNESS: Define the polling loop function
        const pollQueue = async () => {
            if (!this.pollingWorkers.get(queueName)?.isRunning) return; // Check flag before polling

            const QueueUrl = process.env[`SQS_QUEUE_URL_${queueName.toUpperCase()}`] || 
                             `https://sqs.${process.env.AWS_REGION}.amazonaws.com/ACCOUNT_ID/${queueName}`;
            
            const receiveCommand = new ReceiveMessageCommand({
                QueueUrl,
                MaxNumberOfMessages: options.MaxMessages || MAX_MESSAGES,
                WaitTimeSeconds: options.WaitTimeSeconds || WAIT_TIME_SECONDS, // Long Polling
                VisibilityTimeout: options.VisibilityTimeout || VISIBILITY_TIMEOUT_SECONDS,
                MessageAttributeNames: ["All"],
            });

            try {
                const response = await this.sqsClient.send(receiveCommand);
                const messages = response.Messages || [];

                if (messages.length > 0) {
                    logger.info(`SQS Worker [${queueName}]: Received ${messages.length} messages.`);
                }

                // Process messages in parallel (efficiency)
                await Promise.all(messages.map(async (message) => {
                    try {
                        const job = { 
                            id: message.MessageId, 
                            payload: JSON.parse(message.Body),
                            receiptHandle: message.ReceiptHandle 
                        };
                        
                        // 1. Execute the main job logic
                        await processor(job); 

                        // 2. Delete the message upon successful completion
                        const deleteCommand = new DeleteMessageCommand({
                            QueueUrl,
                            ReceiptHandle: message.ReceiptHandle,
                        });
                        await this.sqsClient.send(deleteCommand);
                        logger.debug(`SQS Worker [${queueName}]: Deleted message ${job.id}.`);

                    } catch (procError) {
                        // 💡 RESILIENCE: Log processing error but DO NOT delete the message.
                        // The message will reappear after the VisibilityTimeout expires.
                        logger.error(`SQS Worker [${queueName}] Job ${message.MessageId} failed processing.`, procError.message);
                    }
                }));

            } catch (sqsError) {
                logger.error(`❌ SQS Polling Error on [${queueName}]:`, sqsError.message);
                // Non-fatal error, the next poll attempt will still run
            }
        };

        // 💡 EFFICIENCY: Use an immediate poll and then run on a short, fixed interval (e.g., 1 second)
        // to manage the polling loop without waiting the full 20 seconds of long-polling for the next cycle.
        const intervalId = setInterval(pollQueue, 1000); 
        this.pollingWorkers.set(queueName, { intervalId, isRunning: true });
        
        logger.info(`✅ SQS Worker [${queueName}]: Polling loop started.`);
        pollQueue(); // Initial run immediately
    }
    
    /**
     * @desc Gracefully stops all active polling workers.
     * @returns {Promise<void>}
     */
    async close() {
        logger.info("Stopping all SQS polling workers...");
        
        // Clear all intervals and set running flags to false
        this.pollingWorkers.forEach((worker, queueName) => {
            clearInterval(worker.intervalId);
            worker.isRunning = false;
            logger.info(`SQS Worker [${queueName}] stopped.`);
        });

        this.pollingWorkers.clear();
        this.sqsClient = null;
        logger.info("SQS system shut down gracefully.");
    }
}

module.exports = SQSAdapter;