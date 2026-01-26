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
    // 🔐 Compliance logic is owned by the Compliance Kernel
    "compliance.erasure_request": ComplianceErasureSchema,

    // 🔑 Identity logic is owned by the Identity Service
    "auth.password_rotation_relay": PasswordRotationSchema,

    // 💰 Payment & Orders
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

    // 📦 Catalog & Inventory
    "notify.low_stock": zod.object({
        productId: zod.string().nonempty(),
        stock: zod.number().int().min(0),
    }),

    "product.cleanup": zod.object({
        thresholdDays: zod.number().int().positive().optional().default(30),
    }),

    // 🛠️ Maintenance
    "payment.checkExpiry": zod.object({
        daysAhead: zod.number().int().positive().optional().default(30),
    })
};

/**
 * Validates job data against the registered schema map.
 * @param {string} jobName - The BullMQ job name
 * @param {object} data - The payload to validate
 * @returns {object} Validated and parsed data (with defaults applied)
 */
function validate(jobName, data) {
    const schema = Schemas[jobName];
    
    // If no schema is defined, pass data through (useful for prototyping)
    if (!schema) {
        return data; 
    }

    try {
        return schema.parse(data);
    } catch (error) {
        if (error instanceof zod.ZodError) {
            const validationErrors = error.errors
                .map(err => `${err.path.join('.')}: ${err.message}`)
                .join(', ');

            // Critical log: This indicates a producer is sending "poison pills"
            AuditLogger.log({ 
                level: 'CRITICAL', 
                event: 'JOB_DATA_INVALID', 
                details: { jobName, error: validationErrors, data } 
            });

            // Throwing with 'InvalidJobData' triggers the worker's permanent failure policy
            throw new Error(`InvalidJobData: ${validationErrors}`);
        }
        throw error;
    }
}

module.exports = { validate };