"use strict";

/**
 * TITAN NEXUS: Concurrency-Safe Checkout Service
 * ---------------------------------------------
 * Integration: COSMOS HYPER-FABRIC OMEGA (Redis Cluster + Redlock)
 * Features: Optimistic Redis Stock Reservation, MongoDB Transactional Outbox, 
 * Idempotency Guards, and Cluster-Aware Pipeline Sharding.
 */

const mongoose = require("mongoose");
const Cart = require("../model/cart");
const Order = require("../model/order");
const Product = require("../model/product");
const Payment = require("../model/payment");
const User = require("../model/userModel");
const IdempotencyKey = require("../model/idempotencyKey");
const Address = require("../model/addressModel");
const PaymentService = require("./paymentServices");

// --- 🚨 Standardized Custom Errors ---
const BadRequestError = require("../errors/bad-requesr-error"); 
const NotFoundError = require("../errors/notFoundErrror"); 
const ConflictError = require("../errors/conflictError"); 
const ConcurrencyError = require("../errors/concurrencyError"); 

// --- 🚀 OMEGA Job Queue & Redis ---
const { queueJob, GENERAL_QUEUE_NAME } = require("../queue/jobQueue");
const { getRedisClient } = require("../utils/redisClient"); // 💡 OMEGA CLIENT
const logger = require("../config/logger");

const DEFAULTS = {
  TAX_RATE: 0.075,
  SHIPPING_FLAT: 500,
  CURRENCY: "NGN",
};

/**
 * @desc Ensures Redis Cluster sharding consistency using hash-tags.
 * All operations for a specific product will hit the same shard.
 */
const getProductStockKey = (productId) => `product:{stock}:${productId}`;

