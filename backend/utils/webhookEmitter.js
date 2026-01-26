/**
 * utils/webhookEmitter.js
 *
 * A production-ready, rock-solid utility for asynchronously and reliably emitting webhooks.
 * Designed for a Node.js environment.
 * Implements exponential backoff retries and actual HMAC-SHA256 payload signing for security.
 */

// Import the native Node.js crypto module for secure hashing
const crypto = require('crypto');
// We rely on the global 'fetch' API, which is now standard in modern Node.js versions (v18+).
// If running in an older environment, you would use: const fetch = require('node-fetch');

// --- Configuration Constants ---

// The secret key used to sign the payload (HMAC).
// In a production environment, this MUST be retrieved from a secure environment variable.
const WEBHOOK_SECRET = process.env.WEBHOOK_SIGNING_SECRET || 'fallback_insecure_secret_PLEASE_UPDATE';
// Maximum number of delivery attempts
const MAX_ATTEMPTS = 5;
// Base delay for exponential backoff (e.g., 1000ms, 2000ms, 4000ms, ...)
const BACKOFF_BASE_MS = 1000;
// Header name for the payload signature
const SIGNATURE_HEADER = 'X-Webhook-Signature';
// Header name for the attempt count
const ATTEMPT_HEADER = 'X-Delivery-Attempt';
// HMAC algorithm used
const HMAC_ALGORITHM = 'sha256';

// --- Utility Functions ---

/**
 * Calculates the next delay using exponential backoff with a jitter factor.
 * Formula: (2^attempt * BACKOFF_BASE_MS) + Random Jitter
 * @param {number} attempt - The current attempt number (starts at 1).
 * @returns {number} The delay in milliseconds.
 */
function getNextDelay(attempt) {
    // Prevent attempt from being 0 (which results in 2^0 = 1)
    const factor = Math.pow(2, attempt - 1);
    // Add a random jitter (0 to 1000ms) to prevent thundering herd problem
    const jitter = Math.random() * 1000;
    return (factor * BACKOFF_BASE_MS) + jitter;
}

/**
 * Creates an HMAC-SHA256 signature of the payload using the secret key.
 * This uses the native Node.js 'crypto' module for secure, efficient hashing.
 * @param {string} payload - The stringified JSON payload.
 * @returns {string} The signature prefixed with the algorithm (e.g., "sha256=abcdef12345...").
 */
function signPayload(payload) {
    // Use try/catch in case the secret key is missing or crypto is unavailable
    try {
        const hmac = crypto.createHmac(HMAC_ALGORITHM, WEBHOOK_SECRET);
        hmac.update(payload);
        const signature = hmac.digest('hex');
        return `${HMAC_ALGORITHM}=${signature}`;
    } catch (error) {
        console.error("[Webhook Emitter] CRITICAL: Failed to sign payload. Check WEBHOOK_SECRET.", error.message);
        // Return a recognizable error signature instead of failing the whole request
        return `error=signing-failed`;
    }
}

// --- Core Emission Logic ---

/**
 * Attempts to send the webhook, handling retries via exponential backoff.
 * @param {string} url - The recipient webhook URL.
 * @param {Object} data - The payload data to send.
 * @param {number} attempt - The current attempt number (1-indexed).
 */
async function attemptSend(url, data, attempt) {
    const stringifiedPayload = JSON.stringify(data);
    const signature = signPayload(stringifiedPayload);
    const logPrefix = `[Webhook Emitter][Attempt ${attempt}/${MAX_ATTEMPTS}]`;

    // Immediately fail if signing failed permanently
    if (signature.startsWith('error=')) {
        console.error(`${logPrefix} FINAL FAILURE: Aborting due to payload signing failure.`);
        return;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [SIGNATURE_HEADER]: signature,
                [ATTEMPT_HEADER]: attempt,
            },
            body: stringifiedPayload,
            // A higher timeout might be appropriate for remote webhooks
            // timeout: 10000,
        });

        if (response.ok) {
            // Success: status code 200-299
            console.log(`${logPrefix} SUCCESS: Webhook sent successfully to ${url}. Status: ${response.status}`);
            return;
        }

        // Non-OK status but retriable (e.g., 429 Too Many Requests, 5xx server errors)
        // 500, 502, 503, 504 are standard retriable codes. 429 is rate limiting.
        if (attempt < MAX_ATTEMPTS && (response.status >= 500 || response.status === 429)) {
            const delay = getNextDelay(attempt + 1);
            console.warn(`${logPrefix} RETRYING: Status ${response.status}. Retrying in ${Math.round(delay / 1000)}s...`);
            // Use setTimeout for non-blocking retry scheduling
            setTimeout(() => attemptSend(url, data, attempt + 1), delay);
            return;
        }

        // Permanent Failure (e.g., 400 Bad Request, 401 Unauthorized, 404 Not Found)
        console.error(`${logPrefix} FINAL FAILURE: Failed to send webhook to ${url}. Status: ${response.status}. Dropping event.`);

    } catch (error) {
        // Network Error (DNS failure, connection refused, fetch timeout, etc.)
        if (attempt < MAX_ATTEMPTS) {
            const delay = getNextDelay(attempt + 1);
            console.error(`${logPrefix} NETWORK ERROR: ${error.message}. Retrying in ${Math.round(delay / 1000)}s...`);
            setTimeout(() => attemptSend(url, data, attempt + 1), delay);
        } else {
            console.error(`${logPrefix} CRITICAL FAILURE: Max attempts reached. Network error: ${error.message}. Dropping event.`);
        }
    }
}

/**
 * Initiates the non-blocking process of sending a webhook.
 *
 * @param {string} url - The full URL of the webhook receiver.
 * @param {Object} payload - The event data (e.g., order details, user info).
 * @returns {void} - This function returns immediately, delegating delivery to the background.
 */
export function emitWebhook(url, payload) {
    if (!url || !payload) {
        console.error("[Webhook Emitter] Invalid arguments: URL and payload are required.");
        return;
    }

    console.log(`[Webhook Emitter] Initializing delivery for event: ${payload.eventType || 'N/A'}`);

    // Start the process asynchronously immediately with the first attempt.
    attemptSend(url, payload, 1);
}