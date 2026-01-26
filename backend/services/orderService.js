const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// --- Models ---
const Order = require('../model/order'); 
const Cart = require('../model/cart');
const User = require('../model/userModel'); 

// --- External Services ---
const { InventoryService } = require('./inventoryService');
const PaymentService = require('./paymentService');
const logger = require("../config/logger"); 
const AuditLogger = require('./auditLogger'); 

// 🚨 UPGRADE 1: Import queueJob and the required queue name (GENERAL_QUEUE_NAME)
const { queueJob, GENERAL_QUEUE_NAME } = require('../queue/jobQueue'); 

// --- Errors ---
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const InternalServerError = require("../errors/internal-server-error");
const ConflictError = require('../errors/conflictError');
const DomainError = require('../errors/domainError');

// --- Configuration ---
const ORDER_EXPIRY_MINUTES = 30;


class OrderService {

  /**
  * @desc SAGA Orchestrator (Checkout Path): Creates Order, Reserves Inventory, Initializes Payment.
  * This orchestrates the three main steps of the Order Saga.
  * * @param {string} userId 
  * @param {object} shippingInfo 
  * @returns {object} { order, paymentAuthorizationUrl }
  */
  static async createOrderFromCart(userId, shippingInfo) {
    if (!userId) throw new BadRequestError("User ID is required.");
    
    // --- 1. Load Data & Pre-checks ---
    const user = await User.findById(userId).lean();
    if (!user) throw new NotFoundError("User not found.");

    const cart = await Cart.findOne({ user: userId }).lean();
    if (!cart || cart.items.length === 0) throw new BadRequestError("Cart is empty.");

    const orderId = uuidv4();
    let reservationId = null;

    // 

    // --- Start of SAGA Orchestration ---
    try {
      // Calculate total amount (Security CRITICAL: Recalculate server-side)
      const totalAmount = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      
      // --- 2. Create Initial Order Record (State: INVENTORY_PENDING) ---
      const newOrder = await Order.create({
        _id: orderId,
        user: userId,
        items: cart.items.map(item => ({ 
          productId: item.productId, sku: item.sku, quantity: item.quantity, price: item.price 
        })),
        totalAmount: totalAmount,
        shippingInfo,
        status: 'INVENTORY_PENDING', 
        paymentStatus: 'pending',
        expiresAt: new Date(Date.now() + ORDER_EXPIRY_MINUTES * 60 * 1000)
      });
      // Fire-and-forget logging
      AuditLogger.log({ level: 'INFO', event: 'ORDER_CREATED', orderId, userId });

      // --- 3. SAGA Step 1: Reserve Inventory (Transactional Bounded Context) ---
      const inventoryItems = cart.items.map(item => ({ productId: item.productId, quantity: item.quantity }));
      reservationId = await InventoryService.reserveItems(inventoryItems, orderId);
      
      // --- 4. Update Order State and Clear Cart (Atomic updates for Order & Cart) ---
      const updatedOrder = await Order.findByIdAndUpdate(orderId, {
        $set: {
          status: 'PAYMENT_PENDING', 
          reservationId: reservationId,
        }
      }, { new: true });
      
      await Cart.findByIdAndUpdate(cart._id, { $set: { items: [] } }); 

      // --- 5. SAGA Step 2: Initialize Payment (External System Call) ---
      const paymentInit = await PaymentService.initializePayment(
        userId, 
        totalAmount, 
        user.email, 
        { metadata: { orderId: orderId, reservationId: reservationId } }
      );
      
      // Fire-and-forget logging
      AuditLogger.log({ level: 'INFO', event: 'PAYMENT_INITIATED', orderId, reservationId });
      
      return { order: updatedOrder.toObject(), paymentAuthorizationUrl: paymentInit.authorization_url };

    } catch (error) {
      // --- 6. SAGA Compensation (Rollback Inventory) ---
      logger.error(`Order creation failed for ${orderId}. Starting compensation. Error: ${error.message}`);
      // Fire-and-forget logging
      AuditLogger.log({ level: 'ERROR', event: 'ORDER_SAGA_FAILED', orderId, error: error.message });

      if (reservationId) {
        // Execute compensation asynchronously (non-blocking)
        InventoryService.releaseReservation(reservationId).catch(compError => {
          logger.fatal(`[FATAL] Failed to compensate/release reservation ${reservationId}. Manual intervention needed!`, compError);
          // Fire-and-forget logging
          AuditLogger.log({ level: 'FATAL', event: 'COMPENSATION_FAILED', reservationId, error: compError.message });
        });
      }
      
      // Mark order as FAILED (if it was created in step 2)
      await Order.findByIdAndUpdate(orderId, { 
        $set: { status: 'FAILED', failureReason: error.message } 
      }).catch(() => {/* ignore if order wasn't created */});

      throw error; 
    }
  }

