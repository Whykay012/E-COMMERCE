/*
 * services/complianceKernel.js
 * ------------------------------------------------------------------
 * OMEGA Compliance Engine - GDPR/CCPA Transactional Erasure
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const zod = require('zod');
const logger = require("../config/logger");
const AuditLogger = require("../services/auditLogger");
const ComplianceOutbox = require('../services/complianceOutbox');

// --- Explicit Model Imports (Ensures registration in Mongoose) ---
const Outbox = require('../models/Outbox'); 
// Import other models here if they aren't initialized elsewhere in your app boot
require('../model/userModel'); 
require('../model/notificationModel');

// =================================================================================
// 📜 SCHEMA DEFINITION
// =================================================================================
const ComplianceErasureSchema = zod.object({
    subjectId: zod.string().nonempty(),
    complianceOutboxId: zod.string().nonempty(),
}).passthrough();

// =================================================================================
// 🗺️ PII_DATA_MAP (Source of Truth for Personal Data)
// =================================================================================
const PII_DATA_MAP = {
    User: {
        model: 'User', 
        queryField: '_id',
        fieldsToErase: {
            email: (userId) => `erased-${userId}@erased.com`,
            firstName: 'ERASED', 
            lastName: 'ERASED', 
            phone: null, 
            address: 'ERASED',
            state: 'ERASED', 
            country: 'ERASED', 
            lastIp: null, 
            lastUserAgent: null,
        },
    },
    Profile: {
        model: 'Profile', 
        queryField: 'userId',
        fieldsToErase: { bio: 'ERASED', phoneNumber: null }
    },
    Address: {
        model: 'Address', 
        queryField: 'userId',
        fieldsToErase: { streetAddress: 'ERASED', city: 'ERASED', postalCode: 'ERASED', recipientName: 'ERASED' }
    },
    Notification: {
        model: 'Notification', 
        queryField: 'recipientId',
        fieldsToErase: { 
            messageContent: 'PII_ERASED', 
            senderEmail: null, 
            metadata: null, 
            isArchived: true 
        }
    },
    // ZENITH OUTBOX SCRUBBING:
    // Cleans the Log-Based Orchestration layer of sensitive payloads
    Outbox: {
        model: 'Outbox',
        queryField: 'aggregateId',
        fieldsToErase: {
            payload: { message: "DATA_ERASED_FOR_COMPLIANCE_PURPOSES" },
            traceId: 'ERASED',
            'performance.workerHost': 'ERASED'
        }
    }
};

// =================================================================================
// 🏗️ EXECUTION LOGIC
// =================================================================================
const executeErasure = async (userId, complianceOutboxId, job) => {
    const validated = ComplianceErasureSchema.parse({ subjectId: userId, complianceOutboxId });

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        logger.info('ERASURE_TRANSACTION_START', { userId: validated.subjectId });

        for (const [collectionName, config] of Object.entries(PII_DATA_MAP)) {
            // Using mongoose.model(name) is safer than mongoose.models[name] 
            // once we know the file has been required.
            const Model = mongoose.model(config.model); 
            
            if (!Model) {
                logger.warn(`Model ${config.model} not found. Skipping.`);
                continue;
            }

            const updateSet = {};
            for (const [field, valueFnOrVal] of Object.entries(config.fieldsToErase)) {
                updateSet[field] = (typeof valueFnOrVal === 'function') 
                    ? valueFnOrVal(validated.subjectId) 
                    : valueFnOrVal;
            }
            
            updateSet['isDeleted'] = true;
            updateSet['erasedAt'] = new Date();

            const queryValue = config.queryField === '_id' 
                ? new mongoose.Types.ObjectId(validated.subjectId) 
                : validated.subjectId;

            const result = await Model.updateMany(
                { [config.queryField]: queryValue }, 
                { $set: updateSet }, 
                { session }
            );

            logger.info(`ERASURE_SYNC: ${config.model} scrubbed.`, { count: result.modifiedCount });
        }

        // 2. MARK COMPLIANCE PROGRESS
        await ComplianceOutbox.updateOne(
            { _id: validated.complianceOutboxId }, 
            { $set: { status: 'COMPLETED', processedAt: new Date() } }, 
            { session }
        );

        await session.commitTransaction();
        
        AuditLogger.log({ 
            level: 'INFO',
            event: 'COMPLIANCE_ERASURE_SUCCESS', 
            userId: validated.subjectId 
        });

        return { success: true };

    } catch (error) {
        if (session.inTransaction()) {
            await session.abortTransaction();
        }
        
        await ComplianceOutbox.updateOne(
            { _id: complianceOutboxId }, 
            { 
                $push: { 
                    processingLog: { 
                        message: error.message, 
                        attempt: (job?.attemptsMade || 0) + 1,
                        timestamp: new Date()
                    } 
                },
                $set: { status: 'FAILED' }
            }
        ).catch(err => logger.error('OUTBOX_FATAL_UPDATE_FAILURE', err));

        throw error; 
    } finally {
        session.endSession();
    }
};

module.exports = { 
    executeErasure, 
    ComplianceErasureSchema,
    PII_DATA_MAP 
};