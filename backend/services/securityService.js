// services/securityService.js (HYPER-DIMENSIONAL ZENITH: Queue-Backed Resilience)

const axios = require('axios');
const Logger = require('../utils/logger');
const Tracing = require('../utils/tracingClient');
const { CircuitBreaker, ServiceUnavailableError } = require('./circuitBreaker'); 
// Conceptual Import: Use a robust queue for audit logs
const MQClient = require('../utils/messageQueueClient'); 

// --- Configuration ---
const SECURITY_WEBHOOK_URL = process.env.SECURITY_WEBHOOK_URL || 'https://security-endpoint.example.com/events';
const WEBHOOK_TIMEOUT_MS = 3000;
const SECURITY_AUDIT_QUEUE = 'audit:security:logout';

// --- 1. Define the Core Action to Protect (Queue Write) ---

/**
 * @desc The actual action protected by the Circuit Breaker: writing the payload to a persistent queue.
 * @param {object} payload - The structured SIEM event data.
 * @returns {Promise<void>}
 */
const queueEventAction = async (payload) => {
    // This action protects the internal queueing mechanism itself (e.g., Redis/Kafka connectivity)
    await MQClient.publish(SECURITY_AUDIT_QUEUE, payload);
};

// --- 2. Instantiate the Circuit Breaker ---

// Configuration for the Queue Breaker (must be highly resilient, so minimum threshold is high)
const QUEUE_BREAKER_OPTIONS = {
    name: 'security-queue-writer',
    windowSize: 50,                       // Check last 50 attempts
    minimumRequestThreshold: 15,          // Requires 15 failures to trip
    errorPercentageThreshold: 30,         // Trip if queue connectivity drops below 70% success
    resetTimeout: 20000,                  // Wait 20s in OPEN state
    timeout: 1000,                        // Queue write must be fast (<1s)
    halfOpenSuccessThreshold: 3,
    resetTimeoutJitter: 0.1,
};

const queueBreaker = new CircuitBreaker(queueEventAction, QUEUE_BREAKER_OPTIONS);


// --- 3. The Public Service Method ---

/**
 * @desc Sends a critical user logout event for eventual delivery via a resilient queue.
 * @param {object} event - Logout event data.
 * @param {string} event.userId - The ID of the user who logged out.
 * @param {string} event.ip - The IP address associated with the session end.
 * @param {string} event.type - The logout event type ('MANUAL', 'TIMEOUT', 'FORCE_REVOKE').
 * @param {string} [event.sessionId] - Session ID for rich context.
 * @param {string} [event.reasonCode] - Specific reason code for the SIEM.
 */
const sendLogoutEvent = async ({ userId, ip, type, sessionId, reasonCode }) => {
    
    // Payload remains the same
    const payload = {
        timestamp: new Date().toISOString(),
        event_id: Tracing.getCurrentSpanContext()?.traceId || `LOCAL_EVENT_${Date.now()}`, 
        user_id: userId,
        source_ip: ip,
        event_type: type,
        session_id: sessionId,
        reason_code: reasonCode,
        severity: 'INFO',
    };

    try {
        // Execute the protected action: writing to the internal queue
        await queueBreaker.execute(payload);

        Logger.info('SIEM_EVENT_QUEUED', { 
            userId, 
            type, 
            queue: SECURITY_AUDIT_QUEUE,
            breakerState: queueBreaker.getState() 
        });

    } catch (error) {
        if (error instanceof ServiceUnavailableError) {
            // CRITICAL: The internal security queue is down. Alert SRE immediately!
            Logger.alert('FATAL_QUEUE_UNAVAILABLE', { 
                userId, 
                reason: 'Circuit Breaker OPEN on Audit Queue', 
                queue: SECURITY_AUDIT_QUEUE
            });
            // We still fail-open here, but the alert is now much higher severity.
            return;
        }

        // Catastrophic failure during queue write (e.g., client serialization error)
        Logger.error('SECURITY_QUEUE_WRITE_FAILED', {
            userId,
            error: error.name,
            breakerState: queueBreaker.getState(),
        });
    }
};

const securityService = {
    sendLogoutEvent,
    getCircuitState: () => queueBreaker.getState(),
};

module.exports = securityService;