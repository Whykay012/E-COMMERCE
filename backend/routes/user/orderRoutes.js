const express = require("express");
const router = express.Router();
const { authenticate } = require("../../middleware/authMiddleware");

const {
  getUserOrders,
  getOrderById,
  createOrder,
  cancelOrder,
} = require("../../controller/orderController");

router.use(authenticate);

// Orders
router.post("/", createOrder);
router.get("/", getUserOrders);
router.get("/:id", getOrderById);
router.get("/:id", cancelOrder);

module.exports = router;
