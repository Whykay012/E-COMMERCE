/**
* utils/referralSchemas.js
* Joi schemas for the Referral domain (e.g., signup, code management, admin queries).
* Assumes BASE62_REGEX and CODE_LENGTH are imported from './base62'.
*/
const Joi = require('joi');
const { BASE62_REGEX, CODE_LENGTH } = require('./base62'); 

// Define common schemas for reuse
const objectIdSchema = Joi.string().length(24).hex().required().label('User ID');
const referralCodeSchema = Joi.string().length(CODE_LENGTH).regex(BASE62_REGEX).required().label('Referral Code');
const pageSchema = Joi.number().integer().min(1).default(1).label('Page Number');
const limitSchema = Joi.number().integer().min(1).max(100).default(25).label('Limit');

// --- Custom Code Rules ---
// Custom codes must be 4-16 characters long and alphanumeric
const customCodeSchema = Joi.string()
  .min(4) 
  .max(16)
  .regex(new RegExp(`^[0-9a-zA-Z]+$`))
  .required()
  .label('Custom Referral Code');

// --- API Endpoint Schemas ---

const referralSchemas = {
  // POST /api/v1/referral/signup
  signup: Joi.object({
    code: referralCodeSchema, 
    referredUserId: objectIdSchema,
    idempotencyKey: Joi.string().uuid().optional().label('Idempotency Key'), 
  }).required(),

  // PUT /api/v1/referral/code
  updateCode: Joi.object({
    newCode: customCodeSchema,
  }).required(),

  // PUT /api/v1/referral/deactivate
  deactivate: Joi.object({
    code: referralCodeSchema,
  }).required(),

  // GET /api/v1/admin/referrals
  adminListQuery: Joi.object({
    page: pageSchema,
    limit: limitSchema,
    isActive: Joi.boolean().optional(),
    minEarnings: Joi.number().min(0).optional(),
  }),
};

module.exports = {
  referralSchemas,
};