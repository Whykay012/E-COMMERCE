// services/OrderService.js

const mongoose = require("mongoose");
// 🚨 UPGRADE: Import queueJob and the required queue name constants
const { queueJob, GENERAL_QUEUE_NAME } = require("../queue/jobQueue"); 
const AuditLogger = require("../services/auditLogger"); 

// Assume these utils handle status mapping reliably
const { computeProgress, computeTimeline } = require("../utils/orderStatusProgress"); 
const NotFoundError = require("../errors/notFoundError");
const BadRequestError = require("../errors/bad-request-error");
const Order = require("../model/order");
const Notification = require("../model/notification");
const Product = require("../model/product");

const BATCH_SIZE = 50;
const STALE_DAYS = 7; 
const LOW_STOCK_THRESHOLD = 5; // Products below this level need attention

// =================================================================================
// HELPER 1: markOrderAsProcessing (Transactional Core)
// =================================================================================

/**
 * Helper: Atomically marks an order as processing (single-order transaction).
 */
const markOrderAsProcessing = async (orderId, io = null, session = null) => {
    const orderQuery = Order.findById(orderId).populate("user");
    const order = session ? await orderQuery.session(session) : await orderQuery;
    if (!order) throw new NotFoundError("Order not found");
    if (order.status !== "paid") {
        throw new BadRequestError(
            "Cannot move to processing unless payment is confirmed"
        );
    }

    const internalSession = session || (await mongoose.startSession());
    const isInternal = !session;
    if (isInternal) internalSession.startTransaction();

    try {
        const oldStatus = order.status;
        
        // --- ATOMIC STATE MUTATION ---
        order.status = "processing";
        order.statusProgress = computeProgress("processing");
        order.timeline = computeTimeline("processing");
        order.history = order.history || [];
        order.history.push({
            status: "processing",
            progress: order.statusProgress,
            message: "Order is now being processed",
            timestamp: new Date(),
        });
        order.events = order.events || [];
        order.events.push({ label: "Order moved to processing", date: new Date() });

        await order.save({ session: internalSession });

        // Notification created within transaction for state guarantee
        await Notification.create(
            [{
                user: order.user._id,
                title: `Order Processing`,
                body: `Your order #${order._id} is now processing.`,
                read: false,
            }],
            { session: internalSession }
        );

        if (isInternal) await internalSession.commitTransaction();
        // --- END ATOMIC BLOCK ---
        
        // 🛡️ AUDIT LOG: Crucial state change confirmed (outside of transaction)
        // 🎯 FIXED: Removed 'await' to ensure non-blocking log dispatch
        AuditLogger.dispatchLog({
            level: 'SECURITY',
            event: 'ORDER_STATE_TRANSITION',
            userId: "System:Automation", // System-triggered
            details: {
                entityId: order._id.toString(),
                entityType: "Order",
                oldStatus: oldStatus, 
                newStatus: "processing", 
                reason: "Payment Confirmed via Automation",
            }
        }); 

        // 💡 Side-effects are queued AFTER the transaction commits
        // ➡️ UPGRADED queueJob call
        await queueJob(
            GENERAL_QUEUE_NAME,
            "notify.send_confirmation", 
            { 
                orderId: order._id.toString(), 
                userId: order.user._id.toString() 
            }
        );
        
        // Socket emit (best effort)
        try {
            (io || global.io)
                ?.to(order.user._id.toString())
                .emit("orderUpdated", {
                    orderId: order._id,
                    status: order.status,
                    statusProgress: order.statusProgress,
                    timeline: order.timeline,
                });
        } catch (err) { /* ignore socket error */ }

        return order;
    } catch (err) {
        if (isInternal) await internalSession.abortTransaction();
        throw err;
    } finally {
        if (isInternal) internalSession.endSession();
    }
};

// =================================================================================
// HELPER 2: updateOrderStatus (Admin-triggered)
// =================================================================================

/**
 * Helper: Updates an order status via Admin.
 */
