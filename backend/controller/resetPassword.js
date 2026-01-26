const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../model/userModel");
const Outbox = require("../utils/transactionalOutbox");
const BadRequestError = require("../errors/bad-request-error");
const Logger = require("../utils/logger");
// Import your email breaker
const { emailDispatchBreaker } = require("../services/authService"); 

const resetPassword = async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) throw new BadRequestError("All fields are required");

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    }).session(session);

    if (!user) throw new BadRequestError("Invalid or expired token");

    user.password = password; 
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save({ session });

    // 1. Record in Outbox (The Permanent Audit)
    const outboxRecords = await Outbox.create([{
      aggregateId: user._id,
      eventType: 'PASSWORD_CHANGED_SECURE',
      traceId: req.traceId || 'internal',
      payload: { 
        email: user.email,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        occurredAt: new Date().toISOString()
      },
      status: 'PENDING'
    }], { session });

    const eventId = outboxRecords[0]._id;

    // 2. Commit DB changes first!
    await session.commitTransaction();
    session.endSession();

    // 3. Instant Dispatch Hint (Circuit Breaker)
    // We do this AFTER commit so the worker can find the record in the DB
    emailDispatchBreaker.fire('jobs', { 
      name: "auth.email_relay", 
      data: { 
        type: 'PASSWORD_CHANGED_CONFIRMATION', 
        eventId: eventId,
        email: user.email 
      } 
    }).catch(err => {
      // If this fails, don't worry—the Maintenance Poller catches it in < 60s
      Logger.warn('RESET_CONFIRMATION_DELAYED', { eventId, reason: err.message });
    });

    res.status(200).json({ message: "Password reset successful. A confirmation has been sent." });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    Logger.error("PASSWORD_RESET_FLOW_FAILED", { error: error.message });
    throw error;
  }
};

module.exports = resetPassword;