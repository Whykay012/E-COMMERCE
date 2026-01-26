const express = require("express");
const router = express.Router();
const { authenticate, adminOnly } = require("../../middleware/authMiddleware");
const { validate } = require("../../validators/validate"); // Import validate
const { IdParamSchema } = require("../../validators/adminValidators"); // Import schema for ID validation
const {
getFestiveBanners,
deleteFestiveBanner,
} = require("../../controller/adminDashboard");


// Protect all routes
router.use(authenticate, adminOnly);

// Banner CRUD
router.get("/festive", getFestiveBanners);

// DELETE /festive/:id - Requires validation of the ID parameter
router.delete("/festive/:id", 
    validate(IdParamSchema, 'params'), // Validate the ID parameter (e.g., ensuring it's a valid ObjectId/UUID)
    deleteFestiveBanner
);

module.exports = router;