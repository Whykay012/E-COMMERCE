/**
 * services/complianceStats.js
 * ------------------------------------------------------------------
 * OMEGA Monitoring: Real-time Compliance & Reliability Analytics
 * ------------------------------------------------------------------
 */

const ComplianceOutbox = require('../services/complianceOutbox');
const Outbox = require('../models/Outbox'); // 🛡️ Import the main Security Outbox
const logger = require("../config/logger");

/**
 * 1. COMPLIANCE HEALTH (GDPR/ERASURE)
 */
const getErasureHealthReport = async () => {
    try {
        const stats = await ComplianceOutbox.aggregate([
            {
                $facet: {
                    "statusCounts": [
                        { $group: { _id: "$status", count: { $sum: 1 } } }
                    ],
                    "atRiskJobs": [
                        { $match: { status: "FAILED" } },
                        { $project: { subjectId: 1, processingLog: 1, updatedAt: 1 } },
                        { $limit: 5 }
                    ],
                    "avgProcessingTime": [
                        { $match: { status: "COMPLETED" } },
                        { 
                            $project: { 
                                duration: { $subtract: ["$processedAt", "$createdAt"] } 
                            } 
                        },
                        { $group: { _id: null, avgMs: { $avg: "$duration" } } }
                    ]
                }
            }
        ]);

        return {
            timestamp: new Date(),
            summary: stats[0].statusCounts,
            health: stats[0].avgProcessingTime[0]?.avgMs ? 
                `${(stats[0].avgProcessingTime[0].avgMs / 1000).toFixed(2)}s average erasure time` : 
                "No data",
            criticalFailures: stats[0].atRiskJobs
        };
    } catch (err) {
        logger.error("COMPLIANCE_STATS_FAILURE", err);
        throw err;
    }
};

/**
 * 2. SECURITY & AUTH RELIABILITY (MFA, Password Resets, Logouts)
 * 🛡️ Monitors the health of your transactional outbox pipeline
 */
const getSecurityOutboxReport = async () => {
    try {
        const stats = await Outbox.aggregate([
            {
                $facet: {
                    // Breakdown by Event Type (How many MFA vs Resets)
                    "eventBreakdown": [
                        { $group: { _id: "$eventType", count: { $sum: 1 } } }
                    ],
                    // Find PENDING items that are stuck (stale)
                    "pendingStale": [
                        { 
                            $match: { 
                                status: "PENDING", 
                                createdAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } 
                            } 
                        },
                        { $count: "staleCount" }
                    ],
                    // Current Status (PENDING, COMPLETED, FAILED)
                    "statusCounts": [
                        { $group: { _id: "$status", count: { $sum: 1 } } }
                    ]
                }
            }
        ]);

        return {
            timestamp: new Date(),
            summary: stats[0].statusCounts,
            events: stats[0].eventBreakdown,
            stalePendingCount: stats[0].pendingStale[0]?.staleCount || 0
        };
    } catch (err) {
        logger.error("SECURITY_STATS_FAILURE", err);
        throw err;
    }
};

module.exports = { 
    getErasureHealthReport,
    getSecurityOutboxReport // 🚀 Export the new monitoring function
};