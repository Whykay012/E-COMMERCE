const mongoose = require('mongoose');

// Schema for tracking every change made to product stock
const InventoryAuditSchema = new mongoose.Schema({
    product: {
        type: mongoose.Schema.ObjectId,
        ref: 'Product',
        required: true,
    },
    sku: {
        type: String,
        required: true,
    },
    // The action performed: 'set', 'add', 'subtract', 'order_fulfillment', 'manual_adjustment', 'return'
    action: {
        type: String,
        required: true,
        enum: ['set', 'add', 'subtract', 'order_fulfillment', 'manual_adjustment', 'return'],
    },
    // The quantity by which the stock was changed (positive for add/negative for subtract)
    quantityChange: {
        type: Number,
        required: true,
    },
    // The stock level BEFORE the change
    stockBefore: {
        type: Number,
        required: true,
    },
    // The stock level AFTER the change
    stockAfter: {
        type: Number,
        required: true,
    },
    // Who made the change (essential for admin operations)
    adminUser: {
        type: mongoose.Schema.ObjectId,
        ref: 'User', // Assuming a User model exists
    },
    // Optional explanation for manual changes
    reason: {
        type: String,
        trim: true,
    },
    // Optional reference to a related document (e.g., order ID)
    referenceId: {
        type: String,
        trim: true,
    }
}, { timestamps: true });

module.exports = mongoose.model('InventoryAudit', InventoryAuditSchema);