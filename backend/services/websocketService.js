// services/websocketService.js (HYPER-DIMENSIONAL ZENITH: Guaranteed Session Revocation)

const Logger = require('../utils/logger');
const Tracing = require('../utils/tracingClient');
const { getRedisPubSubClient } = require('../utils/redisClient'); 
const SessionStore = require('../data/sessionStore'); // PEAK: Assume a way to read/delete primary session state
const ResilienceQueue = require('../utils/resilienceQueueClient'); // PEAK: Queue for failed events

// --- Configuration ---
const LOGOUT_CHANNEL = 'user_logout_events';
const FAILED_LOGOUT_QUEUE = 'queue:failed_logout_retries'; // Dedicated queue for reliability

// Assumed: Get an initialized Redis client dedicated for publishing
const pubClient = getRedisPubSubClient(); 

/**
 * @desc Publishes a message for forced session termination. Implements immediate fallback 
 * (SessionStore delete) and guaranteed delivery (ResilienceQueue) if Pub/Sub fails.
 * @param {string} userId - The ID of the user whose session should be terminated.
 * @param {string} sessionId - The specific session ID to terminate.
 * @param {string} type - The reason for the force logout ('SECURITY', 'ADMIN', 'PASSWORD_CHANGE').
 * @returns {Promise<boolean>} True if the event was published or successfully queued/deleted.
 */
const notifyUserLogout = async ({ userId, sessionId, type }) => {
    return Tracing.withSpan('WebsocketService:notifyUserLogout', async (span) => {
        
        const eventData = {
            user_id: userId,
            session_id: sessionId,
            action: 'force_logout',
            type: type,
            timestamp: Date.now(),
        };
        const message = JSON.stringify(eventData);
        span.setAttributes({ 'event.userId': userId, 'event.sessionId': sessionId, 'event.type': type });

        let isPubSubSuccess = false;

        // 1. Attempt Pub/Sub (Primary, real-time method)
        if (pubClient && pubClient.status === 'ready') {
            try {
                // PUBLISH the event to the dedicated channel
                const subscribers = await pubClient.publish(LOGOUT_CHANNEL, message); 
                
                Logger.info('PUBSUB_LOGOUT_SUCCESS', { 
                    userId, 
                    channel: LOGOUT_CHANNEL, 
                    subscribers,
                    messageSize: message.length
                });
                isPubSubSuccess = true;

            } catch (error) {
                // Network/Command failure - Pub/Sub failed.
                Logger.alert('PUBSUB_LOGOUT_FAILED_NETWORK', { 
                    userId, 
                    error: error.message, 
                    channel: LOGOUT_CHANNEL 
                });
            }
        } else {
             // Client explicitly not ready
             Logger.critical('PUBSUB_CLIENT_UNAVAILABLE', { userId, action: 'notify_logout' });
        }

        // 2. Fallback and Resilience (Guaranteed Delivery)

        if (!isPubSubSuccess) {
            
            // A. Attempt Immediate Persistence/Fallback (Delete the session in the authoritative store)
            try {
                // If the Pub/Sub failed, we immediately try to invalidate the authoritative session record.
                await SessionStore.deleteSession(userId, sessionId); 
                Logger.warn('LOGOUT_SESSION_STORE_DELETED', { userId, sessionId, reason: 'PubSub failure fallback' });
            } catch (storeError) {
                Logger.error('LOGOUT_STORE_DELETE_FAILED', { userId, storeError: storeError.message });
            }

            // B. Write to Resilience Queue (Retry later)
            try {
                // Even if the store delete succeeded, we queue the event for the listener 
                // to try Pub/Sub again when Redis recovers, ensuring all systems get the event.
                await ResilienceQueue.enqueue(FAILED_LOGOUT_QUEUE, eventData); 

                Logger.alert('LOGOUT_EVENT_QUEUED_FOR_RETRY', { 
                    userId, 
                    queue: FAILED_LOGOUT_QUEUE 
                });
                span.setAttribute('logout.fallback', 'QUEUED');
                return true; // The event is successfully handled (queued).

            } catch (queueError) {
                // If the primary Pub/Sub AND the Resilience Queue both fail, this is a total disaster.
                Logger.critical('LOGOUT_CATASTROPHIC_FAILURE', { 
                    userId, 
                    queueError: queueError.message, 
                    message: 'Cannot queue critical logout event!' 
                });
                span.setAttribute('logout.fallback', 'CATASTROPHIC_FAILURE');
                throw queueError; // Re-throw the ultimate failure
            }
        }
        
        span.setAttribute('logout.fallback', 'NONE');
        return true;
    });
};

const websocketService = {
    notifyUserLogout,
};

module.exports = websocketService;