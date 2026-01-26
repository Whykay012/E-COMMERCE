require("dotenv").config();

module.exports = {
  PORT: process.env.PORT || 5000,
  MONGO_URI: process.env.MONGO_URI,
  JWT_SECRET: process.env.JWT_SECRET,
  NODE_ENV: process.env.NODE_ENV || "development",
  CLIENT_URL: process.env.CLIENT_URL || "http://localhost:3000",
  SOCKET_PATH: process.env.SOCKET_PATH || "/socket.io",
    // --- Redis Configuration for BullMQ and Caching ---
    REDIS_HOST: process.env.REDIS_HOST || "127.0.0.1",
    REDIS_PORT: parseInt(process.env.REDIS_PORT || "6379", 10),
    REDIS_PASSWORD: process.env.REDIS_PASSWORD || null, // null if no password
};
