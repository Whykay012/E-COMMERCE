const express = require("express");
const router = express.Router();
const {
  addRecentlyViewed,
  listRecentlyViewed,
  removeRecentlyViewed,
} = require("../../controller/recentlyViewedController");

// User routes
router.post("/", addRecentlyViewed);
router.get("/", listRecentlyViewed);
router.delete("/:id", removeRecentlyViewed);

module.exports = router;
