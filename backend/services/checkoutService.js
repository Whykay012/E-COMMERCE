// services/checkoutService.js (TITAN NEXUS: Concurrency Layer)

const mongoose = require("mongoose");
const Cart = require("../model/cart");
const Order = require("../model/order");
const Product = require("../model/product");
const Payment = require("../model/payment");
const User = require("../model/userModel");
const IdempotencyKey = require("../model/idempotencyKey");
const Address = require("../model/addressModel");
const PaymentService = require("./paymentServices");
// --- 🚨 CORRECTION: Use standard error names from customErrors.js ---
const BadRequestError  = require("../errors/bad-requesr-error"); // Corrected import
const NotFoundError  = require("../errors/notFoundErrror"); // Corrected import
const ConflictError  = require("../errors/conflictError"); // Corrected import
const ConcurrencyError = require("../errors/concurrencyError"); // Assumed correct import

// --- 🚀 UPGRADE: Import queue names ---
const { queueJob, GENERAL_QUEUE_NAME } = require("../queue/jobQueue");
const logger = require("../config/logger"); // 💡 Unified Logger Import

// 🔑 ASSUMPTION: Global Redis Client (redisClient is the real instance)
const redisClient = global.redisClient;

const DEFAULTS = {
 TAX_RATE: 0.075,
 SHIPPING_FLAT: 500,
 CURRENCY: "NGN",
};

// Key format for Redis stock cache
const getProductStockKey = (productId) => `product:stock:${productId}`;

