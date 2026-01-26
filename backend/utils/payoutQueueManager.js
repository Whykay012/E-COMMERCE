/**
 * utils/payoutQueueManager.js
 * Provides the public interface for the main application to enqueue 
 * payout jobs, adding flow control for scheduling, and check their status, 
 * as well as administrative functions for job control and history.
 * * NOTE: This version uses Mongoose/MongoDB for persistence.
 */
// Ensure the path correctly points to your queue definition file
const { payoutQueue } = require("../"); 
const crypto = require("crypto");
// Assuming these error classes are defined elsewhere
const { NotFoundError } = require("../errors/notFoundError"); 
const { BadRequestError } = require("../errors/bad-request-error"); 

// --- Mongoose Imports ---
const mongoose = require("mongoose");
const PayoutLedger = require("../model/PayoutLedger"); // Import the Mongoose Model


/**
 * PayoutDisbursementLedgerService
 * Implements a persistence layer using Mongoose, which manages reading 
 * historical data from the MongoDB PayoutLedger collection.
 */
const PayoutDisbursementLedgerService = {
    _isReady: false, 

    /**
     * Simulates initialization by confirming Mongoose connection status.
     * In a real app, this ensures the database is accessible before running queries.
     */
    async initialize() {
        if (this._isReady) return;

        // Check if Mongoose connection is already established (readyState 1 means connected)
        if (mongoose.connection.readyState === 1) { 
            this._isReady = true;
            console.log("[PayoutLedgerService] Mongoose connection is ready.");
            return;
        }

        // Wait briefly for connection (assuming it's initialized in the main server file)
        await new Promise(resolve => setTimeout(resolve, 50)); 
        
        if (mongoose.connection.readyState === 1) {
             this._isReady = true;
             console.log("[PayoutLedgerService] Mongoose connection established after wait.");
        } else {
            console.warn("[PayoutLedgerService] Mongoose connection not fully established. Queries may fail if the connection is not active.");
            this._isReady = true; // Proceed, trusting the upstream setup
        }
    },
    
    /**
     * Retrieves a paginated list of disbursement records from MongoDB using Mongoose.
     * @param {object} query - Filtering and pagination parameters.
     */
    async getDisbursementRecords(query) {
        if (!this._isReady) {
            await this.initialize();
        }

        const { page = 1, limit = 25, userId, status, provider } = query;
        const skip = (page - 1) * limit;
        
        // Build Mongoose Query Filter
        let filter = {};
        if (userId) {
            // Note: In a real app, userId might need to be converted to mongoose.Types.ObjectId
            filter.userId = userId; 
        }
        if (status) {
            filter.status = status;
        }
        if (provider) {
            filter.provider = provider;
        }

        // 1. Get total count (for pagination metadata)
        const totalCount = await PayoutLedger.countDocuments(filter);
        
        // 2. Fetch paginated, filtered, and sorted data
        const records = await PayoutLedger.find(filter)
            .sort({ createdAt: -1 }) // Sort by newest first
            .skip(skip)
            .limit(limit)
            .lean() // Optimize: returns plain JS objects, faster for reads
            .exec();

        const totalPages = Math.ceil(totalCount / limit);

        return {
            page: page,
            limit: limit,
            totalPages: totalPages,
            totalCount: totalCount,
            data: records, 
        };
    }
};


/**
 * Public function to enqueue a payout job for processing in the background.
 * @param {object} data - The data required for the payout.
 * @param {string} data.recipient - Recipient identifier.
 * @param {number} data.amount - Amount.
 * @param {string} data.reason - Reason for the payout.
 * @param {string} data.provider - The PSP to use.
 * @param {any} data.providerAccountId - The source account ID or bank code object.
 * @param {string} data.currency - The currency.
 * @param {number} [data.delay=0] - Optional delay in milliseconds.
 * @param {object} [data.metadata={}] - Audit and contextual metadata.
 * @returns {Promise<import('bullmq').Job>} The BullMQ Job instance.
 */
async function enqueuePayout({ 
    recipient, 
    amount, 
    reason, 
    provider, 
    providerAccountId, 
    currency, 
    delay = 0,
    metadata = {}
}) {
    // Generate a unique payoutId for idempotency and job tracking
    const payoutId = crypto.randomUUID();

    if (!recipient || typeof amount !== 'number' || !reason || !provider || !currency) {
        console.error("Missing required fields for payout:", { recipient, amount, reason, provider, currency });
        throw new Error("Recipient, amount, reason, provider, and currency are required for enqueuing a payout.");
    }
    
    // The data payload for the worker
    const jobData = {
        payoutId,
        recipient,
        amount,
        reason,
        provider,
        providerAccountId,
        currency,
        ...metadata, // Include audit metadata
    };
    
    // Add the job to the dedicated queue
    const job = await payoutQueue.add(
        'execute-payout', // Name of the task handler in the worker
        jobData, 
        { 
            jobId: payoutId, // CRITICAL: Idempotency key
            delay: delay, 
            
            // Queue-level retries if the job fails in the worker
            attempts: parseInt(process.env.PAYOUT_MAX_ATTEMPTS || "5", 10),
            backoff: {
                type: 'exponential', 
                delay: 10000 // Initial delay at 10 seconds 
            },
        }
    );

    console.log(`[Payout Manager][${payoutId}] Enqueued job ${job.id}. ${delay > 0 ? `Scheduled for processing in ${delay}ms.` : 'Processing immediately.'}`);
    
    return job;
}

