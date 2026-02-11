// services/queueClient.js (Unified Queue Client)

/* ===========================
   🔒 ENV VALIDATION (FAIL FAST)
   =========================== */
if (!process.env.QUEUE_PROVIDER) {
    throw new Error("❌ [FATAL CONFIG] Missing required environment variable: QUEUE_PROVIDER (e.g., 'BullMQ' or 'SQS').");
}
if (!process.env.REDIS_HOST) {
    // Even if SQS is used, BullMQ is often used internally for local tasks/scheduler, so check Redis.
    console.warn("⚠️ REDIS_HOST is not set. SQS provider might work, but BullMQ features will fail.");
}

/* ===========================
   📦 Queue Adapters
   =========================== */
const BullMQAdapter = require('./BullMQAdapter');
const SQSAdapter = require('./SQSAdapter');
const InternalServerError = require("../errors/internalServerError")
const adapterMap = {
    'BullMQ': BullMQAdapter,
    'SQS': SQSAdapter,
};

const providerName = process.env.QUEUE_PROVIDER;
const QueueAdapter = adapterMap[providerName];

if (!QueueAdapter) {
    throw new Error(`❌ [FATAL CONFIG] Invalid QUEUE_PROVIDER: ${providerName}. Must be one of: ${Object.keys(adapterMap).join(', ')}.`);
}

/* ===========================
   ⚙️ Client Initialization and Manager
   =========================== */

const queueClient = new QueueAdapter();
let isConnected = false;

/**
 * Ensures the underlying connection (Redis, AWS, etc.) is established before use.
 * This is the public facing connection method for the service runner.
 * @returns {Promise<void>}
 */
async function connect() {
    if (isConnected) return;
    try {
        await queueClient.connect(); // Delegate connection logic to the adapter
        isConnected = true;
        console.log(`✅ Queue Client initialized and connected using provider: ${providerName}.`);
    } catch (error) {
        console.error(`❌ FATAL: Queue Client connection failed for ${providerName}.`, error.message);
        throw error;
    }
}


/* ===========================
   ✅ Exports (Robust Unified Interface)
   =========================== */

module.exports = {
    /**
     * @desc Initializes the queue connections. MUST be called on service start.
     */
    connect,
    
    /**
     * @desc Adds a job to the queue.
     */
    send: (queueName, payload, options = {}) => {
        if (!isConnected) throw new InternalServerError("Queue Client not connected. Call .connect() first.");
        return queueClient.send(queueName, payload, options);
    },

    /**
     * @desc Starts a worker to consume and process jobs.
     */
    process: (queueName, processor, options = {}) => {
        if (!isConnected) throw new InternalServerError("Queue Client not connected. Call .connect() first.");
        return queueClient.process(queueName, processor, options);
    },

    /**
     * @desc Gracefully shuts down all connections/workers.
     */
    close: () => queueClient.close(),

    getProviderName: () => providerName,
};