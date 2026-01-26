const express = require("express");
const router = express.Router();
const { adjustPoints } = require("../../controller/loyaltyController");

// Admin-only route to adjust points
router.post("/adjust", adjustPoints);

module.exports = router;