/**
 * Retrieves the current status and relevant details for a specific payout job.
 * @param {string} jobId - The unique ID of the BullMQ job (which is also the payoutId).
 * @returns {Promise<object>} Object containing job status and details, or null if not found.
 */
async function getPayoutJobStatus(jobId) {
    if (!jobId) {
        throw new BadRequestError("Job ID is required to fetch job status.");
    }
    
    // Get the job instance from the queue
    const job = await payoutQueue.getJob(jobId);

    if (!job) {
        return null; // Controller handles NotFoundError
    }

    // Get the state (status) of the job
    const status = await job.getState();

    // Retrieve last error if the job has failed
    const lastError = status === 'failed' ? job.failedReason : undefined;
    
    // Determine if the job is finished
    const isCompleted = status === 'completed' || status === 'failed';

    const result = {
        jobId: job.id,
        name: job.name,
        status: status, // e.g., 'waiting', 'active', 'completed', 'failed', 'delayed'
        isFinished: isCompleted,
        data: {
            recipient: job.data.recipient,
            amount: job.data.amount,
            currency: job.data.currency,
            provider: job.data.provider,
            userId: job.data.userId, // Included from metadata
        },
        // Meta information
        attemptsMade: job.attemptsMade,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        error: lastError,
    };
    
    console.log(`[Payout Manager][${jobId}] Status checked: ${status}`);

    return result;
}

/**
 * ADMIN: Attempts to cancel a pending or scheduled payout job.
 * @param {string} jobId - The unique ID of the BullMQ job.
 * @param {string} adminId - The ID of the admin performing the cancellation (for logging).
 * @returns {Promise<object>} Result object indicating if the job was cancelled.
 */
async function cancelPayoutJob(jobId, adminId) {
    if (!jobId) {
        throw new BadRequestError("Job ID is required for cancellation.");
    }

    const job = await payoutQueue.getJob(jobId);

    if (!job) {
        throw new NotFoundError(`Job ID ${jobId} not found.`);
    }

    const status = await job.getState();

    // Only allow cancellation if the job hasn't started or is delayed
    if (status === 'waiting' || status === 'delayed') {
        try {
            // BullMQ remove() works for waiting/delayed jobs and cleans up redis entry
            await job.remove(); 
            console.log(`[Payout Manager][${jobId}] Job successfully cancelled by Admin ${adminId}.`);
            return { cancelled: true, message: `Job ${jobId} cancelled successfully.` };
        } catch (error) {
            console.error(`[Payout Manager][${jobId}] Error removing job:`, error);
            // This case might happen if the job status changes right before remove()
            return { cancelled: false, message: `Failed to cancel job ${jobId}. Possible race condition or queue error.` };
        }
    } else if (status === 'active') {
        // Active jobs can't be safely removed, they must be allowed to finish or fail.
        return { cancelled: false, message: `Job ${jobId} is currently running and cannot be cancelled.` };
    } else {
        // completed, failed, or unknown status
        return { cancelled: false, message: `Job ${jobId} is already in state '${status}' and cannot be cancelled.` };
    }
}

/**
 * ADMIN: Retrieves a paginated list of all actual payout disbursement transactions (Historical Ledger).
 * Now uses the Mongoose-backed PayoutDisbursementLedgerService.
 * @param {object} query - Filtering and pagination parameters.
 * @param {number} query.page
 * @param {number} query.limit
 * @param {string} [query.userId]
 * @param {string} [query.status] // 'completed', 'failed', etc.
 * @param {string} [query.provider] // 'stripe', 'paypal', etc.
 * @returns {Promise<object>} Paginated result object.
 */
async function getPayoutDisbursementHistory(query) {
    // Delegate the complex filtering, sorting, and pagination logic to the service/repository layer
    const result = await PayoutDisbursementLedgerService.getDisbursementRecords(query);
    return result;
}


module.exports = { 
    enqueuePayout,
    getPayoutJobStatus,
    cancelPayoutJob,
    getPayoutDisbursementHistory,
};