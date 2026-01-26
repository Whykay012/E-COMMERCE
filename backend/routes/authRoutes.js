const express = require("express");
const router = express.Router();

// Modular Routes
const authRoutes = require("./user/authRoutes");
const dashboardRoutes = require("./user/dashboardRoutes");
const orderRoutes = require("./user/orderRoutes");
const profileRoutes = require("./user/profileRoutes");
const wishlistRoutes = require("./user/wishlistRoutes");
const productRoutes = require("./user/productRoutes");
const forgotPasswordRoutes = require("./user/forgotPassword");
const notificationRoutes = require("./user/notificationRoutes");
const sessionRoutes = require("./user/sessionRoutes");
const paymentRoutes = require("./user/paymentRoutes");
const cartRoutes = require("./user/cartRoutes");
const userAddresses = require("./user/addresses");
const userLoyalty = require("./user/loyalty");
const userRecentlyViewed = require("./user/recentlyViewed");
const userSupportTickets = require("./user/supportTickets");
const userActivityLogs = require("./user/activityLogs");
const checkoutRoutes = require("./user/checkoutRoutes");
const userReferral = require("./user/userReferralRoutes");
const { authenticate } = require("../middleware/authMiddleware");

// Mount routes
router.use("/userAuth", authRoutes);
router.use("/userDashboard", dashboardRoutes);
router.use("/userOrders", orderRoutes);
router.use("/userProfile", profileRoutes);
router.use("/userforgetPassword", forgotPasswordRoutes);
router.use("/userProducts", productRoutes);
router.use("/userWishlist", wishlistRoutes);
router.use("/userNotifications", notificationRoutes);
router.use("/userSessions", sessionRoutes);
router.use("/userPayment", paymentRoutes);
router.use("/userCheckout", checkoutRoutes);
router.use("/userCart", cartRoutes);
router.use("/userAddresses", authenticate, userAddresses);
router.use("/userLoyalty", authenticate, userLoyalty);
router.use("/userRecently-viewed", authenticate, userRecentlyViewed);
router.use("/userSupport-tickets", authenticate, userSupportTickets);
router.use("/userActivity-logs", authenticate, userActivityLogs);
router.use("/userReferral", userReferral);

module.exports = router;
