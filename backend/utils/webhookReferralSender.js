/**
 * utils/webhookQueueManager.js
 * Manages the asynchronous sending of referral-related webhooks using BullMQ.
 *
 * This service implements best practices for large-scale e-commerce webhooks:
 * 1. Decoupling: Uses a dedicated queue (webhookQueue) for asynchronous processing.
 * 2. Resilience: Implements smart retries (via p-retry) that distinguish between 
 * transient (5xx, network) and permanent (4xx) HTTP errors, preventing useless retries.
 *
 * NOTE: This file is used by two separate processes:
 * 1. The main application (to call enqueueReferralWebhook).
 * 2. The BullMQ Worker (to call sendWebhook).
 */
const axios = require("axios");
const pRetry = require("p-retry");
// Assuming the path to your BullMQ queue instance is correct
const { webhookQueue } = require("../utils/referralQueue") 

// --- 1. CORE ERROR TYPES ---

/**
 * Custom Error class for non-retryable HTTP failures (e.g., 400 Bad Request, 403 Forbidden).
 * Throwing this error signals the internal p-retry mechanism to stop immediately, 
 * saving resources and marking the job as failed faster.
 * @extends Error
 */
class NonRetryableError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'NonRetryableError';
        this.status = status;
        // Use captureStackTrace for better error debugging
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, NonRetryableError);
        }
    }
}

// --- 2. CORE HTTP SENDER WITH SMART RETRY LOGIC (Used by the Worker) ---

/**
 * Low-level function to send the webhook with configured retries and backoff.
 * This should ONLY be called from the dedicated BullMQ Worker process.
 *
 * @param {object} jobData - Contains url, payload, and audit data.
 * @param {string} jobData.url - The target webhook URL.
 * @param {object} jobData.payload - The data to send (e.g., commission object).
 * @param {string} jobData.keyId - A primary identifier (e.g., Referral Code, Order ID) for logging.
 * @param {object} [jobData.headers={}] - Custom headers.
 * @param {number} [jobData.timeout=5000] - Request timeout in milliseconds.
 * @returns {Promise<any>} The response data on success.
 */
async function sendWebhook(jobData) {
    const { url, payload, keyId, headers = {}, timeout = 5000 } = jobData;

    if (!url) {
        // Configuration error: stop immediately, no retry
        throw new NonRetryableError("Webhook URL required in job data", 0); 
    }

    // WEBHOOK_RETRIES applies to the p-retry mechanism *within* this function
    const maxRetries = parseInt(process.env.WEBHOOK_RETRIES || "5", 10);

    const attempt = async (attemptNumber) => {
        console.log(`[Webhook][${keyId}] Attempting POST to ${url}. Attempt: ${attemptNumber}/${maxRetries}`);

        try {
            // Set up common headers
            const requestHeaders = {
                'Content-Type': 'application/json',
                'User-Agent': 'Referral-Service-Webhook-Sender/1.0',
                ...headers, // Allow custom headers to override or supplement
            };

            const res = await axios.post(url, payload, { 
                headers: requestHeaders, 
                timeout 
            });

            // Success check (2xx)
            if (res.status >= 200 && res.status < 300) {
                console.log(`[Webhook][${keyId}] SUCCESS: Status ${res.status}.`);
                return res.data;
            }

            const errorStatus = res.status;

            // Permanent/Non-Retryable Error Check (4xx range, excluding 429/408 which are transient)
            if (errorStatus >= 400 && errorStatus < 500 && errorStatus !== 429 && errorStatus !== 408) {
                const message = `Webhook failed permanently. Status: ${errorStatus}. Response: ${JSON.stringify(res.data || res.statusText)}`;
                console.error(`[Webhook][${keyId}] NON-RETRYABLE FAILURE: ${message}`);
                // Throw custom error to stop p-retry immediately
                throw new NonRetryableError(message, errorStatus);
            }

            // Transient Error (3xx, 5xx, 429 Too Many Requests, 408 Request Timeout)
            const retryMessage = `Webhook failed transiently. Status: ${errorStatus}. Will retry.`;
            console.warn(`[Webhook][${keyId}] RETRYING: ${retryMessage}`);
            const err = new Error(retryMessage);
            err.status = errorStatus;
            throw err;

        } catch (error) {
            // 1. Check for previously identified permanent failure
            if (error instanceof NonRetryableError) {
                throw error;
            }
            
            // 2. Handle network/timeout errors from Axios
            if (axios.isAxiosError(error) && !error.response) {
                // Network error (DNS, connection refused, timeout)
                console.warn(`[Webhook][${keyId}] Network Error (Transient). Will retry. Code: ${error.code}`);
                // Throw standard error for p-retry to catch and schedule next attempt
                throw new Error(`Connection or Network failure: ${error.code}`);
            }

            // 3. Re-throw other errors (e.g., transient HTTP failures from the try block)
            throw error;
        }
    };

    // p-retry handles the exponential backoff (minTimeout, maxTimeout, factor)
    return pRetry(attempt, {
        retries: maxRetries,
        minTimeout: 500, // Start with 500ms delay
        maxTimeout: 30000, // Max delay of 30 seconds
        factor: 2, // Exponential backoff factor (1s, 2s, 4s, 8s...)
        onFailedAttempt: error => {
            // Important: Stop retrying if the core logic threw a permanent failure
            if (error.name === 'NonRetryableError') {
                throw error;
            }
        },
    });
}

