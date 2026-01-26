// utils/metricsClient.js (DISTRIBUTED TELEMETRY CLIENT: Contextual Tagging & Non-Blocking)

// --- Core Dependencies ---
const StatsDClient = require('statsd-client'); 
const Logger = require('./logger'); // <-- Uses ULTIMATE PINO LOGGER

// --- Configuration ---
const SERVICE_NAME_TAG = `service:${process.env.SERVICE_NAME || 'rec-gateway'}`;
const ENV_TAG = `env:${process.env.NODE_ENV || 'development'}`;
const BASE_TAGS = [SERVICE_NAME_TAG, ENV_TAG];

// --- Metrics Instance ---
let client = null; 

// =================================================================================
// 🛡️ METRICS EMISSION & ABSTRACTION
// =================================================================================

/**
 * @desc Applies base tags and any contextual tags to a metric key.
 */
const formatTags = (key, contextTags = {}) => {
    const contextualTags = Object.entries(contextTags).map(([k, v]) => `${k}:${v}`);
    return [...BASE_TAGS, ...contextualTags];
};

/**
 * @desc Wraps the actual metric call with non-blocking error suppression.
 */
const emitMetric = (fn, key, value, tags = {}) => {
    if (client) {
        try {
            const formattedTags = formatTags(key, tags);
            fn.call(client, key, value, formattedTags);
        } catch (e) {
             // Metrics failure is designed to be suppressed to protect the main application path.
             // We can optionally use the Logger here for critical issues:
             Logger.warn('STATSD_EMIT_FAIL', { err: e, key }); 
        }
    }
};

// =================================================================================
// 💡 MODULE EXPORTS: Semantic Metric Functions
// =================================================================================

module.exports = {
    // Standard Metrics
    increment: (key, value = 1, tags) => emitMetric(client.increment, key, value, tags),
    gauge: (key, value, tags) => emitMetric(client.gauge, key, value, tags),
    timing: (key, ms, tags) => emitMetric(client.timing, key, ms, tags),

    // Semantic Domain Metrics 
    security: (key, tags) => emitMetric(client.increment, `security.event.${key}`, 1, tags),
    cacheHit: (key, tags) => emitMetric(client.increment, `cache.hit.${key}`, 1, tags),
    cacheMiss: (key, tags) => emitMetric(client.increment, `cache.miss.${key}`, 1, tags),
    
    // Lifecycle Management
    initialize: () => {
        client = new StatsDClient({
            host: process.env.STATSD_HOST || 'localhost',
            port: process.env.STATSD_PORT || 8125,
            prefix: 'app.',
            socketTimeout: 50 
        });
        Logger.info('METRICS_CLIENT_INITIALIZED', { host: process.env.STATSD_HOST });
    },
    shutdown: () => {
        if (client) {
            client.close(); 
            Logger.info('METRICS_CLIENT_SHUTDOWN');
        }
    }
};