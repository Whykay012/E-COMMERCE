/**
 * services/notificationService.js
 * ZENITH OMEGA - AUTONOMOUS RESILIENCE ENGINE (v5.0)
 * Fully Integrated: Titan Nexus Kafka, Advanced Single-Flight Cache, Sliding Window Breakers
 */
const Logger = require('../utils/logger'); // ULTIMATE PINO LOGGER
const Metrics = require('../utils/metricsClient'); // STATSD CLIENT
const Tracing = require('../utils/tracingClient'); // OTel CLIENT
const cache = require("./redisCacheUtil"); // ADVANCED CACHE UTIL (With Lock/SWR)
const BreakerRegistry = require('./breakerRegistry'); // Registry for the new CircuitBreaker class
const broker = require('./messageBrokerClient'); // KAFKA PRODUCER
const crypto = require('crypto');

const NotificationService = {
    // Adaptive health map for provider ranking
    _healthMap: { 'twilio': 100, 'aws-sns': 100, 'sendgrid': 100, 'postmark': 100 },

    // =================================================================================
    // 🛡️ DISPATCH ENGINE
    // =================================================================================

    async processAndDispatch(event) {
        return Tracing.withSpan('NotificationService.processAndDispatch', async (span) => {
            const { userID, type, payload, priority = 'NORMAL', identifier } = event;

            span.setAttributes({ 
                'notification.type': type, 
                'notification.priority': priority,
                'user.id': userID 
            });

            // 1. SECURITY: Enforce Logger Contract for Ultra Events
            if (priority === 'ULTRA') {
                Logger.security('ULTRA_PRIORITY_NOTIFICATION_INITIATED', { 
                    userId: userID, 
                    eventCode: 'NOTIF_DISPATCH_HIGH_SEC',
                    type 
                });
            }

            // 2. RESILIENCE: Smart Deduplication (Using the improved Cache client)
            const isDuplicate = await this._isDuplicate(userID, type, payload);
            if (isDuplicate) {
                Metrics.increment('notif.deduped');
                return { status: 'DE-DUPED' };
            }

            // 3. PROTECTION: Anti-Fraud Velocity Check
            if (priority === 'ULTRA') {
                const velocityKey = `velocity:notif:${identifier}`;
                const velocity = await cache.client.incr(velocityKey);
                if (velocity === 1) await cache.client.expire(velocityKey, 300);
                
                if (velocity > 3) {
                    Logger.error('VELOCITY_LIMIT_EXCEEDED', { identifier, velocity });
                    throw new Error("FRAUD_LIMIT_REACHED");
                }
            }

            // 4. PERSISTENCE: Create record & trigger Cache Invalidation via Kafka
            const internalNotif = await this._persistInternal(userID, type, payload, priority);
            
            // TITAN NEXUS UPGRADE: Use Kafka sendMessage for high-durability cache invalidation
            await broker.sendMessage('cache-invalidation-topic', { 
                action: 'PURGE_USER', 
                userId: userID,
                timestamp: new Date().toISOString()
            });

            // 5. ADAPTIVE EXECUTION: Failover logic using Sliding Window Circuit Breakers
            let dispatchResult = { status: 'QUEUED_INTERNALLY' };
            if (priority === 'ULTRA' || priority === 'HIGH') {
                const channel = type === 'EMAIL' ? 'EMAIL' : 'SMS';
                dispatchResult = await this._adaptiveExecute(channel, identifier, payload);
            }

            // 6. AUDIT: Final Log Trail
            Logger.audit('NOTIFICATION_DISPATCH_FINALIZED', { 
                entityId: internalNotif._id, 
                action: 'DISPATCH_SUCCESS',
                provider: dispatchResult.provider || 'none'
            });

            return { status: 'PROCESSED', internalId: internalNotif._id, ...dispatchResult };
        });
    },

    /**
     * @private
     * Implements Adaptive Fan-out with Circuit Breaker Failover
     */
    async _adaptiveExecute(channel, to, payload) {
        const stack = channel === 'SMS' ? ['twilio', 'aws-sns'] : ['sendgrid', 'postmark'];
        
        // Rank providers by real-time health score
        const sorted = stack.sort((a, b) => this._healthMap[b] - this._healthMap[a]);

        for (const providerId of sorted) {
            const breaker = BreakerRegistry.get(providerId);

            try {
                // TITAN NEXUS UPGRADE: Using .execute() from the new Sliding Window Breaker
                return await breaker.execute(async () => {
                    const start = Date.now();
                    
                    // --- MOCK EXTERNAL API CALL ---
                    // In production: await axios.post(provider_url, payload);
                    const res = { id: `ext_${crypto.randomBytes(4).toString('hex')}` }; 
                    // ------------------------------

                    const latency = Date.now() - start;
                    this._updateHealth(providerId, true, latency);
                    
                    Metrics.timing(`provider.${providerId}.latency`, latency);
                    Metrics.increment(`provider.${providerId}.success`);
                    
                    return { provider: providerId, messageId: res.id, status: 'DELIVERED' };
                });
            } catch (err) {
                // handleFailure is managed inside the breaker, but we update our local HealthMap
                this._updateHealth(providerId, false);
                
                if (err.name === 'ServiceUnavailableError') {
                    Logger.warn(`BREAKER_OPEN: ${providerId} skipped.`);
                } else {
                    Logger.error(`PROVIDER_ERROR: ${providerId}`, { error: err.message });
                }
                // Continue loop to next provider in the stack
            }
        }
        throw new Error("ALL_PROVIDERS_UNAVAILABLE_OR_TRIPPED");
    },

    // =================================================================================
    // 🚀 INBOX OPERATIONS (READ-THROUGH CACHE)
    // =================================================================================

    async getUserNotifications(userID, query) {
        const cacheKey = `notifs:u:${userID}:c:${query.cursor || 'start'}:l:${query.limit}`;
        
        // TITAN NEXUS UPGRADE: Using advanced 'cached' method with lock/stampede protection
        return await cache.cached(
            cacheKey,
            300, // 5 min Fresh TTL
            async () => {
                Metrics.cacheMiss('notifications_inbox');
                // Simulate Database Fetch
                return { 
                    notifications: [], 
                    nextCursor: null, 
                    unreadCount: 0,
                    fetchedAt: new Date().toISOString() 
                };
            },
            3600 // 1 hour Stale TTL (SWR Support)
        );
    },

    async markAsRead(userID, id) {
        Logger.info('MARKING_NOTIFICATION_READ', { userID, notificationId: id });
        
        // Simulating DB Update
        const success = true; 
        if (success) {
            // Transactional Kafka send to ensure inbox sync across clusters
            await broker.sendTransactionalMessages('inbox-updates', [{
                userId: userID,
                notifId: id,
                status: 'READ'
            }], `tx-${id}`);

            Metrics.increment('notif.action.read');
        }
        return success;
    },

    // =================================================================================
    // 🛠️ INTERNAL UTILITIES
    // =================================================================================

    _updateHealth(id, success, latency = 0) {
        const current = this._healthMap[id] || 100;
        if (!success) {
            this._healthMap[id] = Math.max(0, current - 25);
        } else {
            // Penalty for slow but successful responses (P99 protection)
            const penalty = latency > 2500 ? 15 : 0;
            this._healthMap[id] = Math.min(100, current + 5 - penalty);
        }
        Metrics.gauge(`provider.health_score.${id}`, this._healthMap[id]);
    },

    async _isDuplicate(uID, type, payload) {
        const hash = crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
        const key = `notif_dedup:${uID}:${type}:${hash}`;
        
        // Use the base redis client for atomic NX (Not eXists) lock
        const existing = await cache.client.set(key, '1', 'NX', 'EX', 300);
        return !existing; // If set returns null, it means it already existed
    },

    async _persistInternal(userID, type, payload, priority) {
        // Implementation of DB persistence logic
        return { _id: 'notif_int_' + crypto.randomBytes(6).toString('hex') };
    }
};

module.exports = NotificationService;