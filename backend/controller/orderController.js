// controllers/orderController.js

const OrderService = require('../services/orderService');
const logger = require("../config/logger"); 

// --- Errors ---
const NotFoundError = require("../errors/notFoundError");
const BadRequestError = require("../errors/bad-request-error");
const InternalServerError = require("../errors/internal-server-error");
const DomainError = require('../errors/domainError'); // For specific Saga failures
const ConflictError = require('../errors/conflictError'); 


/**
 * @desc Creates a new order from the user's cart and initiates the payment process (SAGA Orchestrator).
 * @route POST /api/v1/orders/checkout
 * @access Private (Requires User Auth Middleware)
 */
exports.createOrder = async (req, res, next) => {
    try {
        // NOTE: userId should be attached to req.user by an authentication middleware
        const userId = req.user.id; 
        const { shippingInfo } = req.body;

        if (!shippingInfo || !shippingInfo.address || !shippingInfo.city) {
            return res.status(400).json({ 
                success: false, 
                message: "Invalid input: Shipping information is required." 
            });
        }
        
        // --- Call the SAGA Orchestrator in OrderService ---
        const result = await OrderService.createOrderFromCart(userId, shippingInfo);

        // The checkout is successful, but the payment is pending.
        // Return 202 Accepted, and provide the redirection URL.
        res.status(202).json({
            success: true,
            message: "Order initiated and inventory reserved. Proceed to payment.",
            data: {
                orderId: result.order._id,
                totalAmount: result.order.totalAmount,
                paymentAuthorizationUrl: result.paymentAuthorizationUrl 
            }
        });

    } catch (error) {
        logger.error(`[OrderController] createOrder failed: ${error.message}`, { error });
        
        // Map specific domain/application errors to HTTP codes
        if (error instanceof NotFoundError || error instanceof BadRequestError || error instanceof ConflictError || error instanceof DomainError) {
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }

        // Catch-all for unexpected failures (e.g., external service timeouts, DB issues)
        next(new InternalServerError("Failed to complete checkout process. Please try again."));
    }
};

/**
 * @desc Retrieves the details of a specific order.
 * @route GET /api/v1/orders/:orderId
 * @access Private (Requires User or Admin Auth Middleware)
 */
exports.getOrderDetails = async (req, res, next) => {
    try {
        const { orderId } = req.params;
        const userId = req.user.id; // For authorization check

        // In a real application, the service method would include an authorization check:
        // const order = await OrderService.getByIdAndUser(orderId, userId);
        
        // Simplified fetch for demonstration
        const order = await OrderService.findById(orderId);

        if (!order) {
            throw new NotFoundError(`Order with ID ${orderId} not found.`);
        }
        
        // Basic authorization check (User can only view their own orders)
        if (order.user.toString() !== userId && req.user.role !== 'admin') {
             return res.status(403).json({ success: false, message: "Forbidden: You do not have access to this order." });
        }

        res.status(200).json({
            success: true,
            data: order
        });

    } catch (error) {
        if (error instanceof NotFoundError) {
            return res.status(404).json({ success: false, message: error.message });
        }
        next(new InternalServerError("Could not retrieve order details."));
    }
};

/**
 * @desc Cancels a pending order (e.g., by Admin or User within a time limit).
 * @route PUT /api/v1/orders/:orderId/cancel
 * @access Private/Admin
 */
exports.cancelOrder = async (req, res, next) => {
    try {
        const { orderId } = req.params;
        const adminUserId = req.user.id; // Assuming only admins or the user can call this, using current user ID

        // This action uses the OrderService's robust transactional cancellation logic
        const result = await OrderService.cancelOrder(orderId, adminUserId);

        res.status(200).json({
            success: true,
            message: result.message
        });

    } catch (error) {
        logger.error(`[OrderController] cancelOrder failed: ${error.message}`, { error });
        
        if (error instanceof NotFoundError) {
            return res.status(404).json({ success: false, message: error.message });
        }
        if (error instanceof BadRequestError) {
            return res.status(400).json({ success: false, message: error.message });
        }
        next(new InternalServerError("Failed to cancel order."));
    }
};

/**
 * @desc Retrieves a paginated list of all orders for the authenticated user, with filters.
 * @route GET /api/v1/orders?page=1&limit=10&paymentStatus=paid&orderStatus=processing
 * @access Private (Requires User Auth Middleware)
 */
exports.getUserOrders = async (req, res, next) => {
    try {
        const userId = req.user.id;
        
        // Pagination
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        // New Filters
        const paymentStatusFilter = req.query.paymentStatus;
        const orderStatusFilter = req.query.orderStatus;

        if (page < 1 || limit < 1) {
            throw new BadRequestError("Page and limit parameters must be positive integers.");
        }

        // --- DELEGATE TO SERVICE METHOD WITH FILTERS ---
        const result = await OrderService.getUserOrders(
            userId, 
            page, 
            limit, 
            paymentStatusFilter, 
            orderStatusFilter
        );

        res.status(200).json({
            success: true,
            message: "User orders retrieved successfully.",
            ...result 
        });

    } catch (error) {
        logger.error(`[OrderController] getUserOrders failed for user ${req.user.id}: ${error.message}`, { error });
        
        if (error instanceof BadRequestError) {
            // Catches invalid pagination inputs AND invalid status filter inputs from the service layer
            return res.status(400).json({ success: false, message: error.message });
        }
        
        next(new InternalServerError("Failed to retrieve user's order history."));
    }
};