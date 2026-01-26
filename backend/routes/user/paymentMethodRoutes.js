const express = require("express");
const router = express.Router();
const {
  addPaymentMethod,
  getPaymentMethods,
  updatePaymentMethod,
  deletePaymentMethod,
} = require("../../controller/paymentMethodController");
const authMiddleware = require("../../middleware/auth"); // ensure user is logged in

router.use(authMiddleware);

router.post("/", addPaymentMethod);
router.get("/", getPaymentMethods);
router.put("/:id", updatePaymentMethod);
router.delete("/:id", deletePaymentMethod);

module.exports = router;