const updateOrderStatus = async (orderId, newStatus, io = null, adminUserId = null) => {
    const order = await Order.findById(orderId).populate('user', '_id'); 
    if (!order) throw new NotFoundError("Order not found");

    if (newStatus === "processing" && order.status !== "paid") {
        // Delegate to the transactional helper
        // Note: The helper will use its own session management
        return markOrderAsProcessing(orderId, io, null, adminUserId); 
    }
    
    const oldStatus = order.status;

    // Standard update path
    order.status = newStatus;
    order.statusProgress = computeProgress(newStatus);
    order.timeline = computeTimeline(newStatus);
    order.events = order.events || [];
    order.events.push({
        label: `Admin changed status → ${newStatus}`,
        date: new Date(),
    });

    await order.save();

    // 🛡️ AUDIT LOG: Admin-triggered status change
    // 🎯 FIXED: Removed 'await' to ensure non-blocking log dispatch
    AuditLogger.dispatchLog({
        level: 'RISK', // Manual Admin changes are higher risk
        event: 'ORDER_STATE_TRANSITION_MANUAL',
        userId: adminUserId, // Log the actual admin user ID
        details: {
            entityId: order._id.toString(),
            entityType: "Order",
            oldStatus: oldStatus, 
            newStatus: newStatus, 
            reason: "Manual Admin Update",
        }
    });

    // Decoupled side-effects
    (io || global.io)?.to(order.user.toString()).emit("orderUpdated", {
        orderId: order._id,
        status: order.status,
        statusProgress: order.statusProgress,
        timeline: order.timeline,
    });
    
    await Notification.create({
        user: order.user,
        title: `Order Status Update`,
        body: `Your order #${order._id} is now: ${newStatus.toUpperCase()}`,
        read: false,
    });

    return order;
};

// =================================================================================
// HELPER 3: enqueuePaidOrdersForProcessing (Atomic Claim)
// =================================================================================

/**
 * 🌟 The most efficient batch claim mechanism.
 */
const enqueuePaidOrdersForProcessing = async () => {
    // 1. Find the next batch of eligible orders
    const eligibleOrders = await Order.find(
        { status: "paid", "metadata.isEnqueued": { $ne: true } }
    )
    .limit(BATCH_SIZE)
    .select('_id')
    .lean();

    if (!eligibleOrders.length) return 0;
    const eligibleOrderIds = eligibleOrders.map(o => o._id);
    const now = new Date();

    // 2. ⚛️ SINGLE ATOMIC UPDATE TO CLAIM THE ENTIRE BATCH
    const result = await Order.updateMany(
        { 
            _id: { $in: eligibleOrderIds }, 
            status: "paid", 
            "metadata.isEnqueued": { $ne: true } 
        },
        { 
            $set: { 
                "metadata.isEnqueued": true, 
                "metadata.enqueuedAt": now 
            } 
        }
    );
    const successfullyClaimedCount = result.modifiedCount;
    if (successfullyClaimedCount === 0) return 0;
    
    // 🛡️ AUDIT LOG: Log the batch operation itself
    // 🎯 FIXED: Removed 'await' to ensure non-blocking log dispatch
    AuditLogger.dispatchLog({
        level: 'INFO',
        event: 'BATCH_ORDERS_CLAIMED',
        userId: "System:Automation",
        details: { count: successfullyClaimedCount, first5Ids: eligibleOrderIds.slice(0, 5) }
    });

    // 3. 🚀 ASYNCHRONOUSLY ENQUEUE
    const claimedOrderDocs = await Order.find({ 
        _id: { $in: eligibleOrderIds }, 
        "metadata.enqueuedAt": now 
    })
    .select('_id')
    .lean();

    const jobPromises = claimedOrderDocs.map(order =>
        // ➡️ UPGRADED queueJob call
        queueJob(
            GENERAL_QUEUE_NAME,
            "order.process", 
            { orderId: order._id.toString() }
        )
    );
    await Promise.all(jobPromises); 

    return successfullyClaimedCount;
};

// =================================================================================
// HELPER 4: cancelStalePendingOrders (Bulk Cancellation)
// =================================================================================

/**
 * 🌟 Uses bulk update for speed, then delegates high-latency side-effects.
 */
