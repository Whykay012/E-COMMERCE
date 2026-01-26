// controllers/checkoutController.js

const CheckoutService = require("../services/checkoutService");
const { StatusCodes } = require("http-status-codes");
const BadRequestError = require("../errors/bad-request-error");
const UnauthorizedError = require("../errors/unauthorized-error");
const TooManyRequestsError = require("../errors/too-many-requests-error");
const ConcurrencyError = require("../errors/concurrencyError"); 

// --- Utility/Middleware Placeholders ---
// NOTE: Assuming these are imported from a central utilities file in a real application.
const asyncHandler = (fn) => (req, res, next) => {
    // Allows Express to automatically catch async errors and pass them to the error middleware
    Promise.resolve(fn(req, res, next)).catch(next);
}; 

// --- Constants ---
const IDEMPOTENCY_HEADER = 'x-idempotency-key'; 
const VALID_PAYMENT_METHODS = ["online", "wallet", "cod"];

// --- Helper Functions ---

/**
 * Utility to reliably extract the authenticated user's ID.
 * @param {object} user - The user object from the request, populated by auth middleware.
 * @returns {string} The unique user ID.
 */
const getUserId = (user) => {
    const userId = user?.userID || user?._id || user?.id;
    if (!userId) {
        // This should ideally be caught by a dedicated Auth Middleware, but kept here for safety.
        throw new UnauthorizedError("Authentication failed: User ID is missing from token.");
    }
    return userId.toString(); 
};

// -----------------------------------------------------------------
// 💳 CORE CHECKOUT HANDLER
// -----------------------------------------------------------------

/**
 * @desc Creates a new order and handles payment initialization.
 * @route POST /api/v1/checkout
 * @access Private (Authenticated User)
 * * 💡 The Controller's main job is to validate input, enforce mandatory headers,
 * and translate Service errors/results into HTTP responses.
 */
const createCheckoutHandler = async (req, res, next) => {
    // 1. 🔑 IDEMPOTENCY KEY ENFORCEMENT
    const idempotencyKey = req.headers[IDEMPOTENCY_HEADER];

    if (!idempotencyKey) {
        throw new BadRequestError(`Missing mandatory header: ${IDEMPOTENCY_HEADER}. A unique key is required for transactional safety.`);
    }

    // 2. INPUT VALIDATION & EXTRACTION 
    const {
        paymentMethod = "online",
        email,
        addressId,
        currency = 'NGN', 
        metadata = {},
    } = req.body;
    
    // 3. USER AUTHENTICATION & BUSINESS LOGIC CHECKS
    const userId = getUserId(req.user);
    
    if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
        throw new BadRequestError(`Invalid payment method: ${paymentMethod}. Must be one of ${VALID_PAYMENT_METHODS.join(', ')}.`);
    }

    // MANDATORY INPUT CHECK: Address ID must be present before delegation to service
    if (!addressId) {
        throw new BadRequestError("Address ID is required to complete checkout.");
    }

    // 4. DELEGATE TO SERVICE LAYER
    const serviceOpts = {
        userId,
        paymentMethod,
        email,
        addressId, 
        currency,
        metadata,
        idempotencyKey, 
    };

    try {
        const result = await CheckoutService.createOrderAndMaybeInitPayment(serviceOpts);

        // 5. SUCCESS/IDEMPOTENT RESPONSE HANDLING

        // If service returns a cached success from a prior run
        const isIdempotentSuccess = result.status === 'idempotent-success';
        if (isIdempotentSuccess) {
            // Return 200 OK for successful retrieval of an existing idempotent result.
            return res.status(StatusCodes.OK).json({ 
                success: true, 
                message: "Order already processed with this key. Returning previous result.",
                status: 'IDEMPOTENT_SUCCESS',
                orderId: result.order._id,
                order: result.order,
                payment: result.paymentInit || null,
            });
        }

        // Determine HTTP status based on final payment state
        // 201 CREATED: For fully paid orders (Wallet) or COD/Offline orders (pending confirmation)
        // 202 ACCEPTED: For orders requiring an external action (Online payment redirect)
        const responseStatus = (paymentMethod === 'online' && result.paymentInit) 
            ? StatusCodes.ACCEPTED 
            : StatusCodes.CREATED;
        
        // 5.1. Construct the final response object
        const finalResponse = {
            success: true,
            message: "Order initiated successfully. Proceed to payment or confirmation.",
            orderId: result.order._id,
            order: result.order,
            
            // Explicit Payment Block for Client Consumption
            payment: result.paymentInit ? {
                status: 'pending',
                method: paymentMethod,
                url: result.paymentInit.url, 
                reference: result.paymentInit.reference,
            } : {
                status: result.order.paymentStatus, 
                method: paymentMethod,
                message: `No external payment required. Order is in state: ${result.order.status}.`,
            },
        };

        // 5.2. Send the response
        res.status(responseStatus).json(finalResponse);

    } catch (error) {
        // 6. CATCH SERVICE ERRORS AND PROPAGATE
        
        // The service layer converts ConcurrencyError (stock issues) 
        // and other operational errors (NotFound, Insufficient Balance) 
        // into appropriate HTTP-mappable error types (like BadRequestError, NotFoundError).
        // The centralized error handler middleware is responsible for catching 
        // this re-thrown error and formatting the final JSON response (e.g., status 400).
        throw error;
    }
};

// Export the wrapped handler
exports.createCheckout = asyncHandler(createCheckoutHandler);
