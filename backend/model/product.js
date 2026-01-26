const mongoose = require("mongoose");

// ----------------------
// MEDIA SUB-SCHEMAS
// ----------------------

// Image schema (Cloudinary)
const imageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    public_id: { type: String, required: true },
  },
  { _id: false }
);

// Video schema (Cloudinary)
const videoSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    public_id: { type: String, required: true },
    resource_type: { type: String, default: "video" },
  },
  { _id: false }
);

// ----------------------
// MAIN PRODUCT SCHEMA
// ----------------------

const ProductSchema = new mongoose.Schema(
  {
    // --- Core Information ---
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
      maxlength: [200, "Name too long"],
      minlength: [2, "Name too short"],
      unique: true,
      index: true,
    },

    slug: { type: String, unique: true }, // SEO URL

    description: {
      type: String,
      required: [true, "Product description is required"],
      minlength: [10, "Description must be at least 10 characters"],
    },

    // --- Pricing ---
    price: {
      type: Number,
      required: [true, "Product price is required"],
      min: [0, "Price cannot be negative"],
    },

    discount: {
      type: Number,
      default: 0,
      min: [0, "Discount cannot be negative"],
      max: [100, "Discount cannot exceed 100"],
    },

    // --- Categories ---
    category: {
      type: String,
      required: [true, "Category is required"],
      enum: [
        "Electronics", "Fashion", "Food", "Books", "Health", "Other"
      ],
      default: "Other",
      index: true,
    },

    subCategory: {
      type: String,
      enum: [
        // Electronics
        "Phones", "Laptops", "Tablets", "Cameras", "Headphones", "Televisions",
        "Speakers", "Wearables", "Gaming Consoles", "Chargers & Cables",
        "Memory Cards", "Monitors", "Printers", "Smart Home Devices", "Drones",
        "Projectors", "VR Devices", "Networking", "Power Banks", "Accessories",

        // Fashion
        "Men Shoes", "Women Shoes", "Men Caps", "Women Caps", "Men Bags", "Women Bags",
        "Men Glasses", "Women Glasses", "Men Shirts", "Women Shirts", "Trousers",
        "Skirts", "Gowns", "Belts", "Ties", "Jackets", "Hoodies & Sweatshirts",
        "Shorts", "Socks & Hosiery", "Other Fashion",

        // Food
        "Snacks", "Beverages", "Dairy", "Bakery", "Fruits", "Vegetables", "Meat",
        "Seafood", "Canned Goods", "Condiments", "Spices", "Frozen Foods",
        "Grains & Pulses", "Oils & Fats", "Breakfast Foods", "Noodles & Pasta",
        "Sauces", "Sweets & Chocolates", "Tea & Coffee", "Other Food",

        // Books
        "Fiction", "Non-Fiction", "Science", "History", "Biography", "Comics",
        "Children", "Education", "Art", "Religion", "Technology", "Business",
        "Travel", "Cooking", "Health & Fitness", "Self-Help", "Poetry",
        "Mystery & Thriller", "Fantasy & Sci-Fi", "Other Books",

        // Health
        "Supplements", "Vitamins", "First Aid", "Personal Care", "Fitness Equipment",
        "Medical Devices", "Skin Care", "Hair Care", "Oral Care", "Baby Care",
        "Weight Management", "Immunity Boosters", "Pain Relief", "Men's Health",
        "Women's Health", "Eye Care", "Diabetes Care", "Nutrition", "Wellness",
        "Other Health",

        // Others
        "Miscellaneous", "Toys", "Stationery", "Tools", "Home Decor", "Gardening",
        "Automotive", "Pet Supplies", "Travel", "Office Supplies", "Kitchenware",
        "Furniture", "Cleaning Supplies", "Outdoor Gear", "Electronics Accessories",
        "Sports Equipment", "Bags & Luggage", "Music Instruments", "Craft Supplies",
        "Other Items",
      ],
      default: "Other",
    },

    brand: { type: String },

    // --- Inventory ---
    stock: {
      type: Number,
      required: [true, "Stock quantity is required"],
      min: [0, "Stock cannot be negative"],
      default: 0,
    },

    isAvailable: { type: Boolean, default: true, index: true },

    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },

    isFeatured: { type: Boolean, default: false, index: true },

    // --- Media ---
    images: {
      type: [imageSchema],
      default: [],
    },

    video: {
      type: videoSchema,
      default: null,
    },

    // ------------------------
    // MERGED RATING SYSTEM
    // ------------------------

    // For simple access on frontend (main average rating)
    ratingsAverage: {
      type: Number,
      default: 0,
      min: [1, "Rating must be above 1.0"],
      max: [5, "Rating must be below 5.0"],
      set: val => Math.round(val * 10) / 10,
    },

    ratingsQuantity: {
      type: Number,
      default: 0,
    },

    // For advanced backend incremental aggregation
    rating: { type: Number, default: 0 },  
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    reviewsCount: { type: Number, default: 0 },

    // --- Association ---
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    metadata: mongoose.Schema.Types.Mixed,
  },

  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// ----------------------
// VIRTUALS
// ----------------------

// Price after discount
ProductSchema.virtual("priceAfterDiscount").get(function () {
  if (!this.discount || this.discount <= 0) return this.price;
  return +(this.price * (1 - this.discount / 100)).toFixed(2);
});

// ----------------------
// INDEXES
// ----------------------

ProductSchema.index({ name: "text", description: "text" });
ProductSchema.index({ category: 1, subCategory: 1 });
ProductSchema.index({ rating: -1 });
ProductSchema.index({ isAvailable: 1 });
ProductSchema.index({ price: 1 });

// ----------------------
// EXPORT MODEL
// ----------------------

module.exports = mongoose.model("Product", ProductSchema);
