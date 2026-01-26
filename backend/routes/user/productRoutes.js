const express = require("express");
const router = express.Router();
const {
  getProducts,
  getProductById,
  getRandomProducts,
} = require("../../controller/productController");

// Public product routes
router.get("/", getProducts);
router.get("/random", getRandomProducts);
router.get("/:id", getProductById);

module.exports = router;
