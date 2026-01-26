// services/InventoryService.js

const { StatusCodes } = require("http-status-codes"); 
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid'); 

const Product = require('../model/product');
const InventoryAudit = require('../model/InventoryAudit');
const InventoryReservation = require('../model/inventoryReservation'); 
// const logger = require("../config/logger"); // REMOVED: Replaced by new Logger/Tracing/Metrics
const BadRequestError = require("../errors/bad-request-error");
const NotFoundError = require("../errors/notFoundError");
const InternalServerError = require("../errors/internal-server-error");

// 🚀 TELEMETRY UTILITIES INTEGRATION
const Tracing = require('../utils/tracingClient'); 
const Metrics = require('../utils/metricsClient'); 
const Logger = require('../utils/logger'); 

// 🚨 UPGRADE 1: Import the new Kafka-based message client, including transactional send
const { 
    sendMessage: kafkaSendMessage, 
    sendTransactionalMessages: kafkaSendTransactionalMessages // Used for SAGA event
} = require('./messageBrokerClient'); 

// --- Configuration/Constant ---
const LOW_STOCK_THRESHOLD = 5; 
const INVENTORY_RESERVED_TOPIC = 'order.inventory_reserved'; // Topic for the SAGA step

/**
 * @desc Publishes an alert for a specific product when its stock changes.
 */
const publishIndividualStockAlert = async (product, lowStockThreshold = LOW_STOCK_THRESHOLD) => {
    return Tracing.withSpan("InventoryService:publishIndividualStockAlert", async (span) => {
        span.setAttribute('product.sku', product.sku);
        span.setAttribute('stock.current', product.stock);

        if (product.stock <= lowStockThreshold) {
            const topic = 'inventory.individual_stock_change'; 
            const idempotencyKey = product.sku; 

            const payload = {
                timestamp: new Date().toISOString(),
                productId: product._id,
                currentStock: product.stock,
                threshold: lowStockThreshold,
            };

            try {
                // Use standard Kafka send for non-critical alerts
                await kafkaSendMessage(topic, payload, idempotencyKey); 
                Metrics.increment("alert.low_stock.individual.queued");
                Logger.warn(`[Alert] Individual low stock alert queued (Kafka) for SKU: ${product.sku}`, { sku: product.sku, stock: product.stock });
            } catch (error) {
                Metrics.increment("alert.low_stock.individual.fail");
                Logger.error(`Failed to publish individual stock alert for ${product.sku}:`, { sku: product.sku, error: error.message });
                span.recordException(error);
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: error.message });
            }
        }
    });
};

/**
 * @desc Publishes a job to the dedicated message queue for low stock processing (Bulk Scan).
 */
const publishLowStockAlert = async (threshold = LOW_STOCK_THRESHOLD) => {
    return Tracing.withSpan("InventoryService:publishLowStockAlert", async (span) => {
        const topic = 'inventory.low_stock.alerts'; 
        const idempotencyKey = uuidv4(); 
        span.setAttribute('alert.idempotency_key', idempotencyKey);

        const payload = {
            timestamp: new Date().toISOString(),
            threshold: threshold,
            priority: 'high',
            triggerSource: 'admin_api_bulk_scan',
            idempotencyKey: idempotencyKey, 
        };
        
        try {
            // Use standard Kafka send for bulk jobs
            const queueJobId = await kafkaSendMessage(topic, payload, idempotencyKey);
            Metrics.increment("alert.low_stock.bulk.queued");
            Logger.info(`[BULK SCAN] Low stock alert queued (Kafka) with ID: ${queueJobId}`, { jobId: queueJobId, idempotencyKey });
            return { jobId: queueJobId, idempotencyKey };

        } catch (error) {
            Metrics.increment("alert.low_stock.bulk.fail");
            Logger.critical(`Failed to publish bulk low stock alert to queue '${topic}':`, { topic, error: error.message, err: error });
            span.recordException(error);
            span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: error.message });
            throw new InternalServerError(`Alert system failed to queue job.`);
        }
    });
};


