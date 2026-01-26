const express = require("express");
const router = express.Router();
const {
  listTickets,
  getTicket,
  bulkCloseTickets,
} = require("../../controller/supportTicketController");

// Admin-only routes
router.get("/", listTickets);
router.get("/:id", getTicket);
router.put("/bulk-close", bulkCloseTickets);

module.exports = router;
