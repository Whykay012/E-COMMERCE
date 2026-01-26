// config/connectDb.js
require("dotenv").config();
const mongoose = require("mongoose");
const MONGO_URI = process.env.MONGO_URI;

// --- Configuration Constants ---
const MAX_CONNECTION_RETRIES = 5;
const RETRY_DELAY_MS = 5000; // 5 seconds delay

/**
 * @desc Attempts to connect to MongoDB with built-in retry logic and robust configuration.
 * @returns {Promise<void>}
 */
const connectDb = async () => {
    // 1. Configure Mongoose Connection Options (Optimized for Production)
    const options = {
        // Ensures the driver auto-reconnects if the connection drops
        autoReconnect: true, 
        useNewUrlParser: true,
        useUnifiedTopology: true, 
        // Disable index creation in production for performance
        autoIndex: process.env.NODE_ENV !== 'production',
        
        // MongoDB driver connection pool settings
        serverSelectionTimeoutMS: 5000, 
        socketTimeoutMS: 45000, 
        maxPoolSize: 10, 
    };

    let attempts = 0;
    while (attempts < MAX_CONNECTION_RETRIES) {
        try {
            await mongoose.connect(MONGO_URI, options);
            console.log("✅ MongoDB connected successfully.");
            
            // 2. Set up Connection Event Listeners (For Robustness)
            setupConnectionListeners();
            
            return; // Success
        } catch (error) {
            attempts++;
            console.error(`❌ MongoDB connection attempt ${attempts} failed: ${error.message}`);
            
            if (attempts >= MAX_CONNECTION_RETRIES) {
                console.error("🛑 Exceeded max connection retries. Shutting down process.");
                process.exit(1); 
            }

            console.log(`⏱️ Retrying connection in ${RETRY_DELAY_MS / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
};

/**
 * @desc Sets up listeners for Mongoose connection events to handle lifecycle changes.
 */
const setupConnectionListeners = () => {
    const db = mongoose.connection;
    db.on('error', (err) => {
        console.error("🚨 Mongoose connection error:", err.message);
    });
    db.on('connected', () => {
        console.log("🟢 Mongoose re-connected to the database.");
    });
    db.on('disconnected', () => {
        console.warn("🟡 Mongoose disconnected. Attempting to reconnect...");
    });
};

module.exports = connectDb;

// Export the connection instance for graceful shutdown in server.js
module.exports.connection = mongoose.connection;