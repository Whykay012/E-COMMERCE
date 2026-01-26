/*
 * scripts/verifyErasure.js
 * ------------------------------------------------------------------
 * Compliance Audit Tool: Verifies zero-trace erasure
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const mongoose = require('mongoose');
const logger = require("../config/logger");
const { PII_DATA_MAP } = require('../services/complianceKernel');
const connectDB = require("../config/connect");

async function verifyUserErasure(userId) {
    try {
        await connectDB(process.env.MONGO_URI);
        logger.info(`🔍 STARTING_ERASURE_VERIFICATION: ${userId}`);

        const auditResults = {};

        for (const [key, config] of Object.entries(PII_DATA_MAP)) {
            const Model = mongoose.model(config.model);
            
            // Search for ANY record matching this user
            const queryValue = config.queryField === '_id' 
                ? new mongoose.Types.ObjectId(userId) 
                : userId;

            const records = await Model.find({ [config.queryField]: queryValue }).lean();

            if (records.length === 0) {
                auditResults[key] = "CLEAN (No records found)";
                continue;
            }

            const violations = [];
            records.forEach((doc, index) => {
                // Check if isDeleted flag is set
                if (!doc.isDeleted) {
                    violations.push(`Record[${index}]: Missing isDeleted flag`);
                }

                // Check specific PII fields
                Object.keys(config.fieldsToErase).forEach(field => {
                    const value = doc[field];
                    // If value still looks like PII (not null, not "ERASED", not hashed)
                    if (value !== null && value !== 'ERASED' && value !== 'PII_ERASED' && !String(value).includes('erased-')) {
                        violations.push(`Record[${index}] Field [${field}]: Still contains data -> ${value}`);
                    }
                });
            });

            auditResults[key] = violations.length > 0 ? { status: "FAIL", violations } : "SUCCESS (Fully Scrubbed)";
        }

        console.table(auditResults);

        const hasFailures = Object.values(auditResults).some(v => v.status === "FAIL");
        if (hasFailures) {
            logger.error("❌ VERIFICATION_FAILED: Residual PII detected.");
        } else {
            logger.info("✅ VERIFICATION_SUCCESS: User is a ghost in the machine.");
        }

    } catch (err) {
        logger.error("Verification script crashed:", err);
    } finally {
        await mongoose.disconnect();
    }
}

// Usage: node scripts/verifyErasure.js <userId>
const targetId = process.argv[2];
if (!targetId) {
    console.log("Please provide a userId: node verifyErasure.js 64af...");
    process.exit(1);
}

verifyUserErasure(targetId);