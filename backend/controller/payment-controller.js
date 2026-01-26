// controllers/paymentController.js

// --- Core Utilities and Services ---
const asyncHandler = require('../middleware/asyncHandler'); 
const PaymentService = require("../services/paymentServiceV4");
const logger = require("../config/logger"); 

// --- Errors ---
const BadRequestError = require("../errors/bad-request-error");
const InternalServerError = require("../errors/internal-server-error");

// --- Configuration Constants ---
const WEBHOOK_SUCCESS_RESPONSE = { received: true, status: 'PROCESSING_ACCEPTED' };
const WEBHOOK_FAILURE_RESPONSE = { received: true, status: 'FAILED_VALIDATION' };

// =========================================================================
// 💼 AUTHENTICATED ENDPOINTS
// =========================================================================

/**
 * GET /api/payment/wallet
 * @desc Retrieves the authenticated user's wallet details.
 * @access Private (User)
 */
exports.getWallet = asyncHandler(async (req, res) => {
    const wallet = await PaymentService.getWallet(req.user._id);
    return res.status(200).json({ success: true, data: wallet });
});

/**
 * POST /api/payment/initiate
 * @desc Initiates a payment transaction, often for card redirection.
 * @access Private (User)
 */
exports.initializePayment = asyncHandler(async (req, res) => {
    const { amount, email, currency, metadata, ip, userAgent } = req.body;
    
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        throw new BadRequestError("Valid amount is required.");
    }

    const result = await PaymentService.initializePayment(
        req.user._id,
        Number(amount),
        email || req.user?.email,
        { 
            ip: ip || req.ip, 
            userAgent: userAgent || req.headers["user-agent"], 
            currency: currency || "NGN", 
            metadata: { 
                userId: req.user._id.toString(), 
                ...metadata 
            }
        }
    );
    // Standardized 202 Accepted for asynchronous initiation
    return res.status(202).json({
        success: true,
        message: "Payment initiation accepted. Redirect user to authorization URL.",
        data: result
    });
});

/**
 * GET or POST /api/payment/verify
 * @desc Manually verifies a payment reference (e.g., after user redirection).
 * @access Private (User)
 */
exports.verifyPayment = asyncHandler(async (req, res) => {
    const reference = req.query.reference || req.body.reference;
    if (!reference) throw new BadRequestError("Payment reference is required.");

    const result = await PaymentService.verifyPayment(reference);

    // --- Socket Event Emission (Superior Clarity) ---
    const io = req.app.get("io");
    const userId = result.payment?.user || (req.user && req.user._id);
    if (io && userId && result.updatedWallet) {
        try {
            io.to(userId.toString()).emit("wallet:updated", {
                wallet: result.updatedWallet,
                payment: result.payment,
            });
        } catch (emitErr) {
            logger.warn(`[PaymentController] Socket emit failed for user ${userId}: ${emitErr.message}`);
        }
    }
    
    // Standardized 200 OK response structure
    return res.status(200).json({
        success: true,
        message: result.message || "Payment verification complete.",
        data: {
            status: result.payment?.status || "unknown",
            updatedWallet: result.updatedWallet,
            providerData: result.providerData || null,
        },
    });
});

/**
 * POST /api/payment/verify-stepup
 * @desc Verifies OTP for 3D Secure or step-up authentication.
 * @access Private (User)
 */
exports.verifyStepUpOtp = asyncHandler(async (req, res) => {
    const { paymentId, otp } = req.body;
    if (!paymentId || !otp) throw new BadRequestError("Payment ID and OTP are required.");

    const result = await PaymentService.verifyStepUpOtp(paymentId, otp);
    
    return res.status(200).json({ success: true, data: result });
});

/**
 * GET /api/payment/history?page=&limit=&status=&search=
 * @desc Retrieves the authenticated user's payment history.
 * @access Private (User)
 * * NOTE: The implementation details of getPaymentHistory were previously in the Service 
 * and are assumed to be correctly implemented there, supporting the advanced filtering 
 * and aggregation required by the Zenith level.
 */
exports.getPaymentHistory = asyncHandler(async (req, res) => {
    // Zenith Feature: Extract all possible filters from query string
    const { page = 1, limit = 10, status, provider, search, startDate, endDate } = req.query;
    
    // Superior Feature: Pass all filters to the service
    const history = PaymentService.getPaymentHistory
        ? await PaymentService.getPaymentHistory(req.user._id, { 
            page: Number(page), 
            limit: Number(limit), 
            status, 
            provider, // Added provider filter
            search, 
            startDate, // Added time filters
            endDate 
          })
        : { payments: [], totalCount: 0, totalPages: 0, currentPage: 1 }; 

    return res.status(200).json({ success: true, data: history });
});

// =========================================================================
// 🚨 ASYNCHRONOUS HANDLERS (Webhooks - Critical for SAGA)
// =========================================================================

/**
 * POST /api/payment/webhook
 * @desc Handles asynchronous payment notifications from the Payment Gateway.
 * This is CRITICAL for reliability and the SAGA pattern. 
 * @access Public (Payment Gateway Server)
 */
exports.handleWebhook = async (req, res) => {
    // NOTE: For enterprise systems, the provider determination logic often sits here or in a middleware.
    
    // Zenith Fix: Wrap data into the object structure required by the service's signature
    const webhookData = {
        // NOTE: If you use a body parser (like Express JSON parser), req.body is an object.
        // We assume rawBody is available, perhaps via a specific middleware that adds it.
        rawBody: req.rawBody || JSON.stringify(req.body), // Use rawBody for signature check
        payload: req.body,
        headers: req.headers,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        // Provider must be determined here, or hardcoded if this route only handles one provider.
        // Assuming provider is extracted in a middleware or within the service itself.
        provider: req.headers['x-provider-name'] || 'paystack' // Placeholder or actual header extraction
    };

    try {
        // 🚨 Renamed Service Call: Changed from handleWebhook to processProviderWebhook
        await PaymentService.processProviderWebhook(webhookData);

        // Zenith Robustness: MUST return 200 OK immediately
        return res.status(200).json(WEBHOOK_SUCCESS_RESPONSE);

    } catch (error) {
        // Zenith Improvement: Verbose logging for investigation
        logger.error(`[PaymentController] Webhook Security/Processing Failure: ${error.message}`, { 
            errorCode: error.statusCode || 500,
            webhookBody: req.body, 
            webhookHeaders: req.headers 
        });
        
        // Return 400 for security/validation failures.
        if (error.statusCode === 400 || error.statusCode === 401) {
             return res.status(400).json(WEBHOOK_FAILURE_RESPONSE);
        }
        
        // Acknowledge general processing errors (5xx) with 200 OK to stop retries.
        return res.status(200).json(WEBHOOK_SUCCESS_RESPONSE); 
    }
};