const CheckoutService = {
 // ... calcTotals (unchanged)
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

 // -------------------------------------------------------------
 // 🔑 CORE TRANSACTIONAL LOGIC
 // -------------------------------------------------------------
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

  // 1. 🔑 IDEMPOTENCY CHECK (CRITICAL START)
  if (idempotencyKey) {
   const existingIdempotency = await IdempotencyKey.findOne({ key: idempotencyKey });
   if (existingIdempotency) {
    if (existingIdempotency.status === 'success') {
     // 💡 AUDIT LOG: Successful Idempotency hit
     logger.audit("IDEMPOTENCY_HIT_SUCCESS", { 
      userId: userId.toString(), 
      entityId: existingIdempotency.response.orderId, 
      action: "order_reuse", 
      idempotencyKey 
     });
     
     const orderDoc = await Order.findById(existingIdempotency.response.orderId)
      .populate("items.product", "name images price")
      .lean();
     
     return { 
      status: 'idempotent-success', 
      order: orderDoc, 
      paymentInit: existingIdempotency.response.paymentInit || null 
     };
    }
   }
  }

  // 2. Validate cart, items, and Address
  const { cart, itemsDetailed } = await this.validateCartAndGetItems(userId);
  const { subtotal, tax, shipping, grandTotal } = this.calcTotals(itemsDetailed);
  
  let shippingAddress = {};
  if (addressId) {
   const addressDoc = await Address.findOne({ _id: addressId, user: userId }).lean();
   if (!addressDoc) {
    logger.warn("Address not found for user.", { userId: userId.toString(), addressId });
    throw new NotFoundError("Shipping address not found or does not belong to user.");
   }
   shippingAddress = addressDoc;
  } else {
   throw new BadRequestError("Shipping address ID is required.");
  }

  // 2.5. ⚡ OPTIMISTIC STOCK RESERVATION (High-Concurrency Caching)
  // 
  let redisReserved = false;
  if (!redisClient || redisClient.status !== 'ready') {
   logger.warn("Redis client not available/ready. Skipping optimistic stock reservation."); 
  } else {
   try {
    // Use Redis Pipeline for atomic multi-decrement
    const pipeline = redisClient.pipeline();
    
    // Queue all DECRBY commands
    itemsDetailed.forEach(it => 
     pipeline.decrBy(getProductStockKey(it.productId), it.quantity)
    );
    
    // Execute pipeline
    const results = await pipeline.exec();
    
    const failedItemIndex = results.findIndex(res => {
     // Check for error (res[0]) or negative result (res[1] < 0)
     return res[0] || res[1] < 0; 
    });

    if (failedItemIndex !== -1) {
     // One or more decrements resulted in insufficient stock or an error.
     // Rollback all previous successful decrements
     const rollbackPipeline = redisClient.pipeline();
     
     for (let i = 0; i <= failedItemIndex; i++) {
      if (!results[i][0]) {
       const item = itemsDetailed[i];
       rollbackPipeline.incrBy(getProductStockKey(item.productId), item.quantity);
      }
     }
     
     // 💡 AUDIT LOG: Redis stock rollback attempt before DB transaction
     await rollbackPipeline.exec().catch(rollbackErr => 
      logger.critical("Redis Rollback FAILED after optimistic reserve failure (potential data loss).", { // 🚨 Use critical for rollback failure
       userId: userId.toString(), 
       message: rollbackErr.message, 
       stockOp: "optimistic_reserve_fail",
      }) 
     ); 
     
     const failureItem = itemsDetailed[failedItemIndex];
     // Using ConcurrencyError for clarity
     throw new ConcurrencyError(`Stock reservation failed for product ${failureItem.productId}. Item is likely out of stock.`);
    }
    
    redisReserved = true;
    logger.info("Redis optimistic stock reserved successfully.", { userId: userId.toString(), items: itemsDetailed.length });
    
   } catch (redisErr) {
    if (redisErr instanceof ConcurrencyError) {
     throw new BadRequestError(redisErr.message);
    }
    // 🚨 Use logger.error for unexpected Redis check failure
    logger.error("Redis stock check failed. Falling back to MongoDB transaction.", { userId: userId.toString(), message: redisErr.message });
   }
  }
  
  // 3. TRANSACTION START: Create order, reserve stock, clear cart
  const session = await mongoose.startSession();
  session.startTransaction();
  // 

  try {
   // 🔑 Set Idempotency Key status to processing *within* the transaction
   if (idempotencyKey) {
    await IdempotencyKey.findOneAndUpdate(
     { key: idempotencyKey },
     { key: idempotencyKey, status: 'processing', userId, requestBody: opts },
     { upsert: true, new: true, session }
    );
   }
   
   // A. Create Order Payload
   const isCod = paymentMethod === 'cod';
   const isWallet = paymentMethod === 'wallet';
   
   const initialStatus = (isWallet || isCod) ? "processing" : "pending";
   const initialPaymentStatus = isWallet ? "paid" : "pending";
   
   const orderPayload = {
    user: userId, items: itemsDetailed,
    subtotal, tax, shipping, totalAmount: grandTotal, currency,
    paymentStatus: initialPaymentStatus, status: initialStatus,
    address: shippingAddress, events: [{ label: "Order created", date: new Date() }],
    reference: null,
   };
   const orderDoc = (await Order.create([orderPayload], { session }))[0];
   
   // 💡 AUDIT LOG: Order created
   logger.audit("ORDER_CREATE_START", {
    userId: userId.toString(),
    entityId: orderDoc._id.toString(),
    action: "order_created",
    amount: grandTotal,
    itemCount: itemsDetailed.length,
   });


   // B. Reserve Stock & Increment Sold (Atomic check and update - FINAL AUTHORITY)
   // This uses MongoDB's write concurrency to ensure stock > quantity is met.
   const bulkOps = itemsDetailed.map((it) => ({
    updateOne: {
     filter: { _id: it.productId, stock: { $gte: it.quantity } },
     update: { $inc: { stock: -it.quantity, sold: it.quantity } },
    },
   }));

   if (bulkOps.length) {
    const bulkResult = await Product.bulkWrite(bulkOps, { session });
    if (bulkResult.modifiedCount !== bulkOps.length) {
     // This means MongoDB's final stock check failed.
     logger.error("MONGO_STOCK_FAIL", { userId: userId.toString(), orderId: orderDoc._id.toString() });
     throw new ConcurrencyError("Stock reservation failed due to concurrency (insufficient stock in MongoDB).");
    }
   }
   logger.info("MongoDB stock reserved successfully.", { orderId: orderDoc._id.toString() });


   // C. Clear Cart
   await Cart.updateOne({ _id: cart._id }, { $set: { items: [] } }, { session });
   logger.audit("CART_CLEARED", {
    userId: userId.toString(),
    entityId: orderDoc._id.toString(),
    action: "cart_cleared",
   });


   let finalOrderDoc = orderDoc;
   let paymentInit = null;

   // D. Wallet Payment Handling 
   if (isWallet) {
    const user = await User.findOneAndUpdate(
     { _id: userId, walletBalance: { $gte: grandTotal } },
     { $inc: { walletBalance: -grandTotal } },
     { session, new: true }
    );
    if (!user) {
     logger.security("WALLET_DEDUCTION_FAILED", {
      userId: userId.toString(),
      eventCode: "INSUFFICIENT_FUNDS",
      balanceCheck: "fail",
      amount: grandTotal
     });
     throw new BadRequestError("Insufficient wallet balance");
    }
    
    // 💡 AUDIT LOG: Wallet deduction success
    logger.audit("WALLET_DEDUCTION_SUCCESS", {
     userId: userId.toString(),
     entityId: orderDoc._id.toString(),
     action: "wallet_deduct",
     amount: grandTotal
    });

    const payment = (await Payment.create([{
     user: userId, order: orderDoc._id, amount: grandTotal, currency,
     status: "success", provider: "wallet",
     reference: `WALLET-${orderDoc._id}-${Date.now()}`, metadata,
    }], { session }))[0];

    finalOrderDoc.paymentStatus = "paid";
    finalOrderDoc.reference = payment.reference;
    finalOrderDoc.payment = payment._id;
    finalOrderDoc.events.push({ label: "Wallet payment applied", date: new Date() });
    await finalOrderDoc.save({ session }); 
   }

   // E. Online/COD Payment: Create Payment placeholder 
   if (!isWallet) {
    const paymentProvider = isCod ? "cod" : "paystack";
    const payment = (await Payment.create([{
     user: userId, order: orderDoc._id, amount: grandTotal, currency,
     status: isCod ? "pending_confirmation" : "pending",
     provider: paymentProvider, reference: null, 
     metadata: { orderId: orderDoc._id.toString(), ...metadata, idempotencyKey },
    }], { session }))[0];

    finalOrderDoc.payment = payment._id;
    await finalOrderDoc.save({ session });
   }

   // F. Commit Transaction
   await session.commitTransaction();
   session.endSession();
   logger.audit("ORDER_TRANSACTION_COMMITTED", {
    userId: userId.toString(),
    entityId: finalOrderDoc._id.toString(),
    action: "commit_success",
   });

   // -----------------------------------------------------------------
   // G. POST-COMMIT ASYNCHRONOUS TASKS (BullMQ - Transactional Outbox)
   // -----------------------------------------------------------------
   
   const jobPayload = { 
    orderId: finalOrderDoc._id.toString(), 
    userId: userId.toString(), 
    paymentId: finalOrderDoc.payment.toString() 
   };
   
   // 🚨 REQUIRED UPGRADE: Pass GENERAL_QUEUE_NAME as the first argument
   await queueJob(GENERAL_QUEUE_NAME, "order.process", jobPayload); 
   this._emitOrderCreated(userId, finalOrderDoc._id); 

   // H. Initialize External Payment (If Online)
   if (paymentMethod === "online") {
    if (!email) {
     const u = await User.findById(userId).select("email").lean();
     if (u?.email) email = u.email;
    }
    
    if (!email) {
     logger.warn("Cannot initialize payment without user email.", { userId: userId.toString() });
    }

    paymentInit = await PaymentService.initializePayment(
     userId, grandTotal, email, currency,
     { orderId: finalOrderDoc._id.toString(), idempotencyKey }
    );

    await Order.findByIdAndUpdate(finalOrderDoc._id, { reference: paymentInit.reference });
    await Payment.findByIdAndUpdate(finalOrderDoc.payment, { reference: paymentInit.reference });
   }

   // I. Update Idempotency status
   if (idempotencyKey) {
    await IdempotencyKey.updateOne(
     { key: idempotencyKey },
     { $set: { 
      status: 'success', 
      response: { orderId: finalOrderDoc._id.toString(), paymentInit: paymentInit || null } 
     }}
    );
   }

   const populated = await Order.findById(finalOrderDoc._id).populate("items.product", "name images price").lean();
   return { order: populated, paymentInit: paymentInit };

  } catch (err) {
   // 4. TRANSACTION ROLLBACK & ERROR HANDLING
   try {
    await session.abortTransaction();
    
    // 💡 AUDIT LOG: Transaction failed and aborted
    logger.error("ORDER_TRANSACTION_ABORTED", {
     userId: userId.toString(),
     action: "abort_fail",
     errorName: err.name,
     message: err.message
    });
    
    // If Redis reserved stock successfully, but MongoDB failed, execute Redis Rollback
    if (redisReserved && redisClient && redisClient.status === 'ready') {
     const rollbackPipeline = redisClient.pipeline();
     itemsDetailed.forEach(it => {
       rollbackPipeline.incrBy(getProductStockKey(it.productId), it.quantity)
     });
     await rollbackPipeline.exec().catch(rollbackErr => 
      logger.critical("Redis Rollback FAILED after DB transaction abort (potential data loss).", { // 🚨 Use critical for rollback failure
       userId: userId.toString(), 
       message: rollbackErr.message, 
       stockOp: "mongo_fail_post_abort",
      })
     );
    }

    // Update Idempotency status
    if (idempotencyKey) {
     await IdempotencyKey.updateOne({ key: idempotencyKey }, { $set: { status: 'failed', error: err.message } });
    }
   } catch (_) { 
    /* ignore abort/redis error - The original error should still be thrown */ 
   }
   session.endSession();

   if (err instanceof ConcurrencyError) {
    // Return a client-friendly message
    throw new BadRequestError("One or more items went out of stock during checkout. Please review your cart."); 
   }
   // Throw the original, detailed error for upstream handler
   throw err;
  }
 },
 
 _emitOrderCreated(userId, orderId) {
  try {
   const io = (global?.appInstance && global.appInstance.get("io")) || null;
   if (io)
    io.to(userId.toString()).emit("orderCreated", { orderId: orderId.toString() });
  } catch (emitErr) {
   // 🚨 Use logger.error for socket failures
   logger.error("Socket emit failed: Failed to notify user of order creation.", { 
    userId: userId.toString(), 
    orderId: orderId.toString(), 
    message: emitErr.message 
   }); 
  }
 }
};

module.exports = CheckoutService;