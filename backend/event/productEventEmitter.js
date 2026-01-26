// events/productEventEmitter.js
// Assume queueJob is imported from the new structure that exposes the queue name constants
const { queueJob, DOMAIN_QUEUE_NAME } = require("../queue/jobQueue"); 
const logger = require("../config/logger");
const Tracer = require("../utils/tracer"); // For ensuring context propagation

// --- Event Domain Mapping and Versioning ---
// GALACTIC HORIZON RESILIENCE: Imported configuration for all domain events.
// The content of this file is assumed to be the comprehensive EVENT_MAP from the previous step.
const EVENT_MAP = require("../validators/EVENT_MAP") 

/**
 * @class ProductEventEmitter
 * @desc Manages the publication of domain events. Ensures explicit schema versioning 
 * and context propagation for Hyper-Scale reliability.
 */
class ProductEventEmitter {
    
    /**
     * @desc Conceptual function to get structured user/tenant context from the request/service boundary.
     * @param {Object} context 
     * @returns {Object} Structured context data.
     */
    static getRuntimeContext(context = {}) {
        return {
            userId: context.userId || 'system', 
            tenantId: context.tenantId || 'default',
            requestId: context.requestId || Tracer.generateTraceId(), 
        };
    }

    /**
     * @desc Publishes an event to the queue.
     * @param {string} eventName - The simple event key (e.g., 'ProductCreated'). Must match EVENT_MAP keys.
     * @param {Object} data - The primary payload (usually a ProductOutputDTO). Must include an 'id' or '_id'.
     * @param {string} [sourceService='ProductService'] - The service that initiated the event.
     * @param {Object} [context={}] - Optional context fields (e.g., traceId, userId, tenantId).
     * @returns {Promise<Object>} The queued job object.
     */
    static async emit(eventName, data, sourceService = 'ProductService', context = {}) {
        const eventConfig = EVENT_MAP[eventName];

        if (!eventConfig) {
            logger.error(`Event Emitting failed: Unknown event name provided.`, { eventName });
            throw new Error(`Invalid domain event name: ${eventName}`);
        }
        
        // Ensure the ID exists (supports either ._id or .id from DTO/Mongoose)
        const productId = data._id ? data._id.toString() : data.id;
        if (!productId) {
            logger.error(`Event Emitting failed: Missing product ID for event ${eventName}.`, { eventName });
            throw new Error(`Cannot emit event without a valid product ID in the payload.`);
        }

        const traceId = context.traceId || Tracer.getTraceId();
        const runtimeContext = ProductEventEmitter.getRuntimeContext(context);

        // Construct the immutable event payload
        const eventPayload = Object.freeze({
            // --- Event Envelope/Metadata ---
            type: eventConfig.type,             
            version: eventConfig.version,       
            timestamp: new Date().toISOString(),
            source: sourceService,
            
            // --- Context Propagation (For Tracing and Auditing) ---
            context: {
                traceId: traceId,
                correlationId: context.correlationId || traceId, 
                userId: runtimeContext.userId,
                tenantId: runtimeContext.tenantId,
                requestId: runtimeContext.requestId,
            },

            // --- Domain Payload ---
            data: data, 
        });

        logger.info(`Event Emitter: Firing event ${eventConfig.type} (v${eventConfig.version}).`, { 
            traceId, 
            productId, 
            eventName,
            userId: runtimeContext.userId 
        });
        
        // Pass resilience and priority metadata to the queue function
        const jobOptions = {
            attempts: eventConfig.maxRetries, // Renamed maxAttempts to attempts to match BullMQ/queueJob signature
            priority: eventConfig.priority,
        };
        
        // 🚀 COSMIC UPGRADE: Corrected queueJob call with three arguments:
        // 1. queueName (Dedicated Domain Queue)
        // 2. jobName (The formal event type/name)
        // 3. data (The payload)
        // 4. options (Job metadata)
        const job = await queueJob(
            DOMAIN_QUEUE_NAME,         // Queue Name
            eventConfig.type,          // Job Name (The formal event type)
            eventPayload,              // Data
            jobOptions                 // Options
        );
        
        logger.debug(`Event job queued successfully.`, { jobId: job.id, eventType: eventConfig.type, queue: DOMAIN_QUEUE_NAME });
        return job;
    }
}

module.exports = ProductEventEmitter;