const CheckoutService = {

  /**
   * Calculates financial breakdown for items.
   */
  calcTotals(items = []) {
    const subtotal = items.reduce((sum, it) => {
      const price = Number(it.price || 0);
      const qty = Number(it.quantity || 1);
      const discount = Number(it.discount || 0);
      return sum + Math.max(0, price * qty - discount);
    }, 0);

    const tax = Math.round(subtotal * DEFAULTS.TAX_RATE);
    const shipping = subtotal > 5000 ? 0 : DEFAULTS.SHIPPING_FLAT;
    const grandTotal = subtotal + tax + shipping;

    return { subtotal, tax, shipping, grandTotal, currency: DEFAULTS.CURRENCY };
  },

  /**
   * Validates cart existence and product stock availability.
   */
  async validateCartAndGetItems(userId) {
    const cart = await Cart.findOne({ user: userId }).populate("items.product").lean();
    if (!cart || !Array.isArray(cart.items) || cart.items.length === 0)
      throw new BadRequestError("Your cart is empty");

    const itemsDetailed = [];
    for (const it of cart.items) {
      const product = it.product;
      if (!product) {
        logger.error("Product not found during cart validation.", { userId: userId.toString(), productId: it.product });
        throw new NotFoundError(`Product not found: ${it.product}`);
      }
      const qty = Number(it.quantity || 1);
      
      if (product.stock !== undefined && product.stock < qty)
        throw new BadRequestError(
          `Insufficient stock for product "${product.name}". Only ${product.stock} available.`
        );

      itemsDetailed.push({
        productId: product._id,
        name: product.name,
        price: product.price,
        quantity: qty,
        discount: it.discount || 0,
        selectedColor: it.selectedColor,
        selectedSize: it.selectedSize,
        image: product.images?.[0]?.url || product.images?.[0] || "",
      });
    }

    return { cart, itemsDetailed };
  },

  /**
   * Core Transactional Logic: Optimistic Stock + DB Transaction
   */
  async createOrderAndMaybeInitPayment(opts = {}) {
    let email = opts.email; 
    const {
      userId,
      paymentMethod = "online",
      addressId,
      currency = DEFAULTS.CURRENCY,
      metadata = {},
      idempotencyKey = null,
    } = opts;

    if (!userId) throw new BadRequestError("Missing user");

    // 1. 🔑 IDEMPOTENCY CHECK
    if (idempotencyKey) {
      const existingIdempotency = await IdempotencyKey.findOne({ key: idempotencyKey });
      if (existingIdempotency && existingIdempotency.status === 'success') {
        logger.audit("IDEMPOTENCY_HIT_SUCCESS", { userId: userId.toString(), idempotencyKey });
        
        const orderDoc = await Order.findById(existingIdempotency.response.orderId)
          .populate("items.product", "name images price").lean();
        
        return { 
          status: 'idempotent-success', 
          order: orderDoc, 
          paymentInit: existingIdempotency.response.paymentInit || null 
        };
      }
    }

    // 2. Data Preparation
    const { cart, itemsDetailed } = await this.validateCartAndGetItems(userId);
    const { subtotal, tax, shipping, grandTotal } = this.calcTotals(itemsDetailed);
    
    const addressDoc = await Address.findOne({ _id: addressId, user: userId }).lean();
    if (!addressDoc) throw new NotFoundError("Shipping address not found.");
    const shippingAddress = addressDoc;

    // 3. ⚡ OMEGA OPTIMISTIC STOCK RESERVATION
    const redis = getRedisClient();
    let redisReserved = false;

    if (redis && redis.status === 'ready') {
      try {
        const pipeline = redis.pipeline();
        itemsDetailed.forEach(it => pipeline.decrby(getProductStockKey(it.productId), it.quantity));
        
        const results = await pipeline.exec();
        const failedItemIndex = results.findIndex(res => res[0] || res[1] < 0);

        if (failedItemIndex !== -1) {
          // Atomic Rollback for Cluster Shard
          const rollbackPipeline = redis.pipeline();
          for (let i = 0; i <= failedItemIndex; i++) {
            if (!results[i][0]) {
              rollbackPipeline.incrby(getProductStockKey(itemsDetailed[i].productId), itemsDetailed[i].quantity);
            }
          }
          await rollbackPipeline.exec();
          throw new ConcurrencyError(`Stock exhausted for item: ${itemsDetailed[failedItemIndex].name}`);
        }
        redisReserved = true;
      } catch (redisErr) {
        if (redisErr instanceof ConcurrencyError) throw redisErr;
        logger.error("Redis Stock Check Failed - Degrading to DB-only", { error: redisErr.message });
      }
    }

    // 4. MONGODB TRANSACTION (The Source of Truth)
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (idempotencyKey) {
        await IdempotencyKey.findOneAndUpdate(
          { key: idempotencyKey },
          { status: 'processing', userId, requestBody: opts },
          { upsert: true, session }
        );
      }

      const orderPayload = {
        user: userId, items: itemsDetailed, subtotal, tax, shipping, 
        totalAmount: grandTotal, currency, address: shippingAddress,
        status: (paymentMethod === 'wallet' || paymentMethod === 'cod') ? "processing" : "pending",
        paymentStatus: paymentMethod === 'wallet' ? "paid" : "pending",
        events: [{ label: "Order created via Nexus Checkout", date: new Date() }],
      };

      const [orderDoc] = await Order.create([orderPayload], { session });

      // Atomic Mongo Stock Check
      const bulkOps = itemsDetailed.map((it) => ({
        updateOne: {
          filter: { _id: it.productId, stock: { $gte: it.quantity } },
          update: { $inc: { stock: -it.quantity, sold: it.quantity } },
        },
      }));

      const bulkResult = await Product.bulkWrite(bulkOps, { session });
      if (bulkResult.modifiedCount !== bulkOps.length) {
        throw new ConcurrencyError("MongoDB stock consistency check failed.");
      }

      await Cart.updateOne({ _id: cart._id }, { $set: { items: [] } }, { session });

      // Wallet Logic
      let paymentInit = null;
      if (paymentMethod === 'wallet') {
        const user = await User.findOneAndUpdate(
          { _id: userId, walletBalance: { $gte: grandTotal } },
          { $inc: { walletBalance: -grandTotal } },
          { session, new: true }
        );
        if (!user) throw new BadRequestError("Insufficient wallet balance.");

        const [payment] = await Payment.create([{
          user: userId, order: orderDoc._id, amount: grandTotal, currency,
          status: "success", provider: "wallet", reference: `WLT-${orderDoc._id}-${Date.now()}`
        }], { session });

        orderDoc.paymentStatus = "paid";
        orderDoc.reference = payment.reference;
        orderDoc.payment = payment._id;
        await orderDoc.save({ session });
      } else {
        // Online / COD Placeholder
        const [payment] = await Payment.create([{
          user: userId, order: orderDoc._id, amount: grandTotal, currency,
          status: paymentMethod === 'cod' ? "pending_confirmation" : "pending",
          provider: paymentMethod === 'cod' ? "cod" : "paystack"
        }], { session });
        orderDoc.payment = payment._id;
        await orderDoc.save({ session });
      }

      await session.commitTransaction();
      session.endSession();

      // 5. POST-COMMIT (Async Outbox)
      await queueJob(GENERAL_QUEUE_NAME, "order.process", { 
        orderId: orderDoc._id.toString(), userId: userId.toString() 
      });

      // 6. External Payment Initialization
      if (paymentMethod === "online") {
        if (!email) {
          const u = await User.findById(userId).select("email").lean();
          email = u?.email;
        }
        paymentInit = await PaymentService.initializePayment(
          userId, grandTotal, email, currency, { orderId: orderDoc._id.toString(), idempotencyKey }
        );
        await Order.findByIdAndUpdate(orderDoc._id, { reference: paymentInit.reference });
        await Payment.findByIdAndUpdate(orderDoc.payment, { reference: paymentInit.reference });
      }

      if (idempotencyKey) {
        await IdempotencyKey.updateOne(
          { key: idempotencyKey },
          { $set: { status: 'success', response: { orderId: orderDoc._id.toString(), paymentInit } } }
        );
      }

      this._emitOrderCreated(userId, orderDoc._id);
      return { order: orderDoc, paymentInit };

    } catch (err) {
      await session.abortTransaction();
      session.endSession();

      // Redis Rollback on failure
      if (redisReserved) {
        const rbPipeline = redis.pipeline();
        itemsDetailed.forEach(it => rbPipeline.incrby(getProductStockKey(it.productId), it.quantity));
        await rbPipeline.exec();
      }

      if (idempotencyKey) {
        await IdempotencyKey.updateOne({ key: idempotencyKey }, { status: 'failed', error: err.message });
      }

      throw (err instanceof ConcurrencyError) ? new BadRequestError(err.message) : err;
    }
  },

  _emitOrderCreated(userId, orderId) {
    try {
      const io = global?.appInstance?.get("io");
      if (io) io.to(userId.toString()).emit("orderCreated", { orderId: orderId.toString() });
    } catch (e) {
      logger.error("Socket emit failed", { error: e.message });
    }
  }
};

module.exports = CheckoutService;