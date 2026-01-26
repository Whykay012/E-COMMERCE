const express = require("express");
const router = express.Router();
const { authenticate, adminOnly } = require("../../middleware/authMiddleware");
const {
  getAllUsers,
  deleteUser,
  updateUserRole,
} = require("../../controller/adminController");

// Apply admin authentication
router.use(authenticate, adminOnly);

// User Management
router.get("/", getAllUsers); // GET /admin/users
router.delete("/:id", deleteUser); // DELETE /admin/users/:id
router.put("/:id/role", updateUserRole); // PUT /admin/users/:id/role

module.exports = router;
