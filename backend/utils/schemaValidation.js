/*
 * utils/schemaValidator.js
 * ------------------------------------------------------------------
 * Central Validation Registry for Worker Jobs
 * ------------------------------------------------------------------
 */

const zod = require('zod');
const AuditLogger = require("../services/auditLogger");

// --- Import Schemas from Source of Truth Services ---
const { ComplianceErasureSchema } = require("../services/complianceKernel");
const { PasswordRotationSchema } = require("../services/identityService");

const Schemas = {
    // 🔐 COMPLIANCE & IDENTITY (Service Owned)
    "compliance.erasure_request": ComplianceErasureSchema,
    "auth.password_rotation_relay": PasswordRotationSchema,

    // 🚨 OUTBOX RELAYS (Exactly-Once Logic)
    // Used for auth.email_relay, auth.mfa_relay, auth.mfa_cleanup
    "auth.email_relay": zod.object({
        eventId: zod.string().nonempty(),
    }).passthrough(),

    "auth.mfa_relay": zod.object({
        eventId: zod.string().nonempty(),
    }).passthrough(),

    "auth.mfa_cleanup": zod.object({
        eventId: zod.string().nonempty(),
    }).passthrough(),

    // 🛡️ SECURITY & CACHE
    "auth.security_logout_relay": zod.object({
        userId: zod.string().nonempty(),
        sessionId: zod.string().optional(),
        reason: zod.string().optional(),
        tracingContext: zod.record(zod.string()).optional(),
    }),

    "cache.invalidate_user": zod.object({
        userId: zod.string().nonempty(),
    }),

    // 💰 PAYMENT & ORDERS
    "payment.atomic_order_update": zod.object({
        orderId: zod.string().nonempty(),
        reference: zod.string().nonempty(),
        provider: zod.string().nonempty(),
        amount: zod.number().positive(),
        webhookLogId: zod.string().nonempty(),
        requestTraceId: zod.string().uuid().optional(),
    }).passthrough(),

    "order.process": zod.object({
        orderId: zod.string().nonempty(),
    }).passthrough(),

    // 📦 CATALOG & INVENTORY
    "notify.low_stock": zod.object({
        productId: zod.string().nonempty(),
        stock: zod.number().int().min(0),
    }),
"infra.update_geoip_db": z.object({
        timestamp: z.number().optional()
    }),
    "product.cleanup": zod.object({
        thresholdDays: zod.number().int().positive().optional().default(30),
    }),

    "product.media.delete": zod.object({
        images: zod.array(zod.string()).optional(),
        video: zod.string().optional(),
    }),

    // 🛠️ MAINTENANCE
    "checkExpiryJob": zod.object({
        daysAhead: zod.number().int().positive().optional().default(30),
    }),
    "payment.checkExpiry": zod.object({
        daysAhead: zod.number().int().positive().optional().default(30),
    })
};

/**
 * Validates job data against the registered schema map.
 * @param {string} jobName - The BullMQ/Kafka job name
 * @param {object} data - The payload to validate
 * @returns {object} Validated and parsed data (with defaults applied)
 */
function validate(jobName, data) {
    const schema = Schemas[jobName];
    
    // If no schema is defined, log warning but pass through for flexibility
    if (!schema) {
        console.warn(`⚠️ [Validator] No schema defined for job: ${jobName}`);
        return data; 
    }

    try {
        // .parse() strips unknown keys (unless .passthrough() is used) 
        // and injects .default() values
        return schema.parse(data);
    } catch (error) {
        if (error instanceof zod.ZodError) {
            const validationErrors = error.errors
                .map(err => `${err.path.join('.')}: ${err.message}`)
                .join(', ');

            // This is a CRITICAL log because it prevents the worker from starting a doomed task
            AuditLogger.log({ 
                level: 'CRITICAL', 
                event: 'JOB_DATA_INVALID', 
                details: { jobName, error: validationErrors, rawData: data } 
            });

            // "InvalidJobData" string is caught by routerProcessor to prevent retries
            throw new Error(`InvalidJobData: ${validationErrors}`);
        }
        throw error;
    }
}

module.exports = { validate };