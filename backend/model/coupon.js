const mongoose = require("mongoose");

const CouponSchema = new mongoose.Schema({
    // The unique code users enter (e.g., 'SUMMER20')
    code: {
        type: String,
        required: [true, "Coupon code is required."],
        unique: true,
        uppercase: true,
    },
    // The discount amount or percentage
    discountValue: {
        type: Number,
        required: [true, "Discount value is required."],
        min: 0,
    },
    // Type of discount: 'percentage' (e.g., 20) or 'fixed' (e.g., 10.00)
    discountType: {
        type: String,
        enum: ["percentage", "fixed"],
        default: "percentage",
    },
    // Minimum cart subtotal required to use the coupon
    minSpend: {
        type: Number,
        default: 0,
        min: 0,
    },
    // Maximum number of times this coupon can ever be used across all users
    maxUsage: {
        type: Number,
        default: -1, // -1 means unlimited usage
    },
    // Current number of times the coupon has been successfully used (auditable)
    currentUsage: {
        type: Number,
        default: 0,
        min: 0,
    },
    // The date and time when the coupon is no longer valid
    expiresAt: {
        type: Date,
        required: [true, "Expiry date is required."],
    },
    // Flag to determine if the discount applies to the shipping fee as well
    appliesToShipping: {
        type: Boolean,
        default: false,
    },
    // Status flag for easy deactivation/archiving
    isActive: {
        type: Boolean,
        default: true,
    }
}, { timestamps: true });

CouponSchema.index({ code: 1 }, { unique: true });

module.exports = mongoose.model("Coupon", CouponSchema);