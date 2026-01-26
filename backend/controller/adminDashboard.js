/* ===========================
 * 📦 Dependencies
 * =========================== */
const { StatusCodes } = require("http-status-codes");
const asyncHandler = require("../middleware/asyncHandler");
const NotFoundError = require("../errors/notFoundError");
const CloudinaryService = require("../services/cloudinaryService");
const AdminService = require("../services/adminService");
const OrderAutomationService = require("../services/orderAutomationService");
const AuditLogger = require("../services/auditLogger");
const mongoose = require("mongoose");

// --- Core Logic Services ---
const InventoryService = require("../services/inventoryService");
const User = require("../model/user");

// --- 🛡️ Compliance & Security Stats ---
const {
  getErasureHealthReport,
  getSecurityOutboxReport,
} = require("../services/complianceStats");

// --- Models ---
const Order = require("../model/order");
const Banner = require("../model/banner");
const Notification = require("../model/notification");
const ComplianceOutbox = require("../model/complianceOutbox");

/* ===========================================================
 * 1. Admin Dashboard Summary (Zenith Unified Facet View)
 * =========================================================== */
const adminDashboard = asyncHandler(async (req, res) => {
  /**
   * 💡 PERFORMANCE UPGRADE: $facet Aggregation
   * We run multiple counts and summaries across different collections
   * in a single database round-trip to minimize I/O overhead.
   */
  const [dashboardStats] = await mongoose.model("Order").aggregate([
    {
      $facet: {
        // Business Metrics
        orderStats: [
          {
            $match: {
              createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            },
          },
          {
            $group: {
              _id: null,
              dailyRevenue: { $sum: "$totalAmount" },
              dailyCount: { $sum: 1 },
            },
          },
        ],
        // Reliability Metrics (Pending Tasks)
        reliabilityStats: [
          {
            $indexStats: {}, // Optional: check for index health
          },
        ],
        // Compliance Metrics
        complianceStats: [
          {
            $lookup: {
              from: "complianceoutboxes",
              pipeline: [
                { $match: { status: "PENDING" } },
                { $count: "pendingErasures" },
              ],
              as: "pendingCompliance",
            },
          },
        ],
      },
    },
  ]);

  // Parallelize remaining service-based reports
  const [summary, complianceReport, securityReport] = await Promise.all([
    AdminService.getDashboardSummary(),
    getErasureHealthReport(),
    getSecurityOutboxReport(),
  ]);

  // Identify System Status (Operational, Degraded, or Critical)
  const systemHealth =
    securityReport.stalePendingCount > 5 ? "DEGRADED" : "OPERATIONAL";

  res.status(StatusCodes.OK).json({
    message: "Admin Dashboard Summary",
    systemStatus: systemHealth,
    data: {
      business: {
        ...summary,
        recent: dashboardStats.orderStats[0] || {
          dailyRevenue: 0,
          dailyCount: 0,
        },
      },
      compliance: complianceReport,
      reliability: securityReport, // 🛡️ Real-time health of Outbox pipelines
    },
  });
});

/* ===========================================================
 * 2. User Management (Security & Financial Integrity)
 * =========================================================== */
const listUsersAdmin = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  const query = search
    ? {
        $or: [
          { email: new RegExp(search, "i") },
          { username: new RegExp(search, "i") },
        ],
      }
    : {};

  const users = await User.find(query)
    .select(
      "firstName lastName username email walletBalance webAuthnEnabled role isVerified createdAt"
    )
    .limit(limit * 1)
    .skip((page - 1) * limit)
    .sort({ createdAt: -1 })
    .lean();

  const count = await User.countDocuments(query);

  res.status(StatusCodes.OK).json({
    success: true,
    data: users,
    pagination: {
      total: count,
      pages: Math.ceil(count / limit),
      currentPage: page,
    },
  });
});

