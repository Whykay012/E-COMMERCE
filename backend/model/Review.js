const mongoose = require("mongoose");
const Product = require("./Product");

const ReviewSchema = new mongoose.Schema(
    {
        // -------------------------------------------------
        // CORE RELATIONSHIPS
        // -------------------------------------------------
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
            index: true
        },

        // -------------------------------------------------
        // REVIEW CONTENT
        // -------------------------------------------------
        rating: {
            type: Number,
            required: true,
            min: 1,
            max: 5
        },

        title: {
            type: String,
            trim: true,
            maxlength: 100,
            required: [true, "Review must have a title"]
        },

        text: {
            type: String,
            trim: true,
            maxlength: 1000,
            required: [true, "Review text is required"]
        },

        // -------------------------------------------------
        // PURCHASE VERIFICATION
        // -------------------------------------------------
        isVerifiedPurchase: {
            type: Boolean,
            default: false
        },

        // -------------------------------------------------
        // HELPFUL VOTES
        // -------------------------------------------------
        helpful: {
            up: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
            down: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
        },

        // -------------------------------------------------
        // MODERATION SYSTEM
        // -------------------------------------------------
        status: {
            type: String,
            enum: ["pending", "published", "hidden", "flagged"],
            default: "pending",
            index: true
        },

        flaggedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

        adminNotes: {
            type: String,
            trim: true,
            default: ""
        }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

// -------------------------------------------------
// INDEXES
// -------------------------------------------------
ReviewSchema.index({ product: 1, user: 1 }, { unique: true });   // One review per product
ReviewSchema.index({ product: 1, createdAt: -1 });                // Fast review fetch

// -------------------------------------------------
// AGGREGATION: UPDATE PRODUCT RATING
// -------------------------------------------------
ReviewSchema.statics.calculateAverageRating = async function (productId) {
    const stats = await this.aggregate([
        {
            $match: { product: productId, status: "published" }
        },
        {
            $group: {
                _id: "$product",
                reviewsCount: { $sum: 1 },
                avgRating: { $avg: "$rating" }
            }
        }
    ]);

    if (stats.length > 0) {
        await Product.findByIdAndUpdate(productId, {
            reviewsCount: stats[0].reviewsCount,
            ratingsAverage: Math.round(stats[0].avgRating * 10) / 10,
            rating: Math.round(stats[0].avgRating * 100) / 100
        });
    } else {
        await Product.findByIdAndUpdate(productId, {
            reviewsCount: 0,
            ratingsAverage: 0,
            rating: 0
        });
    }
};

// -------------------------------------------------
// MONGOOSE HOOKS
// -------------------------------------------------

// Trigger aggregation after save
ReviewSchema.post("save", async function () {
    await this.constructor.calculateAverageRating(this.product);
});

// Store review before update/delete
ReviewSchema.pre(/^findOneAnd/, async function (next) {
    this._oldReview = await this.findOne();
    next();
});

// Trigger rating recalculation after update/delete
ReviewSchema.post(/^findOneAnd/, async function () {
    if (this._oldReview) {
        await this._oldReview.constructor.calculateAverageRating(this._oldReview.product);
    }
});

// Auto-populate user info
ReviewSchema.pre(/^find/, function (next) {
    this.populate({
        path: "user",
        select: "name photo"
    });
    next();
});

module.exports = mongoose.model("Review", ReviewSchema);
