const express = require("express");
const router = express.Router();
const { getForYou, alsoBoughtRecommendations } = require("../services/recommendations");
// Assuming you have a standard helper function for MongoDB ID validation
// const isValidObjectId = require("../utils/mongoValidator"); 

// Middleware to simulate real authentication: 
// In a production app, this would use JWT or session to set req.user
const authenticate = (req, res, next) => {
    // IMPORTANT: In a real application, you must verify the user's token here.
    // For this demonstration, we trust the 'userId' query parameter, but this is INSECURE in production.
    if (req.query.userId || req.params.productId) {
        // Placeholder for setting the authenticated user's ID
        // req.user = { id: req.query.userId }; 
        next();
    } else {
        // If no user context, we don't proceed
        // return res.status(401).json({ message: "Authentication required" });
        next(); // Allowing through for demonstration purposes
    }
};

router.use(authenticate);

// User-based recommendations
// Endpoint: GET /api/recommendations/for-you?userId=<ID>&limit=<N>
router.get("/for-you", async (req, res) => {
    // Use the userId from the authenticated user (safer) or the query parameter (less secure)
    const userId = req.query.userId;
    const limit = parseInt(req.query.limit) || 8;

    if (!userId) {
        return res.status(400).json({ message: "userId query parameter is required." });
    }
    
    // Optional: Add validation for userId format (e.g., length, type)
    // if (!isValidObjectId(userId)) {
    //     return res.status(400).json({ message: "Invalid userId format." });
    // }

    try {
        const products = await getForYou(userId, limit);
        res.json(products);
    } catch (err) {
        console.error(`Error retrieving /for-you recommendations for user ${userId}:`, err);
        // Respond with a 500 status code for internal server errors
        res.status(500).json({ 
            message: "Failed to retrieve personalized recommendations.",
            // Do NOT expose 'err' in production, but helpful for debugging
            // errorDetail: err.message
        });
    }
});

// Item-based recommendations
// Endpoint: GET /api/recommendations/also-bought/:productId?limit=<N>
router.get("/also-bought/:productId", async (req, res) => {
    const productId = req.params.productId;
    const limit = parseInt(req.query.limit) || 8;

    // Optional: Add validation for productId format
    // if (!isValidObjectId(productId)) {
    //     return res.status(400).json({ message: "Invalid productId format." });
    // }

    try {
        const products = await alsoBoughtRecommendations(productId, limit);
        res.json(products);
    } catch (err) {
        console.error(`Error retrieving also-bought recommendations for product ${productId}:`, err);
        // Respond with a 500 status code for internal server errors
        res.status(500).json({ 
            message: "Failed to retrieve item-based recommendations.",
            // errorDetail: err.message
        });
    }
});

module.exports = router;