  /**
  * @desc Retrieves an order by ID, ensuring the requesting user has access.
  * @param {string} orderId 
  * @param {string} userId - ID of the currently authenticated user.
  * @param {boolean} isAdmin - Flag indicating if the user is an admin.
  * @returns {object} Order document (lean object)
  */
  static async getOrderById(orderId, userId, isAdmin) {
    if (!orderId) throw new BadRequestError("Order ID is required.");

    const query = { _id: orderId };

    // Security check: If not an admin, restrict the query to the user's own orders.
    if (!isAdmin) {
      query.user = userId;
    }

    const order = await Order.findOne(query).lean();
    
    if (!order) {
      // For security, return a generic 404/403 if the order doesn't exist OR the user doesn't own it.
      throw new NotFoundError(`Order with ID ${orderId} not found or access denied.`);
    }

    return order;
  }

  /**
  * @desc Retrieves a paginated list of orders for a specific user ID with optional filtering.
  * @param {string} userId - The ID of the currently authenticated user.
  * @param {number} page - Current page number (default 1).
  * @param {number} limit - Items per page (default 10).
  * @param {string} paymentStatusFilter - Optional filter by payment status ("pending", "paid", "failed").
  * @param {string} orderStatusFilter - Optional filter by order status ("pending", "processing", "shipped", etc.).
  * @returns {object} { orders: [], totalCount: number, totalPages: number }
  */
  static async getUserOrders(userId, page = 1, limit = 10, paymentStatusFilter, orderStatusFilter) {
    if (!userId) throw new BadRequestError("User ID is required.");

    const skip = (page - 1) * limit;

    // --- CONSTRUCT THE QUERY OBJECT ---
    const query = { user: userId };

    // Apply Payment Status Filter
    if (paymentStatusFilter) {
      // Ensure the filter value is one of the valid enums before applying
      const validPaymentStatuses = ["pending", "paid", "failed"];
      const normalizedPaymentStatus = paymentStatusFilter.toLowerCase();
      
      if (validPaymentStatuses.includes(normalizedPaymentStatus)) {
        query.paymentStatus = normalizedPaymentStatus;
      } else {
        // Ignore invalid filter or throw an error, depending on preference. Throwing is safer.
        throw new BadRequestError(`Invalid paymentStatus filter value: ${paymentStatusFilter}`);
      }
    }
    
    // Apply Order Status Filter
    if (orderStatusFilter) {
      const validOrderStatuses = ["pending", "processing", "shipped", "delivered", "cancelled", "refunded"];
      const normalizedOrderStatus = orderStatusFilter.toLowerCase();

      if (validOrderStatuses.includes(normalizedOrderStatus)) {
        query.status = normalizedOrderStatus; // Note: 'status' is the field name for orderStatus
      } else {
        throw new BadRequestError(`Invalid orderStatus filter value: ${orderStatusFilter}`);
      }
    }
    // ------------------------------------

    // 1. Get the total count for pagination metadata
    const totalCount = await Order.countDocuments(query);

    // 2. Fetch the orders for the current page
    const orders = await Order.find(query)
      .sort({ paidAt: -1, createdAt: -1 }) // Sort by most recent payment/creation
      .skip(skip)
      .limit(limit)
      .lean();

    return {
      orders,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: page
    };
  }
  
