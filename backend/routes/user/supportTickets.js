const express = require("express");
const router = express.Router();
const {
  createTicket,
  listTickets,
  getTicket,
  closeTicket,
  reopenTicket,
  deleteTicket,
} = require("../../controller/supportTicketController");

// User routes
router.post("/", createTicket);
router.get("/", listTickets);
router.get("/:id", getTicket);
router.put("/:id/close", closeTicket);
router.put("/:id/reopen", reopenTicket);
router.delete("/:id", deleteTicket);

module.exports = router;