class InventoryService {

    // --- READ OPERATIONS (Reports & Analytics) ---

    /**
     * @desc Generates aggregated inventory reports (CQRS Read Path).
     */
    static async getInventoryReports({ period = '30d', type = 'summary', minStock = 0, limit = 10, page = 1 }) {
        return Tracing.withSpan(`InventoryService:getInventoryReports:${type}`, async (span) => {
            span.setAttribute('report.type', type);

            const skip = (page - 1) * limit;
            const cutoffDate = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)); // Default 30 days

            if (type === 'low_stock') {
                const lowStockProducts = await Product.find({ stock: { $lte: LOW_STOCK_THRESHOLD } })
                    .select('name sku stock price')
                    .sort({ stock: 1 })
                    .skip(skip)
                    .limit(limit)
                    .lean();
                
                const totalCount = await Product.countDocuments({ stock: { $lte: LOW_STOCK_THRESHOLD } });
                
                Metrics.gauge("report.low_stock.count", totalCount);
                Logger.info("INVENTORY_REPORT_GENERATED", { reportType: 'low_stock', count: totalCount });

                return {
                    reportType: 'Low Stock Products',
                    threshold: LOW_STOCK_THRESHOLD,
                    totalCount,
                    page: Number(page),
                    products: lowStockProducts
                };
            }

            if (type === 'activity_summary') {
                const activitySummary = await InventoryAudit.aggregate([
                    { $match: { createdAt: { $gte: cutoffDate } } },
                    {
                        $group: {
                            _id: '$product',
                            sku: { $first: '$sku' },
                            totalIn: { $sum: { $cond: [{ $gt: ['$quantityChange', 0] }, '$quantityChange', 0] } },
                            totalOut: { $sum: { $cond: [{ $lt: ['$quantityChange', 0] }, '$quantityChange', 0] } },
                            lastAction: { $max: '$createdAt' }
                        }
                    },
                    { $sort: { lastAction: -1 } },
                    { $skip: skip },
                    { $limit: limit }
                ]);
                
                Logger.info("INVENTORY_REPORT_GENERATED", { reportType: 'activity_summary', count: activitySummary.length });

                return {
                    reportType: 'Recent Inventory Activity',
                    period: period,
                    activity: activitySummary
                };
            }
            
            Metrics.increment("report.invalid_type");
            throw new BadRequestError(`Invalid report type: ${type}`);
        });
    }


    // --- ADMIN COMMANDS (Single & Bulk Updates) ---

    /**
     * @desc Admin/System command to atomically adjust stock or price (Single Product).
     */
    static async executeAdminStockUpdate(productId, updateData, adminUserId, lowStockThreshold = LOW_STOCK_THRESHOLD) {
        return Tracing.withSpan("InventoryService:executeAdminStockUpdate", async (span) => {
            const { stock, type, reason, referenceId, newPrice } = updateData;
            span.setAttribute('product.id', productId);
            span.setAttribute('update.type', type);
            span.setAttribute('admin.user_id', adminUserId);

            let updateOperation = {};
            let quantityChange = 0;
            let priceBefore = 0;
            
            // 💡 TRANSACTION START
            const session = await mongoose.startSession();
            session.startTransaction();

            try {
                const currentProduct = await Product.findById(productId).session(session).select('stock sku name price').lean();
                if (!currentProduct) throw new NotFoundError(`Product with ID ${productId} not found.`);

                const stockBefore = currentProduct.stock;
                priceBefore = currentProduct.price; 
                
                // ... Stock and Price Update Logic (remains the same)
                let updateSet = newPrice !== undefined ? { price: newPrice } : {};
                
                if (type === 'set') {
                    updateOperation = { $set: { stock: stock, ...updateSet } };
                    quantityChange = stock - stockBefore;
                } else if (type === 'add' || type === 'subtract') {
                    quantityChange = type === 'add' ? stock : -stock;
                    if ((stockBefore + quantityChange) < 0) {
                        Metrics.security("stock_update.negative_attempt");
                        throw new BadRequestError(`Cannot subtract ${stock} units. Only ${stockBefore} units available.`);
                    }
                    updateOperation = { $inc: { stock: quantityChange }, $set: updateSet }; 
                } else if (newPrice !== undefined && (stock === undefined || stock === null)) {
                    updateOperation = { $set: updateSet };
                    quantityChange = 0; 
                } else {
                    throw new BadRequestError(`Invalid update type or missing parameters.`);
                }
                
                // 4. Update Product & Audit Log (Atomic steps)
                const updatedProduct = await Product.findByIdAndUpdate(
                    productId,
                    updateOperation,
                    { new: true, runValidators: true, session } 
                ).select('name sku stock price');
                
                const stockAfter = updatedProduct.stock;
                
                await InventoryAudit.create([{
                    product: updatedProduct._id,
                    sku: updatedProduct.sku,
                    action: type,
                    quantityChange: quantityChange, 
                    stockBefore: stockBefore,
                    stockAfter: stockAfter,
                    priceBefore: priceBefore, 
                    priceAfter: updatedProduct.price, 
                    adminUser: adminUserId,
                    reason: reason,
                    referenceId: referenceId,
                }], { session });

                // 5. TRANSACTION COMMIT
                await session.commitTransaction();
                
                Metrics.increment(`stock_update.success.${type}`);
                
                // 🔑 AUDIT LOG: Crucial for tracking stock changes
                Logger.audit("STOCK_UPDATE_SINGLE", { 
                    entityId: productId, 
                    action: type.toUpperCase(), 
                    adminUserId, 
                    quantityChange, 
                    stockAfter,
                    reason
                });

                // 6. ASYNCHRONOUS ALERT TRIGGER (POST-COMMIT)
                publishIndividualStockAlert(updatedProduct.toObject({ getters: true }), lowStockThreshold);
                
                return { updatedProduct: updatedProduct.toObject({ getters: true }), stockAfter };

            } catch (err) {
                // 7. TRANSACTION ROLLBACK
                await session.abortTransaction();
                Metrics.increment("stock_update.fail");
                Logger.error(`Single stock update failed for ${productId}:`, { productId, type, adminUserId, err: err.message, stack: err.stack });
                span.recordException(err);
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: err.message });
                throw err;
            } finally {
                 session.endSession();
            }
        });
    }
    
    /**
     * @desc BULK COMMAND: Handles a list of stock adjustments efficiently in a single transaction.
     */
    static async adjustStockBulk(updates, adminUserId, bulkReferenceId) {
        return Tracing.withSpan("InventoryService:adjustStockBulk", async (span) => {
            if (!updates || updates.length === 0) throw new BadRequestError("Update list cannot be empty.");
            
            span.setAttribute('admin.user_id', adminUserId);
            span.setAttribute('bulk.reference_id', bulkReferenceId);
            span.setAttribute('bulk.item_count', updates.length);

            const session = await mongoose.startSession();
            session.startTransaction();

            let successfulUpdates = [];
            let failedUpdates = [];
            let auditRecords = [];
            let updatedProductsForAlert = [];

            try {
                for (const item of updates) {
                    const { productId, quantityChange, reason } = item;
                    const change = Number(quantityChange);
                    const action = change >= 0 ? 'add' : 'subtract';

                    try {
                        const currentProduct = await Product.findById(productId).session(session).select('stock sku').lean();
                        if (!currentProduct) {
                            failedUpdates.push({ productId, reason: "Product not found." });
                            continue;
                        }
                        
                        const stockBefore = currentProduct.stock;
                        
                        // ATOMICITY CHECK: Prevent negative stock
                        if ((stockBefore + change) < 0) {
                            failedUpdates.push({ productId, reason: `Insufficient stock (${stockBefore}).` });
                            Metrics.security("stock_update.bulk.negative_skip");
                            continue;
                        }

                        // 1. Update Product
                        const updatedProduct = await Product.findByIdAndUpdate(
                            productId,
                            { $inc: { stock: change } },
                            { new: true, runValidators: true, session }
                        ).select('name sku stock');
                        
                        const stockAfter = updatedProduct.stock;
                        
                        // 2. Prepare Audit Log
                        auditRecords.push({
                            product: updatedProduct._id,
                            sku: updatedProduct.sku,
                            action: action,
                            quantityChange: change, 
                            stockBefore: stockBefore,
                            stockAfter: stockAfter,
                            adminUser: adminUserId,
                            reason: reason || `Bulk Adjustment: ${bulkReferenceId}`,
                            referenceId: bulkReferenceId,
                        });

                        successfulUpdates.push({ productId, stockAfter });
                        updatedProductsForAlert.push(updatedProduct.toObject({ getters: true }));

                    } catch (productErr) {
                        failedUpdates.push({ productId, reason: productErr.message });
                        Metrics.increment("stock_update.bulk.item_fail");
                        Logger.warn("BULK_UPDATE_ITEM_FAILED", { productId, reason: productErr.message });
                    }
                }

                // 3. Create ALL Audit Logs in one go
                if (auditRecords.length > 0) {
                    await InventoryAudit.create(auditRecords, { session });
                }

                // 4. TRANSACTION COMMIT (Only commits successful, audited updates)
                await session.commitTransaction();
                Metrics.increment("stock_update.bulk.success");
                
                // 🔑 AUDIT LOG: Bulk update summary
                Logger.audit("STOCK_UPDATE_BULK_COMMIT", { 
                    entityId: bulkReferenceId, 
                    action: 'BULK_UPDATE', 
                    adminUserId, 
                    successfulCount: successfulUpdates.length,
                    failedCount: failedUpdates.length
                });

                // 5. ASYNCHRONOUS ALERTS (Post-Commit)
                updatedProductsForAlert.forEach(p => publishIndividualStockAlert(p));

                return {
                    message: `Bulk update complete. ${successfulUpdates.length} successful, ${failedUpdates.length} failed.`,
                    successfulUpdates,
                    failedUpdates,
                };

            } catch (err) {
                await session.abortTransaction();
                Metrics.increment("stock_update.bulk.transaction_fail");
                Logger.critical(`Bulk update failed due to critical transaction error: ${err.message}`, { bulkReferenceId, err: err.message });
                span.recordException(err);
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: err.message });
                throw new InternalServerError(`Bulk update failed due to critical transaction error: ${err.message}`);
            } finally {
                 session.endSession();
            }
        });
    }

    // --- CORE ORDER FLOW INTEGRATION (Saga Steps) ---

    /**
     * @desc SAGA STEP 1: Reserves items, decrementing 'available stock' and creating a Reservation document.
     */
    static async reserveItems(items, orderId) {
        return Tracing.withSpan("InventoryService:reserveItems", async (span) => {
            if (!items || !items.length) throw new BadRequestError("Items list required for reservation.");
            
            span.setAttribute('order.id', orderId);
            span.setAttribute('items.count', items.length);

            const reservationId = uuidv4();
            const session = await mongoose.startSession();
            session.startTransaction();

            try {
                let totalReservedCount = 0;
                const reservationDetails = [];
                const lowStockAlerts = [];

                for (const item of items) {
                    const { productId, quantity } = item;
                    if (quantity <= 0) continue;

                    // 🌟 ATOMIC DEDUCTION CHECK: Decrement the stock atomically
                    const updatedProduct = await Product.findOneAndUpdate(
                        { _id: productId, stock: { $gte: quantity } }, 
                        { $inc: { stock: -quantity } },
                        { new: true, runValidators: true, session }
                    ).select('stock sku name');

                    if (!updatedProduct) {
                        Metrics.security("reservation.fail.insufficient_stock");
                        // Abort the entire transaction immediately on failure
                        const productCheck = await Product.findById(productId).session(session).select('stock');
                        const errorMsg = productCheck 
                            ? `Insufficient stock for ID ${productId}. Available: ${productCheck.stock}. Required: ${quantity}.`
                            : `Product ID ${productId} not found.`;
                        throw new BadRequestError(errorMsg); 
                    }

                    reservationDetails.push({ 
                        productId, 
                        sku: updatedProduct.sku, 
                        quantity, 
                        stockAfterReservation: updatedProduct.stock 
                    });
                    totalReservedCount += quantity;
                    
                    if (updatedProduct.stock <= LOW_STOCK_THRESHOLD) {
                        lowStockAlerts.push(updatedProduct.toObject({ getters: true }));
                    }
                }

                // 2. Create Reservation Record (Transactional)
                await InventoryReservation.create([{
                    _id: reservationId,
                    orderId: orderId, 
                    status: 'RESERVED',
                    items: reservationDetails,
                    createdAt: new Date(),
                }], { session });

                // 3. COMMIT MongoDB Transaction (Stock updated, Reservation created)
                await session.commitTransaction();
                session.endSession();
                
                Metrics.increment("reservation.success", 1, { count: totalReservedCount });
                
                // 🔑 AUDIT LOG: Inventory Reserved event
                Logger.audit("INVENTORY_RESERVED", { 
                    entityId: orderId, 
                    action: 'RESERVE', 
                    reservationId, 
                    itemsCount: totalReservedCount,
                    reservationDetails
                });
                
                // 🚨 UPGRADE 2: Use Transactional Send for SAGA Event (POST-COMMIT)
                const sagaEventPayload = {
                    eventType: 'InventoryReserved',
                    reservationId: reservationId,
                    orderId: orderId,
                    itemsReserved: totalReservedCount,
                    reservationDetails: reservationDetails,
                    timestamp: new Date().toISOString(),
                };
                
                await kafkaSendTransactionalMessages(
                    INVENTORY_RESERVED_TOPIC, 
                    [sagaEventPayload], // Wrap in array for the transactional method
                    orderId // Use Order ID as the transaction ID for tracing
                );

                Logger.info(`[RESERVATION] Success for Order ${orderId}. SAGA event sent transactionally.`, { reservationId, orderId });
                
                // ASYNC: Trigger low stock alerts for affected products
                lowStockAlerts.forEach(p => publishIndividualStockAlert(p));
                
                return reservationId; 

            } catch (err) {
                // Rollback MongoDB transaction
                await session.abortTransaction();
                session.endSession();
                
                Metrics.increment("reservation.fail.transaction");
                Logger.error(`[RESERVATION FAIL] Order ${orderId} failed during stock reservation or transactional event send:`, { orderId, err: err.message, stack: err.stack });
                span.recordException(err);
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: err.message });
                
                // Must not be caught by caller, only thrown if reservation failed
                throw err; 
            }
        });
    }

    /**
     * @desc SAGA COMPENSATION: Releases a reservation (triggered by failed payment/order commit).
     */
    static async releaseReservation(reservationId) {
        return Tracing.withSpan("InventoryService:releaseReservation", async (span) => {
            if (!reservationId) return;
            span.setAttribute('reservation.id', reservationId);

            // 1. Find Reservation Record and mark it 'RELEASED'
            const reservation = await InventoryReservation.findOneAndUpdate(
                { _id: reservationId, status: { $in: ['RESERVED', 'PENDING'] } },
                { $set: { status: 'RELEASED', releasedAt: new Date() } },
                { new: true }
            );

            if (!reservation) {
                Metrics.increment("reservation.release.skip");
                Logger.warn(`[COMPENSATION FAIL] Reservation ${reservationId} not found or already processed.`, { reservationId });
                return;
            }

            // 2. Perform Stock Reversal (Atomically ADD stock back)
            const session = await mongoose.startSession();
            session.startTransaction();

            try {
                for (const item of reservation.items) {
                    // Get current product stock for accurate audit log (stockAfterReservation is pre-deduction)
                    const productBeforeUpdate = await Product.findById(item.productId).session(session).select('stock').lean();
                    
                    await Product.findByIdAndUpdate(
                        item.productId,
                        { $inc: { stock: item.quantity } },
                        { session }
                    );
                    
                    const productAfterUpdate = await Product.findById(item.productId).session(session).select('stock');

                    // Audit Log for Compensation
                    await InventoryAudit.create([{
                        product: item.productId, sku: item.sku, action: 'add',
                        quantityChange: item.quantity, 
                        stockBefore: productBeforeUpdate.stock, // Accurate stock before release
                        stockAfter: productAfterUpdate.stock,
                        adminUser: 'SYSTEM_COMPENSATION', reason: 'Order Failure/Cancellation',
                        referenceId: reservation.orderId,
                    }], { session });
                }
                
                await session.commitTransaction();
                Metrics.increment("reservation.release.success", 1, { items: reservation.items.length });
                Logger.warn(`[COMPENSATION SUCCESS] Stock for Reservation ${reservationId} successfully released.`, { reservationId, orderId: reservation.orderId });
                
                // 🔑 AUDIT LOG: Reservation released
                Logger.audit("INVENTORY_RELEASED", { 
                    entityId: reservation.orderId, 
                    action: 'RELEASE_COMPENSATION', 
                    reservationId, 
                    itemsCount: reservation.items.length
                });

            } catch (err) {
                await session.abortTransaction();
                Metrics.critical("reservation.release.transaction_fail");
                Logger.critical(`[CRITICAL] Failed to reverse stock for Reservation ${reservationId}. Manual fix required!`, { reservationId, err: err.message, stack: err.stack });
                span.recordException(err);
                span.setStatus({ code: Tracing.SpanStatusCode.ERROR, message: 'Compensation failed, manual intervention needed.' });
                throw new InternalServerError(`Failed to finalize stock release for reservation ${reservationId}.`); 
            } finally {
                session.endSession();
            }
        });
    }

    /**
     * @desc SAGA DEDUCTION: Finalizes a reservation (triggered by successful OrderService commit).
     */
    static async deductItems(reservationId) {
        return Tracing.withSpan("InventoryService:deductItems", async (span) => {
            if (!reservationId) return;
            span.setAttribute('reservation.id', reservationId);
            
            // Find Reservation and mark it 'FULFILLED'
            const reservation = await InventoryReservation.findOneAndUpdate(
                { _id: reservationId, status: 'RESERVED' },
                { $set: { status: 'FULFILLED', fulfilledAt: new Date() } }
            );

            if (!reservation) {
                Metrics.increment("reservation.deduction.skip");
                Logger.warn(`[FULFILLMENT FAIL] Reservation ${reservationId} not found or not in RESERVED state.`, { reservationId });
                return;
            }

            Metrics.increment("reservation.deduction.success");
            Logger.info(`[FULFILLMENT SUCCESS] Reservation ${reservationId} finalized and fulfilled.`, { reservationId, orderId: reservation.orderId });
            
            // 🔑 AUDIT LOG: Reservation fulfilled
            Logger.audit("INVENTORY_FULFILLED", { 
                entityId: reservation.orderId, 
                action: 'FULFILL_DEDUCTION', 
                reservationId, 
                itemsCount: reservation.items.length
            });

            // ASYNC: Dispatch Stock Change Event (for internal systems, dashboards, etc.)
            for (const item of reservation.items) {
                const product = await Product.findById(item.productId).select('stock name sku').lean();
                if (product) {
                    publishIndividualStockAlert(product); 
                }
            }
        });
    }
}

module.exports = {
    InventoryService,
    publishLowStockAlert,
    LOW_STOCK_THRESHOLD
};