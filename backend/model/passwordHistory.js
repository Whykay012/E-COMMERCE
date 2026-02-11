"use strict";

const mongoose = require('mongoose'); // <--- THIS WAS MISSING

/**
 * COSMOS HYPER-FABRIC: Password History Model
 * ------------------------------------------
 * Stores previous password hashes to prevent re-use of old credentials.
 */
const PasswordHistorySchema = new mongoose.Schema({
    user: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true, 
        index: true 
    },
    passwordHash: { 
        type: String, 
        required: true 
    },
    createdAt: { 
        type: Date, 
        default: Date.now, 
        expires: '365d' // Automatically cleanup entries older than 1 year
    }
});

// Create a compound index for faster lookup during password change checks
PasswordHistorySchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('PasswordHistory', PasswordHistorySchema);