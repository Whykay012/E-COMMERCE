/**
 * models/ThresholdConfig.js
 * Dynamic Risk & Security Configuration Schema
 */

const mongoose = require('mongoose');

const ThresholdConfigSchema = new mongoose.Schema({
    // 💡 Active flag: The engine always looks for the "active" config
    active: {
        type: Boolean,
        default: true,
        index: true
    },
    
    // 💰 Payment Thresholds (used in evaluatePaymentRisk)
    highAmount: {
        type: Number,
        default: 500, // Trigger high-amount signal
        required: true
    },
    
    // 🗺️ Geographic Risk (0-100)
    highGeoRisk: {
        type: Number,
        default: 70, // Trigger high-risk geo signal
        min: 0,
        max: 100
    },
    
    // ⚡ Velocity Limits (Actions per hour)
    velocityLimit: {
        type: Number,
        default: 5,
        required: true
    },
    
    // 🛡️ Policy Thresholds for MFA
    absoluteMfaThreshold: {
        type: Number,
        default: 75, // Scores above this force ABSOLUTE (Scrypt) mode
        min: 0,
        max: 100
    },

    // 🚨 Fail-Safe Strategy
    // Options: 'block', 'challenge_otp', 'allow'
    failSafeAction: {
        type: String,
        default: 'block',
        enum: ['block', 'challenge_otp', 'allow']
    },

    version: {
        type: String,
        default: "1.0.0"
    },

    updatedBy: {
        type: String, // Trace who changed the security policy
        default: "SYSTEM"
    }
}, { 
    timestamps: true,
    collection: 'threshold_configs'
});

// ⚡ Ensure only one config is active at a time
ThresholdConfigSchema.pre('save', async function(next) {
    if (this.active) {
        await this.constructor.updateMany(
            { _id: { $ne: this._id } }, 
            { $set: { active: false } }
        );
    }
    next();
});

module.exports = mongoose.model('ThresholdConfig', ThresholdConfigSchema);