const cancelStalePendingOrders = async (io = null) => {
    const now = new Date();
    const limit = new Date(now);
    limit.setDate(now.getDate() - STALE_DAYS); 

    const cancelledStatus = computeProgress("cancelled");
    const cancelledTimeline = computeTimeline("cancelled");

    // 1. ⚡️ SINGLE ATOMIC BULK UPDATE AND FLAG FOR NOTIFICATION
    const updateResult = await Order.updateMany(
        { 
            status: "pending",
            createdAt: { $lte: limit },
            "metadata.needsNotification": { $ne: true } // Concurrency check
        },
        { 
            $set: {
                status: "cancelled",
                statusProgress: cancelledStatus,
                timeline: cancelledTimeline,
                "metadata.needsNotification": true, // Staging flag
                "metadata.cancelledAt": now
            },
            $push: {
                events: { label: `Auto-cancelled after ${STALE_DAYS} days (Stale)`, date: now },
                history: {
                    status: "cancelled",
                    progress: cancelledStatus,
                    message: "Order auto-cancelled due to payment inactivity.",
                    timestamp: now,
                }
            }
        }
    );
    
    const cancelledCount = updateResult.modifiedCount;
    if (cancelledCount === 0) return 0;
    
    // 🛡️ AUDIT LOG: Log the batch cancellation
    // 🎯 FIXED: Removed 'await' to ensure non-blocking log dispatch
    AuditLogger.dispatchLog({
        level: 'SECURITY', // Data/Transaction modification
        event: 'BATCH_ORDERS_CANCELLED_STALE',
        userId: "System:Automation",
        details: { count: cancelledCount, reason: `Stale after ${STALE_DAYS} days` }
    });

    // 2. 🔍 FIND UPDATED ORDERS FOR SIDE-EFFECT DATA
    const ordersToNotify = await Order.find({
        "metadata.needsNotification": true,
        "metadata.cancelledAt": now 
    })
    .select('_id user')
    .populate('user', '_id') 
    .lean();

    // 3. 📤 ASYNCHRONOUS SIDE-EFFECTS DELEGATION (Job Queueing)
    const jobPromises = ordersToNotify.map(order => 
        // ➡️ UPGRADED queueJob call
        queueJob(
            GENERAL_QUEUE_NAME,
            "notify.order_cancelled_stale", 
            { 
                orderId: order._id.toString(), 
                userId: order.user._id.toString(), 
                status: "cancelled" 
            }
        )
    );
    await Promise.all(jobPromises); 

    return cancelledCount;
};


// =================================================================================
// HELPER 5: runLowStockNotificationAndArchival (Product Inventory)
// =================================================================================

/**
 * 🌟 Bulk processing for product stock management.
 */
const runLowStockNotificationAndArchival = async () => {
    const now = new Date();

    // 1. ⚡️ BULK UPDATE: Mark products below threshold that haven't been notified yet.
    const lowStockResult = await Product.updateMany(
        {
            stock: { $lte: LOW_STOCK_THRESHOLD },
            notifiedLowStock: { $ne: true },
        },
        {
            $set: { 
                notifiedLowStock: true, 
                lastNotifiedAt: now 
            },
            $push: { 
                notifications: { 
                    message: `Stock low (${LOW_STOCK_THRESHOLD} left)`, 
                    timestamp: now 
                } 
            }
        }
    );

    // 2. ⚡️ BULK UPDATE: Mark products that are truly OOS and need archival/removal.
    const oosResult = await Product.updateMany(
        {
            stock: { $eq: 0 },
            isArchived: { $ne: true }, 
            notifiedOutOfStock: { $ne: true }, 
        },
        {
            $set: {
                isArchived: true,
                notifiedOutOfStock: true,
                lastNotifiedAt: now
            },
            $push: { 
                notifications: { 
                    message: "Product out of stock and archived.", 
                    timestamp: now 
                } 
            }
        }
    );
    
    const totalModified = lowStockResult.modifiedCount + oosResult.modifiedCount;
    if (totalModified === 0) return 0;
    
    // 🛡️ AUDIT LOG: Log the inventory change
    // 🎯 FIXED: Removed 'await' to ensure non-blocking log dispatch
    AuditLogger.dispatchLog({
        level: 'WARN', // Indicates a business problem (low stock)
        event: 'BATCH_PRODUCT_INVENTORY_MODIFIED',
        userId: "System:Automation",
        details: { 
            lowStockNotified: lowStockResult.modifiedCount, 
            archivedOOS: oosResult.modifiedCount 
        }
    });

    // 3. 🔍 ASYNCHRONOUS ADMIN NOTIFICATION (Decoupled queue job)
    // ➡️ UPGRADED queueJob call
    await queueJob(
        GENERAL_QUEUE_NAME,
        "admin.notify_low_stock_summary", 
        { 
            lowStockCount: lowStockResult.modifiedCount,
            oosCount: oosResult.modifiedCount,
            timestamp: now.toISOString()
        }
    );

    return totalModified;
};

// =================================================================================
// MASTER AUTOMATION FUNCTION
// =================================================================================

/**
 * Master automation function called by CRON job.
 */
const runCriticalAutomation = async () => {
    const processedOrders = await enqueuePaidOrdersForProcessing(); 
    const cancelledOrders = await cancelStalePendingOrders(global?.io || null);
    const modifiedProducts = await runLowStockNotificationAndArchival();
    
    return {
        processedOrders: processedOrders,
        cancelledStaleOrders: cancelledOrders,
        modifiedProducts: modifiedProducts,
    };
};


module.exports = {
    markOrderAsProcessing,
    updateOrderStatus,
    runCriticalAutomation,
    runLowStockNotificationAndArchival, 
};