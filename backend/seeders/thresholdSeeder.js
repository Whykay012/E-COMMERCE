/**
 * utils/thresholdSeeder.js
 * ZENITH SECURITY - Persistent Threshold Seeder
 */
const ThresholdConfig = require('../model/ThresholdConfig');
const Logger = require('./logger');
const Tracing = require('./tracingClient');

const seedThresholds = async () => {
    // Wrap in a span so we can track startup performance
    return Tracing.withSpan('Database.SeedThresholds', async (span) => {
        try {
            const exists = await ThresholdConfig.findOne({ active: true });

            if (!exists) {
                const defaultThresholds = {
                    active: true,
                    // 💰 Payment Thresholds
                    highAmount: 100000,         // NGN Equivalent
                    
                    // 🌍 Identity & Geo Thresholds
                    highGeoRisk: 80,            // Score above 80 triggers MFA
                    
                    // 🚀 Velocity & Behavior
                    velocityLimit: 10,          // Max 10 attempts per hour
                    
                    // 🛡️ Mode Logic
                    absoluteMfaThreshold: 75,   // If Risk > 75, use Scrypt (ABSOLUTE)
                    
                    // 🛑 Fail-Safe Logic
                    failSafeAction: 'block',    // Options: 'block' or 'allow'
                    
                    version: "2.0.0-ZENITH"
                };

                await ThresholdConfig.create(defaultThresholds);
                
                Logger.info("SECURITY_SEED_SUCCESS", { 
                    message: "Initial security thresholds injected into MongoDB",
                    thresholds: defaultThresholds 
                });
            } else {
                Logger.info("SECURITY_SEED_SKIPPED", { 
                    message: "Active security thresholds already exist in database." 
                });
            }
        } catch (error) {
            Logger.error("SECURITY_SEED_CRITICAL_FAILURE", { 
                error: error.message,
                stack: error.stack 
            });
            // We don't throw here to prevent the whole app from crashing, 
            // the Risk Engine will use its hardcoded defaults as a backup.
        }
    });
};

module.exports = { seedThresholds };