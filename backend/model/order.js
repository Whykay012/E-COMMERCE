const mongoose = require("mongoose");

// Sub-schema for each product in an order
const orderItemSchema = new mongoose.Schema(
    {
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
        },
        name: String,
        quantity: { type: Number, min: 1, required: true },
        price: { type: Number, min: 0, required: true }, // capture price at purchase
        image: String,
        selectedColor: String,
        selectedSize: String,
        discount: { type: Number, default: 0 },
    },
    { _id: false }
);

const orderSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        items: [orderItemSchema],
        totalAmount: { type: Number, required: true },

        // NEW FIELD: Tracks which referral code, if any, was used for this order.
        // This is the essential link back to the Referral document for commission calculation.
        referralCodeUsed: {
            type: String,
            default: null,
            index: true,
            comment: "The code used to place this order, for attribution and commission calculation.",
        },
        
        // Payment & order status
        paymentStatus: {
            type: String,
            enum: ["pending", "paid", "failed"],
            default: "pending",
        },
        orderStatus: {
            type: String,
            enum: ["pending", "processing", "shipped", "delivered", "cancelled", "refunded"],
            default: "pending",
        },

        // Order history & events
        history: [
            {
                status: String,
                progress: Number,
                message: String,
                timestamp: { type: Date, default: Date.now },
            },
        ],
        timeline: { type: Array, default: [] },
        events: { type: Array, default: [] },

        // Shipping & tracking
        trackingUrl: String,
        courier: String,
        estimatedDelivery: Date,
        shippingAddress: { type: mongoose.Schema.Types.ObjectId, ref: "Address" },

        // Payment/order reference
        reference: { type: String, unique: true, required: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);