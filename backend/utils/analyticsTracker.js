/**
 * utils/analyticsTracker.js
 *
 * A production-ready, rock-solid analytics tracker utility for large-scale e-commerce.
 * This implementation uses event batching, throttling, and reliable unload handling
 * to ensure high-performance, non-blocking tracking and minimal data loss.
 *
 * This module is designed to be imported and used immediately in a modern browser environment.
 */

// --- Configuration Constants ---
// In a real application, this URL should be stored in a secure configuration file.
const ANALYTICS_ENDPOINT = 'https://api.yourcompany.com/v1/events';
const BATCH_SIZE_LIMIT = 20; // Max events per batch POST request
const BATCH_INTERVAL_MS = 5000; // Timer to flush the queue (5 seconds)
const MAX_QUEUE_SIZE = 500; // Safety limit to prevent memory exhaustion
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity for session expiry

// Keys used in localStorage
const STORAGE_KEYS = {
    SESSION_ID: 'analytics_session_id',
    SESSION_EXPIRY: 'analytics_session_expiry',
    USER_ID: 'analytics_user_id', // Optional: for persistent guest/anonymous ID
};

// --- Internal State ---
const eventQueue = [];
let flushTimeout = null;
let currentSessionId = null;

// --- Utility Functions ---

/**
 * Generates a high-quality UUID (v4-like).
 * @returns {string} A unique identifier.
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Robustly reads or creates a session ID with a sliding expiration window.
 * This ensures long user journeys are grouped correctly but stale sessions expire.
 * @returns {string} The active session ID.
 */
function getSessionId() {
    const now = Date.now();
    try {
        const storedExpiry = localStorage.getItem(STORAGE_KEYS.SESSION_EXPIRY);
        const storedId = localStorage.getItem(STORAGE_KEYS.SESSION_ID);

        // Check if session exists and is not expired
        if (storedId && storedExpiry && now < parseInt(storedExpiry, 10)) {
            currentSessionId = storedId;
        } else {
            // Create a new session
            currentSessionId = generateUUID();
            // Clear the old expiry/ID to ensure a clean start
            localStorage.removeItem(STORAGE_KEYS.SESSION_EXPIRY);
        }

        // Update expiry time for the active session (sliding window)
        localStorage.setItem(STORAGE_KEYS.SESSION_ID, currentSessionId);
        localStorage.setItem(STORAGE_KEYS.SESSION_EXPIRY, (now + SESSION_TIMEOUT_MS).toString());

    } catch (e) {
        console.warn("[Analytics] localStorage access denied. Using volatile session ID.", e);
        if (!currentSessionId) {
            currentSessionId = generateUUID();
        }
    }
    return currentSessionId;
}

/**
 * Retrieves the currently logged-in user ID or a persistent anonymous ID.
 * NOTE: The actual authenticated ID must be set by the application's auth system.
 * @returns {string} The authenticated user ID or 'anonymous-{id}'.
 */
function getUserId() {
    try {
        // --- REAL-LIFE PLACEHOLDER ---
        // In a real app, 'window.user_context.id' would hold the *authenticated* user ID
        // set by your backend when the user logs in.
        const authenticatedId = window.user_context?.id;

        if (authenticatedId) {
            return authenticatedId;
        }

        // Use a persistent anonymous ID for guest users across sessions
        let anonymousId = localStorage.getItem(STORAGE_KEYS.USER_ID);
        if (!anonymousId) {
            anonymousId = `anon-${generateUUID()}`;
            localStorage.setItem(STORAGE_KEYS.USER_ID, anonymousId);
        }
        return anonymousId;

    } catch (e) {
        // Fallback for environments where localStorage/global context fails
        return 'anon-volatile';
    }
}

// --- Core Logic: Flushing, Scheduling, and Tracking ---

/**
 * Sends the current batch of events to the analytics server using Fetch/keepalive.
 * This is the asynchronous, non-blocking delivery method.
 */
