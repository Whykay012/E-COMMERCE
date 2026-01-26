const express = require("express");
const router = express.Router();
const {
  getLoyaltyHistory,
  awardPoints,
  redeemPoints,
} = require("../../controller/loyaltyController");

// User-specific routes
router.get("/history", getLoyaltyHistory);
router.post("/award", awardPoints);
router.post("/redeem", redeemPoints);

module.exports = router;