const getUserAuditTrail = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user = await User.findById(id).select("email username webAuthnEnabled");

  if (!user) throw new NotFoundError("User not found");

  const logs = await AuditLogger.getLogsByEntityId(id);

  res.status(StatusCodes.OK).json({
    success: true,
    user,
    history: logs,
  });
});

/* ===========================================================
 * 3. Trigger Automation (Manual CRON/Job Execution)
 * =========================================================== */
const triggerAutomation = asyncHandler(async (req, res) => {
  await AuditLogger.dispatchLog({
    level: "RISK",
    event: "AUTOMATION_MANUAL_TRIGGERED",
    userId: req.user ? req.user._id.toString() : "N/A",
    details: { source: "AdminController", endpoint: "/trigger-automation" },
  });

  const results = await OrderAutomationService.runCriticalAutomation();

  res.status(StatusCodes.OK).json({
    message:
      "Critical order automation and self-healing tasks triggered successfully.",
    detail: results,
  });
});

/* ===========================================================
 * 4. Manual Admin Order Status Update
 * =========================================================== */
const updateOrderStatusAdmin = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const orderId = req.params.id;
  const adminUserId = req.user ? req.user._id.toString() : null;

  const order = await OrderAutomationService.updateOrderStatus(
    orderId,
    status,
    req.app.get("io"),
    adminUserId
  );

  res.status(StatusCodes.OK).json({
    message: `Order status updated to ${status} successfully`,
    order,
  });
});

/* ===========================================================
 * 5. Admin Inventory Stock Update (Manual/Bulk)
 * =========================================================== */
const updateInventoryStockAdmin = asyncHandler(async (req, res) => {
  const { sku, quantity, reason } = req.body;
  const adminUserId = req.user ? req.user._id.toString() : null;

  if (!adminUserId) throw new Error("Admin user context required.");

  const updatedInventory = await InventoryService.executeAdminStockUpdate({
    sku,
    quantity,
    reason,
    adminUserId,
  });

  res.status(StatusCodes.OK).json({
    message: `Inventory for SKU ${sku} updated successfully.`,
    data: updatedInventory,
  });
});

/* ===========================================================
 * 6. Get Inventory Reports
 * =========================================================== */
const getInventoryReports = asyncHandler(async (req, res) => {
  const { type, days } = req.query;

  const reports = await InventoryService.getInventoryReports({
    reportType: type,
    durationDays: days,
  });

  res.status(StatusCodes.OK).json({
    message: `Inventory Report: ${type || "Summary"}`,
    data: reports,
  });
});

/* ===========================================================
 * 7. BANNER CRUD (Marketing Assets)
 * =========================================================== */
const getFestiveBanners = asyncHandler(async (req, res) => {
  const banners = await Banner.find().sort({ createdAt: -1 });
  res.status(StatusCodes.OK).json({ banners });
});

const deleteFestiveBanner = asyncHandler(async (req, res) => {
  const banner = await Banner.findById(req.params.id);
  if (!banner) throw new NotFoundError("Banner not found");

  if (banner.public_id) {
    try {
      await CloudinaryService.deleteByPublicId(banner.public_id);
    } catch (err) {
      console.warn(`Cloudinary delete failed: ${err.message}`);
    }
  }

  await Banner.findByIdAndDelete(req.params.id);

  await AuditLogger.dispatchLog({
    level: "SECURITY",
    event: "ASSET_DELETED_MANUAL",
    userId: req.user ? req.user._id.toString() : "N/A",
    details: {
      entityId: req.params.id,
      entityType: "Banner",
      assetId: banner.public_id,
    },
  });

  res.status(StatusCodes.OK).json({
    success: true,
    message: "Banner deleted successfully",
  });
});

/* ===========================================================
 * EXPORTS
 * =========================================================== */
module.exports = {
  adminDashboard,
  listUsersAdmin,
  getUserAuditTrail,
  triggerAutomation,
  updateOrderStatusAdmin,
  updateInventoryStockAdmin,
  getInventoryReports,
  getFestiveBanners,
  deleteFestiveBanner,
};
