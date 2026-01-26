const express = require('express');
const router = express.Router();

// --- Controller Imports ---
const {
  getUserDashboard,
  updateProfile,
  changePassword,
  deleteAccount,
  logout,
  revokeSession,
  revokeAllSessions,
  getSessions,
  setDefaultAddress,
  setDefaultPaymentMethod,
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  getNotifications,
  markAsRead,
  markAllRead,
  getUserPayments,
  downloadReceipt,
} = require('../controller/userController');

// --- Middleware Imports ---
const protect = require('../middleware/authMiddleware').protect;
const {
    validateUpdateProfile,
    validateChangePassword,
    validateAddToWishlist,
    validateIdInParams,
    validateSessionIdInParams,
} = require('../validation/userValidation');

// --------------------------- CORE USER ROUTES ---------------------------
router.route('/')
  .get(protect, getUserDashboard)  // Get aggregated dashboard data
  .delete(protect, deleteAccount); // Delete user account

router.post('/logout', protect, logout);

// --------------------------- PROFILE MANAGEMENT ---------------------------
router.route('/profile')
  // Joi validation handles sanitization and whitelisting
  .put(protect, validateUpdateProfile, updateProfile); 

router.route('/change-password')
  // Joi validation handles sanitization and whitelisting
  .patch(protect, validateChangePassword, changePassword); 

// --------------------------- SESSION MANAGEMENT ---------------------------
router.route('/sessions')
  .get(protect, getSessions)        // Get list of active sessions
  .delete(protect, revokeAllSessions); // Revoke all sessions except the current one

router.route('/sessions/:sessionId')
  // Validate sessionId format
  .delete(protect, validateSessionIdInParams, revokeSession);  // Revoke a specific session

// --------------------------- WISHLIST ---------------------------
router.route('/wishlist')
  .get(protect, getWishlist)        // Get user wishlist
  // Validate productId format
  .post(protect, validateAddToWishlist, addToWishlist); // Add item to wishlist

router.route('/wishlist/:id')
  // Validate ID format in params
  .delete(protect, validateIdInParams, removeFromWishlist); // Remove item from wishlist

// --------------------------- ADDRESS MANAGEMENT ---------------------------
router.route('/addresses/:id/default')
  // Validate ID format in params (used as 'id')
  .patch(protect, validateIdInParams, setDefaultAddress); // Set an address as default

// --------------------------- PAYMENT METHODS MANAGEMENT ---------------------------
router.route('/payment-methods/:id/default')
  // Validate ID format in params (used as 'id')
  .patch(protect, validateIdInParams, setDefaultPaymentMethod); // Set a payment method as default

// --------------------------- NOTIFICATIONS ---------------------------
router.route('/notifications')
  .get(protect, getNotifications);  // Get user notifications

router.route('/notifications/read-all')
  .patch(protect, markAllRead);     // Mark all notifications as read

router.route('/notifications/:id/read')
  // Validate ID format in params (used as 'id')
  .patch(protect, validateIdInParams, markAsRead);      // Mark a specific notification as read

// --------------------------- PAYMENTS & RECEIPTS ---------------------------
router.route('/payments')
  .get(protect, getUserPayments);  // Get user payment history

router.route('/payments/:id/receipt')
  .get(protect, validateIdInParams, downloadReceipt);   // Download PDF receipt for a payment

module.exports = router;