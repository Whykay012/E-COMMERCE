/**
 * utils/eventMeshClient.js
 * ZENITH EVENT MESH - Traced, Locked, and Unified Metrics Edition
 */

const ProducerClient = require('./kafkaProducer'); 
const Logger = require('./logger'); 
const Outbox = require('./transactionalOutbox'); 
const PIIProcessor = require('./piiRedactionService'); 
const Tracing = require('./tracingClient'); 
const { v4: uuidv4 } = require('uuid');

// 🚀 UPGRADE: Import shared metrics from the Unified Hub
const { 
    eventmeshQueued, 
    eventmeshNetworkSuccess, 
    eventmeshNetworkFail 
} = require("../services/geoip/prometheus");

const TOPIC_PREFIX = process.env.EVENT_MESH_TOPIC_PREFIX || 'app_events';

const EventClient = {
    VERSION: '4.1.0-ZENITH', 

    /**
     * @desc The Unified Publisher function passed to the Outbox worker.
     */
    async _handleOutboxPublish(topic, event) {
        return Tracing.withSpan('EventMesh.networkPublish', async (span) => {
            try {
                if (topic.includes('MFA_CHALLENGE_DISPATCH')) {
                    const notificationService = require('../services/notificationService');
                    await notificationService.sendMfaCode(
                        event.userId || event.aggregateId, 
                        event.payload.code,
                        event.payload.mode
                    );
                } else {
                    await ProducerClient.sendBatch([event]);
                }

                // 🚀 UPGRADE: Increment shared success metric
                eventmeshNetworkSuccess.inc({ topic });
                span.setStatus({ code: Tracing.SpanStatusCode.OK });
            } catch (error) {
                // 🚀 UPGRADE: Increment shared failure metric
                eventmeshNetworkFail.inc({ topic });
                
                span.recordException(error);
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: error.message });
                throw error; 
            }
        });
    },

    /**
     * @desc Public API to publish events. 
     */
    async publish(payload, { session } = {}) {
        return Tracing.withSpan(`EventMesh.publish:${payload.eventType}`, async (span) => {
            try {
                const topic = `${TOPIC_PREFIX}:${payload.eventType.toLowerCase()}`;
                const structuredEvent = {
                    eventId: uuidv4(),
                    timestamp: new Date().toISOString(),
                    traceId: span.spanContext().traceId,
                    ...payload
                };

                span.setAttribute('event.type', payload.eventType);

                // 1. Redact PII
                structuredEvent.details = await Tracing.withSpan('PIIProcessor.redact', async () => {
                    return PIIProcessor.redact(structuredEvent.details);
                });
                
                // 2. Transactional Outbox Save
                await Outbox.save({ 
                    topic, 
                    event: structuredEvent, 
                    session 
                });
                
                // 🚀 UPGRADE: Increment shared queued metric
                eventmeshQueued.inc();
                
                return structuredEvent.eventId;

            } catch (error) {
                Logger.error('EVENTMESH_PUBLISH_ERROR', { error: error.message });
                span.recordException(error);
                throw error; 
            }
        });
    },

    initialize: async () => {
        if (ProducerClient.initialize) await ProducerClient.initialize();
        
        Outbox.startWorker(async (topic, event) => {
            await EventClient._handleOutboxPublish(topic, event);
        }, 5000); 
        
        Logger.info('EVENTMESH_CLIENT_INITIALIZED', { version: EventClient.VERSION });
    },

    shutdown: async () => {
        if (ProducerClient.shutdown) await ProducerClient.shutdown();
        Logger.info('EVENTMESH_CLIENT_SHUTDOWN');
    }
};

module.exports = EventClient;