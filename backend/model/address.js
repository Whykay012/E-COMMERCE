// address.model.js

const mongoose = require("mongoose");

const AddressSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true, // Crucial for scoping by user
        },
        fullName: { type: String, required: true, trim: true },
        phone: { type: String, required: true, trim: true },
        addressLine1: { type: String, required: true, trim: true },
        addressLine2: { type: String, trim: true, default: "" },
        city: { type: String, required: true, trim: true },
        state: { type: String, required: true, trim: true },
        country: { type: String, required: true, trim: true, default: "United States" },
        postalCode: { type: String, trim: true, default: "" },
        isDefault: { type: Boolean, default: false, index: true }, // Index for finding defaults
    },
    { timestamps: true }
);

// Compound index for quick lookup of the default address for a user
AddressSchema.index({ user: 1, isDefault: -1 });

module.exports = mongoose.model("Address", AddressSchema);