  /**
  * @desc 🔑 SAGA PARTICIPANT LOGIC: Executes the final steps of the order.
  * This method is designed to be called **transactionally** by the
  * PaymentService's worker (`executeAtomicOrderUpdate`).
  * @param {string} orderId 
  * @param {string} paymentId 
  * @param {mongoose.ClientSession} session - MUST be passed from the caller.
  * @returns {object} updatedOrder
  */
  static async finalizeOrderTransaction(orderId, paymentId, session) {
    
    // 1. Order Lock & Fetch within the caller's transaction session.
    const order = await Order.findById(orderId).session(session);
    if (!order) throw new NotFoundError(`Order ${orderId} not found.`);
    
    // 2. Idempotency Check (Domain-specific state validation)
    if (order.status === 'PROCESSING' || order.status === 'SHIPPED' || order.paymentStatus === 'paid') {
      // Fire-and-forget logging
      AuditLogger.log({ level: 'WARN', event: 'ORDER_ALREADY_FULFILLED', orderId });
      throw new ConflictError(`Order ${orderId} already finalized or in process.`);
    }

    // 3. Confirm State for Transition (CRITICAL CHECK)
    if (order.status !== 'PAYMENT_PENDING') {
      throw new ConflictError(`Order ${orderId} is in an unexpected state (${order.status}). Cannot finalize.`);
    }

    // 4. SAGA Step 3: Finalize Inventory Deduction
    // NOTE: The caller (PaymentService) is responsible for the overall transaction.
    await InventoryService.deductItems(order.reservationId);
    
    // 5. Atomic Order Status Update (Part of the caller's Transactional Outbox/DB Transaction)
    const finalOrder = await Order.findByIdAndUpdate(orderId, {
      $set: {
        status: 'PROCESSING', // Finalized and ready for fulfillment
        paymentStatus: 'paid',
        paidAt: new Date(),
        paymentId: paymentId,
        expiresAt: null 
      }
    }, { new: true, runValidators: true, session });

    // Fire-and-forget logging
    AuditLogger.log({ level: 'SUCCESS', event: 'ORDER_FINALIZED_PARTICIPANT', orderId });
    
    // 6. Post-Commit Actions (Decoupled Asynchronous Tasks - Transactional Outbox Pattern)
    // 🚨 UPGRADE 2: Use GENERAL_QUEUE_NAME for fulfillment and notification tasks
    await queueJob(GENERAL_QUEUE_NAME, 'fulfillment.start_processing', { orderId: finalOrder._id.toString() });
    await queueJob(GENERAL_QUEUE_NAME, 'notification.send_receipt', { orderId: finalOrder._id.toString(), userId: finalOrder.user.toString() });
    
    return finalOrder.toObject();
  }


  /**
  * @desc Admin function to manually cancel a pending order and release inventory.
  * @param {string} orderId 
  * @param {string} adminUserId 
  * @returns {object} status object
  */
  static async cancelOrder(orderId, adminUserId) {
    const order = await Order.findById(orderId);
    if (!order) throw new NotFoundError(`Order ${orderId} not found.`);

    if (order.status !== 'PAYMENT_PENDING' && order.status !== 'INVENTORY_PENDING' && order.status !== 'FAILED') {
      throw new BadRequestError(`Cannot cancel order in status: ${order.status}`);
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      // 1. Release Inventory Reservation (Saga Compensation)
      if (order.reservationId) {
        await InventoryService.releaseReservation(order.reservationId);
      }
      
      // 2. Atomic Order Status Update
      await Order.findByIdAndUpdate(orderId, {
        $set: {
          status: 'CANCELLED',
          cancellationReason: 'Manual cancellation by admin',
          cancelledBy: adminUserId,
          cancelledAt: new Date(),
          reservationId: null
        }
      }, { session });

      // 3. Commit
      await session.commitTransaction();
      // Fire-and-forget logging
      AuditLogger.log({ level: 'INFO', event: 'ORDER_CANCELLED', orderId, adminUserId });

      return { success: true, message: `Order ${orderId} cancelled and inventory released.` };
      
    } catch (error) {
      await session.abortTransaction();
      logger.error(`Failed to cancel order ${orderId}: ${error.message}`);
      throw new InternalServerError(`Failed to complete order cancellation: ${error.message}`);
    } finally {
      session.endSession();
    }
  }

  /**
  * @desc 🛡️ EXPOSE: Helper for PaymentService to trigger the finalization logic.
  * This is the only exposed transactional helper.
  */
  static get finalizationParticipant() {
    return OrderService.finalizeOrderTransaction;
  }
}

module.exports = OrderService;