require("dotenv").config();
const mongoose = require("mongoose");

// CRITICAL: Ensure correct paths to your Mongoose model definitions
// Loading the models registers the schemas and their index definitions with Mongoose.
const Product = require("../../model/product"); 
const Review = require("../../model/Review"); 
const connectDB = require("../../config/connect");

/**
 * Migration script to ensure all necessary MongoDB indexes are present.
 * * Best Practice: Indexes MUST be defined in the Mongoose schema files (Product.js, Review.js).
 * This script leverages Model.ensureIndexes() to safely create all indexes defined in those schemas.
 */
async function runIndexMigration() {
    try {
        // 1. Establish database connection
        console.log("Attempting to connect to MongoDB...");
        await connectDB(process.env.MONGO_URI);
        console.log("Connected to MongoDB successfully. Running index migration...");

        const startTime = Date.now();

        // 2. Indexing Product Model
        // This will create all 8 indexes defined in ProductSchema (text, compound, single-field).
        console.log("\n--- Indexing Product Model ---");
        await Product.ensureIndexes();
        console.log("✅ Product indexes ensured (8 total, including text search and category filters).");

        // 3. Indexing Review Model
        // This will create the 2 indexes defined in ReviewSchema (unique compound and product sort).
        console.log("\n--- Indexing Review Model ---");
        await Review.ensureIndexes();
        console.log("✅ Review indexes ensured (2 total, including unique user+product constraint).");

        const endTime = Date.now();
        console.log(`\n🎉 Migration Complete in ${((endTime - startTime) / 1000).toFixed(2)}s.`);
        
        // Exit the process cleanly on success
        process.exit(0); 

    } catch (err) {
        console.error("\n❌ Index Migration Error:", err.message);
        console.error("If you see an error related to a conflicting index, you may need to drop it manually.");
        
        // Exit the process with an error code on failure
        process.exit(1);
    }
}

runIndexMigration();