async function flushQueue() {
    if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
    }

    if (eventQueue.length === 0) {
        return;
    }

    // Capture the events to send and clear the queue
    const eventsToSend = eventQueue.splice(0, eventQueue.length);
    console.debug(`[Analytics] Flushing ${eventsToSend.length} events...`);

    const payload = JSON.stringify({
        batchTimestamp: new Date().toISOString(),
        events: eventsToSend,
    });

    try {
        const response = await fetch(ANALYTICS_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Add secure, environment-specific API authentication headers here.
            },
            body: payload,
            // 'keepalive: true' ensures the request persists even if the page closes quickly
            keepalive: true,
        });

        if (!response.ok) {
            console.error(`[Analytics ERROR] Server status ${response.status}. Events were dropped.`);
        } else {
            console.log(`[Analytics SUCCESS] Sent ${eventsToSend.length} events.`);
        }

    } catch (error) {
        console.error(`[Analytics CRITICAL] Network error. Events dropped.`, error);
    }
}


/**
 * Schedules the queue flush based on either the batch size limit or the time interval.
 */
function scheduleFlush() {
    // 1. Immediate flush if batch size limit is reached
    if (eventQueue.length >= BATCH_SIZE_LIMIT) {
        console.debug(`[Analytics] Batch size limit hit (${BATCH_SIZE_LIMIT}). Flushing now.`);
        flushQueue();
        return;
    }

    // 2. Schedule interval flush if not already running
    if (!flushTimeout) {
        flushTimeout = setTimeout(flushQueue, BATCH_INTERVAL_MS);
    }
}


/**
 * The external interface for tracking a single user event.
 *
 * @param {string} eventName - The name of the event (e.g., 'product_viewed', 'checkout_started').
 * @param {Object} eventPayload - Contextual data related to the event (e.g., { productId: 123 }).
 */
export function trackEvent(eventName, eventPayload = {}) {
    if (!eventName || typeof eventPayload !== 'object') {
        console.error('[Analytics] Invalid event payload or name.');
        return;
    }

    // 1. Safety Check (Prevent queue overflow)
    if (eventQueue.length >= MAX_QUEUE_SIZE) {
        console.warn(`[Analytics WARNING] Queue overflow. Event '${eventName}' dropped.`);
        return;
    }

    // Get fresh context (session ID must be retrieved *before* adding the event)
    const sessionId = getSessionId();
    const userId = getUserId();

    // 2. Construct the Event Object with rich context
    const event = {
        name: eventName,
        data: eventPayload,
        context: {
            timestamp: new Date().toISOString(),
            sessionId: sessionId,
            userId: userId,
            path: window.location.pathname,
            referrer: document.referrer,
            screenWidth: window.screen.width,
            screenHeight: window.screen.height,
            userAgent: navigator.userAgent,
        }
    };

    // 3. Add to Queue
    eventQueue.push(event);

    // 4. Schedule/Execute Flush
    scheduleFlush();
}

// --- Initialization and Unload Handler ---

/**
 * Sets up the critical event handler to reliably send data upon page unload.
 */
function setupUnloadHandler() {
    window.addEventListener('beforeunload', () => {
        if (eventQueue.length === 0) return;

        // Clear timer to prevent race conditions
        if (flushTimeout) {
            clearTimeout(flushTimeout);
        }

        const eventsToSend = eventQueue.splice(0, eventQueue.length);
        const payload = { batchTimestamp: new Date().toISOString(), events: eventsToSend };

        if (navigator.sendBeacon) {
            // BEST PRACTICE: Use sendBeacon for guaranteed, non-blocking delivery on unload.
            const blob = new Blob([JSON.stringify(payload)], { type: 'application/json; charset=UTF-8' });
            navigator.sendBeacon(ANALYTICS_ENDPOINT, blob);
            console.debug(`[Analytics] Final ${eventsToSend.length} events sent via sendBeacon.`);
        } else {
            // Fallback for older browsers (not guaranteed)
            console.warn(`[Analytics] Falling back to fetch on unload.`);
            // Flush synchronously using fetch/keepalive (browser tries its best)
            fetch(ANALYTICS_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true,
            }).catch(() => {});
        }
    });
}

/**
 * Initializes the analytics tracker on script load.
 */
function initializeTracker() {
    // 1. Ensure the session context is active
    getSessionId();
    getUserId(); // Ensure anonymous ID is set if needed

    // 2. Set up the critical unload handler
    setupUnloadHandler();

    console.log('[Analytics Tracker] Initialized successfully. Ready to track events.');
}

// Immediately initialize the tracker when the script is loaded
initializeTracker();