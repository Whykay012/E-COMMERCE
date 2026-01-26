"use strict";

/**
 * 🛡️ ZENITH ENTERPRISE DTO - PAYMENT LAYER
 * Aligned with Payment Model and Provider Metadata.
 */
class PaymentDTO {
  /**
   * @desc Sanitize user wallet and recent history for client consumption.
   * Aligned with paymentSchema fields.
   */
  static formatWalletResponse(walletData, payments = []) {
    return {
      balance: Number(walletData.balance || 0).toFixed(2),
      currency: walletData.currency || "NGN",
      recentTransactions: payments.map((p) => ({
        id: p._id,
        reference: p.reference,
        amount: p.amount,
        status: p.status,
        channel: p.channel, // Added: matched from model
        orderId: p.order, // Added: matched from model
        date: p.createdAt,
      })),
    };
  }

  /**
   * @desc Masks sensitive internal risk metadata before returning to UI.
   * Maps model 'metadata' field to UI 'challenges'.
   */
  static formatInitializationResponse(payment, providerResp) {
    // Extract challenge markers safely from the model's Mixed metadata field
    const meta = payment.metadata || {};

    return {
      reference: payment.reference,
      authorization_url: providerResp?.authorization_url || null,
      access_code: providerResp?.access_code || null,
      stepUpRequired: !!meta.stepUpRequired,
      stepUpType: meta.stepUpType || null,
      challenges: {
        biometric: !!meta.biometricRequired,
        password: !!meta.specialPasswordRequired,
        otpSent: !!meta.stepUpOtpSent,
      },
      message: meta.stepUpRequired
        ? "Additional verification required"
        : "Payment initialized",
    };
  }

  /**
   * @desc Validates and cleans raw input for Initialize Payment.
   */
  static transformInitializeInput(data) {
    return {
      amount: parseFloat(data.amount),
      email: data.email?.toLowerCase().trim(),
      currency: data.currency?.toUpperCase() || "NGN",
      orderId: data.orderId, // Added: required by model
      metadata: data.metadata || {},
    };
  }
}

module.exports = PaymentDTO;
