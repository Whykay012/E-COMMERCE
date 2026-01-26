const express = require("express");
const router = express.Router();

// Import modular routes
const dashboardRoutes = require("./admin/dashboardRoutes");
const productRoutes = require("./admin/productRoutes");

const uploadRoutes = require("./admin/uploadRoutes");
const cartRoutes = require("./admin/cartRoute");
const adminLoyalty = require("./admin/loyalty");
const adminSupportTickets = require("./admin/supportTickets");
// const adminInventory = require("./admin/adminInventory");
const adminReview = require("./admin/adminReviewRoute");
const adminRateLimiter = require("./admkn/adminRateLimiterRoutes"); // <--- NEW IMPORT
const adminReferral = require("./admin/adminReferralRoutes");
const adminUser = require("./admin/adminUserRoutes");
const inventory = require("./admin/inventory");


// 💡 ACTIVATED: Import the new middleware structure
const { authenticate, authorizePermissions } = require('../middleware/authMiddleware'); 

// --- ROUTER LEVEL MIDDLEWARE ---

// Apply administrative rate limiting to all routes in this router
router.use(adminRateLimitController.adminRateLimitMiddleware()); 

// 💡 ACTIVATED: Apply authentication to secure all routes
router.use(authenticate);

// 💡 ACTIVATED: Apply high-level authorization (only 'admin' and 'security_engineer' can access)
const restrictToAdmin = authorizePermissions(['admin', 'security_engineer']);
router.use(restrictToAdmin); 

// Mount sub-routers
router.use("/admin/dashboard", dashboardRoutes);
router.use("/admin/adminUser", adminUser);
router.use("/admin/products", productRoutes);

// Note: This upload route applies AdminOnly before Authenticate. 
// It is best practice to Authenticate FIRST, then check roles.
router.use("/admin/upload", authenticate, uploadRoutes); 
router.use("/admin/carts", cartRoutes);
router.use("/admin/review", adminReview);
router.use("/admin/loyalty", authenticate, adminLoyalty);
router.use("/admin/inventory", inventory);
router.use(
  "/admin/support-tickets",
  authenticate,

  adminSupportTickets
);
// Mount the new Rate Limiter Admin route
router.use(
  "/admin/ratelimit", 
  authenticate, 
 
  adminRateLimiter // <--- NEW ROUTE MOUNTED
);
router.use("/admin/referral", authenticate, adminReferral);

module.exports = router;