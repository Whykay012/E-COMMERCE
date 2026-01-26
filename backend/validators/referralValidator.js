const Joi = require('joi');

// --- Reusable Definitions for Financial and Code Integrity ---

// Mocking the strict regex import for the referral code (assuming Base62 alphanumeric format)
const CODE_REGEX = /^[A-Z0-9]{10,20}$/; 

const ID_SCHEMA = Joi.string().hex().length(24).required().label('ID');

// Defines the strict format for the referral code (Base62 format)
const ReferralCodeSchema = Joi.string()
    .trim()
    .min(10) // Fixed to 10 for consistency with the generator
    .max(20) // Adjusted max to 20 for admin codes/flexibility
    .regex(CODE_REGEX)
    .required()
    .messages({
        'string.pattern.base': 'Referral code contains invalid characters or format (must be alphanumeric Base62).',
    });

// Defines the standard earned amount in the smallest currency unit (e.g., cents).
const EarnedAmountSchema = Joi.number()
    .integer() // CRITICAL: Ensures no floating point math errors
    .positive() // Must be a positive reward
    .required()
    .messages({
        'number.integer': 'Amount must be an integer (e.g., use cents, not dollars).',
    });

// Defines the adjustment amount, allowing negative values for deductions, but requiring integer.
const AdjustAmountSchema = Joi.number()
    .integer() // CRITICAL: Ensures no floating point math errors
    .required()
    .not(0) // Must be non-zero
    .messages({
        'number.integer': 'Adjustment amount must be an integer (e.g., use cents, not dollars).',
    });


// --- Exported Admin Schemas ---

exports.referralListQuerySchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(25),
    sortBy: Joi.string().default('totalEarned').valid('totalEarned', 'createdAt', 'commissionCount'),
    sortOrder: Joi.number().valid(1, -1).default(-1),
    status: Joi.string().valid('active', 'deactivated', 'pending_payout').optional(),
    search: Joi.string().trim().optional().description('Search by referrer name or code'),
    startDate: Joi.date().iso().optional(),
    endDate: Joi.date().iso().min(Joi.ref('startDate')).optional(),
});

exports.deactivateCodeSchema = Joi.object({
    // Using the strict shared code schema
    code: ReferralCodeSchema.description('The referral code string to deactivate.'),
});

exports.payoutEnqueueSchema = Joi.object({
    // Using the strict integer amount schema
    amount: EarnedAmountSchema.description('Payout amount in base currency unit (cents/points).'),
    currency: Joi.string().uppercase().length(3).required().description('e.g., USD, EUR.'),
    reason: Joi.string().required().min(10).max(255).description('Reason for manual payout.'),
    provider: Joi.string().required().valid('stripe', 'paypal', 'custom_bank').description('Target payout provider.'),
    providerAccountId: Joi.string().optional().max(100).description('Provider-specific account ID (preferred over userId).'),
    delay: Joi.number().integer().min(0).default(0).description('Delay in milliseconds for the job.'),
}).xor('providerAccountId', 'userId'); // Ensure one of the identifiers is present

exports.webhookEnqueueSchema = Joi.object({
    // Option 1: Trigger specific external webhook (target URL)
    webhookUrl: Joi.string().uri().max(512).optional(),
    keyId: Joi.string().optional().max(64).description('The key to sign the webhook payload.'),
    
    // Option 2: Trigger internal event (for all subscribers)
    eventType: Joi.string().optional().max(64).description('The internal event type (e.g., REFERRAL_COMMISSION_GRANTED).'),
    
    payload: Joi.object().required().description('The JSON payload for the webhook/event.'),
}).and('webhookUrl', 'keyId') // If URL is present, keyId must be present
  .xor('webhookUrl', 'eventType') // Must use one type of triggering mechanism
  .label('Webhook Body');

exports.adjustBalanceSchema = Joi.object({
    // Using the adjustment schema (integer, non-zero, allows negative)
    amount: AdjustAmountSchema.description('The amount to adjust (can be negative, in cents/points).'),
    reason: Joi.string().required().min(10).max(255).description('Mandatory reason for financial audit trail.'),
});

exports.jobIdParamSchema = Joi.object({
    jobId: Joi.string().required().max(64),
});

exports.IdParamSchema = Joi.object({
    userId: ID_SCHEMA,
});