// --- 3. HIGH-LEVEL QUEUE MANAGER (Used by the Main Application) ---

/**
 * Public function to enqueue a webhook job for processing in the background.
 * This is the primary function to be called from your referral service logic
 * whenever a trigger event occurs (e.g., commission earned).
 * * @param {object} data - The data required for the webhook.
 * @param {string} data.url - The target webhook URL.
 * @param {object} data.payload - The data to send (must include referral code/details).
 * @param {string} data.keyId - A unique identifier (e.g., 'REF_COMMISSION_9001') for audit logs.
 * @param {object} [data.headers] - Optional custom headers.
 * @returns {Promise<import('bullmq').Job>} The BullMQ Job instance.
 */
async function enqueueReferralWebhook({ url, payload, keyId, headers = {} }) {
    if (!url || !payload || !keyId) {
        throw new Error("URL, payload, and keyId are required for enqueuing a webhook.");
    }
    
    const jobData = {
        url,
        payload,
        keyId, // Key for auditing
        headers,
    };
    
    // Add the job to the dedicated queue
    const job = await webhookQueue.add(
        'send-webhook', // Job name used by the worker to identify the handler function
        jobData, 
        { 
            // Use the keyId as the Job ID for strong idempotency control
            jobId: keyId, 
            // QUEUE_MAX_ATTEMPTS sets the number of times BullMQ will attempt the job *if* the worker fails.
            // This is separate from the p-retry attempts *inside* the worker.
            attempts: parseInt(process.env.QUEUE_MAX_ATTEMPTS || "3", 10),
            backoff: {
                type: 'exponential', // Use queue-level exponential backoff
                delay: 5000 // Initial delay for BullMQ retries (e.g., 5s, 10s, 20s)
            },
        }
    );

    console.log(`[Webhook][${keyId}] Successfully enqueued webhook job ${job.id} for URL: ${url}`);
    
    return job;
}

/**
 * Retrieves the current status and relevant details for a specific webhook job.
 * @param {string} jobId - The unique ID of the BullMQ job (which is also the keyId).
 * @returns {Promise<object>} Object containing job status and details, or null if not found.
 */
async function getWebhookJobStatus(jobId) {
    if (!jobId) {
        throw new Error("Job ID is required to fetch job status.");
    }
    
    // Get the job instance from the queue
    const job = await webhookQueue.getJob(jobId);

    if (!job) {
        return { jobId, status: 'not_found', details: 'Job ID not found in the queue registry.' };
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
            url: job.data.url,
            keyId: job.data.keyId,
            // Only include payload structure info, not the full payload for brevity in status checks
            payloadType: typeof job.data.payload, 
        },
        // Meta information
        attemptsMade: job.attemptsMade,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        error: lastError,
    };
    
    console.log(`[Webhook Manager][${jobId}] Status checked: ${status}`);

    return result;
}

/**
 * ADMIN: Retrieves a paginated list of all actual webhook jobs (Historical Queue Data).
 * This fetches data directly from the BullMQ queue history.
 * @param {object} query - Filtering and pagination parameters.
 * @param {number} [query.page=1]
 * @param {number} [query.limit=25]
 * @param {string[]} [query.statuses=['completed', 'failed', 'active']] - Statuses to fetch.
 * @returns {Promise<object>} Paginated result object.
 */
async function getWebhookJobHistory(query) {
    const { page = 1, limit = 25, statuses = ['completed', 'failed', 'active'] } = query;
    // Calculate the starting index for BullMQ's getJobs method
    const start = (page - 1) * limit;
    // Calculate the ending index (inclusive)
    const end = start + limit - 1; 

    // 1. Get jobs by state using start/end indices for pagination
    const jobs = await webhookQueue.getJobs(statuses, start, end);
    
    // 2. Get total counts for the queried statuses
    const counts = await webhookQueue.getJobCounts(...statuses);
    
    // Sum the counts of the statuses being queried (BullMQ returns keys like 'completed', 'failed')
    const totalCount = statuses.reduce((sum, status) => {
        return sum + (counts[status] || 0);
    }, 0);

    const totalPages = Math.ceil(totalCount / limit);
    
    // 3. Process jobs to return simplified data for history view
    const historyData = jobs.map(job => ({
        jobId: job.id,
        status: job.status,
        keyId: job.data.keyId,
        url: job.data.url,
        attemptsMade: job.attemptsMade,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        error: job.failedReason || null,
        // Omit the full payload for history view brevity
    }));

    return {
        page: page,
        limit: limit,
        totalPages: totalPages,
        totalCount: totalCount,
        data: historyData,
    };
}


module.exports = { 
    sendWebhook, 
    enqueueReferralWebhook, 
    getWebhookJobStatus, 
    getWebhookJobHistory, // New function exported
    NonRetryableError,
};