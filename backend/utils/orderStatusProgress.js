/**
 * PRODUCTION-READY ORDER STATUS & PROGRESS SYSTEM
 *
 * Features:
 * - Numeric progress (0-100)
 * - Frontend-friendly timeline
 * - Handles cancelled/refunded orders
 * - Backend helper for auto-saving order status
 */

const ORDER_STATUS_FLOW = [
  "pending",         // Order created
  "confirmed",       // Admin confirmed
  "processing",      // Vendor picking/packaging
  "shipped",         // Rider picked up
  "in_transit",      // Rider moving
  "out_for_delivery",// Rider reached area
  "delivered",       // Customer received
];

const STATUS_TO_PROGRESS = {
  pending: 10,
  confirmed: 25,
  processing: 45,
  shipped: 60,
  in_transit: 75,
  out_for_delivery: 90,
  delivered: 100,
  cancelled: 0,
  refunded: 0,
};

/**
 * Returns numeric progress (0-100)
 */
function getProgress(status) {
  return STATUS_TO_PROGRESS[status] ?? 0;
}

/**
 * Returns the next status in flow
 */
function getNextStatus(currentStatus) {
  const idx = ORDER_STATUS_FLOW.indexOf(currentStatus);
  if (idx === -1) return null;
  return ORDER_STATUS_FLOW[idx + 1] || null;
}

/**
 * Returns timeline array for frontend
 */
function getTimeline(currentStatus) {
  currentStatus = currentStatus?.toLowerCase();

  if (currentStatus === "cancelled" || currentStatus === "refunded") {
    return ORDER_STATUS_FLOW.map((step) => ({
      label: step.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
      value: false,
      cancelled: true,
    }));
  }

  return ORDER_STATUS_FLOW.map((step) => ({
    label: step.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    value: ORDER_STATUS_FLOW.indexOf(step) <= ORDER_STATUS_FLOW.indexOf(currentStatus),
    cancelled: false,
  }));
}

/**
 * Apply a new status to an order and auto-save
 */
async function applyOrderProgress(order, newStatus) {
  order.orderStatus = newStatus;
  order.progress = getProgress(newStatus);
  order.statusUpdatedAt = new Date();
  order.timeline = getTimeline(newStatus);
  return order.save();
}

module.exports = {
  ORDER_STATUS_FLOW,
  STATUS_TO_PROGRESS,
  getProgress,
  getNextStatus,
  getTimeline,
  applyOrderProgress,
};
