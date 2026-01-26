const Joi = require("joi");

exports.initializePaymentSchema = Joi.object({
  amount: Joi.number().positive().required(),
  email: Joi.string().email().optional(),
  currency: Joi.string().default("NGN"),
  metadata: Joi.object().optional(),
  ip: Joi.string().ip({ version: ["ipv4", "ipv6"] }).optional(),
  userAgent: Joi.string().optional(),
});

exports.verifyPaymentSchema = Joi.object({
  reference: Joi.string().required(),
});

exports.verifyStepUpSchema = Joi.object({
  paymentId: Joi.string().required(),
  otp: Joi.string().length(6).required(),
});
