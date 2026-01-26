// import express from "express";
// import Order from "../model/orderModel.js";
// import WebhookLog from "../model/webhookLog.js";
// import { StatusCodes } from "http-status-codes";
// import getOrderStatusProgress from "../utils/orderStatusProgress.js";
// import Stripe from "stripe";
// import crypto from "crypto";

// const router = express.Router();
// const stripe = new Stripe(process.env.STRIPE_SECRET);

// // Stripe signature verification
// function verifyStripeSignature(req, res, next) {
//   const sig = req.headers["stripe-signature"];
//   try {
//     const event = stripe.webhooks.constructEvent(
//       req.rawBody,
//       sig,
//       process.env.STRIPE_WEBHOOK_SECRET
//     );
//     req.provider = "Stripe";
//     req.webhookPayload = event.data.object;
//     next();
//   } catch (err) {
//     console.error("Stripe webhook signature invalid:", err.message);
//     return res.status(400).json({ msg: "Invalid Stripe webhook signature" });
//   }
// }

// // Paystack signature verification
// function verifyPaystackSignature(req, res, next) {
//   const paystackSig = req.headers["x-paystack-signature"];
//   const secret = process.env.PAYSTACK_SECRET;
//   const hash = crypto
//     .createHmac("sha512", secret)
//     .update(req.rawBody)
//     .digest("hex");

//   if (hash !== paystackSig) {
//     console.error("Paystack webhook signature invalid");
//     return res.status(400).json({ msg: "Invalid Paystack webhook signature" });
//   }

//   req.provider = "Paystack";
//   req.webhookPayload = req.body;
//   next();
// }

// // Unified route
// router.post(
//   "/order-update",
//   async (req, res, next) => {
//     const provider = req.headers["stripe-signature"]
//       ? "stripe"
//       : req.headers["x-paystack-signature"]
//       ? "paystack"
//       : null;

//     if (provider === "stripe") return verifyStripeSignature(req, res, next);
//     if (provider === "paystack") return verifyPaystackSignature(req, res, next);

//     return res
//       .status(StatusCodes.BAD_REQUEST)
//       .json({ msg: "Unknown webhook provider" });
//   },
//   async (req, res) => {
//     const { orderId, status, eventTime } = req.webhookPayload;
//     let logEntry;

//     try {
//       const order = await Order.findById(orderId);
//       if (!order) {
//         logEntry = await WebhookLog.create({
//           provider: req.provider,
//           orderId,
//           payload: req.webhookPayload,
//           status: "failed",
//           error: "Order not found",
//         });
//         return res
//           .status(StatusCodes.NOT_FOUND)
//           .json({ msg: "Order not found" });
//       }

//       order.status = status;
//       order.statusProgress = getOrderStatusProgress(status);
//       order.events.push({
//         label: `Status updated via webhook (${req.provider}): ${status}`,
//         date: eventTime || new Date(),
//       });
//       await order.save();

//       // Emit to user's room
//       const io = req.app.get("io");
//       io.to(order.userId.toString()).emit("orderUpdated", { orderId, status });

//       // Log success
//       logEntry = await WebhookLog.create({
//         provider: req.provider,
//         orderId,
//         payload: req.webhookPayload,
//         status: "processed",
//       });

//       console.log(
//         `Webhook updated order ${orderId} via ${req.provider} to status ${status}`
//       );
//       res.status(StatusCodes.OK).json({ msg: "Order status updated", order });
//     } catch (error) {
//       console.error("Webhook processing error:", error);
//       if (!logEntry) {
//         await WebhookLog.create({
//           provider: req.provider,
//           orderId: req.webhookPayload?.orderId,
//           payload: req.webhookPayload,
//           status: "failed",
//           error: error.message,
//         });
//       }
//       res
//         .status(StatusCodes.INTERNAL_SERVER_ERROR)
//         .json({ msg: "Server error" });
//     }
//   }
// );

// export default router;
