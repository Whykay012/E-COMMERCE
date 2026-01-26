// server.js — CANONICAL, LOCKED, FAIL-FAST ENTRY POINT
require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const Sentry = require("@sentry/node");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const cors = require("cors");

const config = require("./config");
const dependencies = require("./dependencies");
const LifecycleManager = require("./utils/lifecycle");
const notificationService = require("./services/notificationService");
const authService = require("./services/authService");

// ───────────────────────────────────────────────────────────────────────────────────
// Initialize Core Components
// ───────────────────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const manager = new LifecycleManager(dependencies);

// Inject Health Monitor into AuthService for legacy compatibility
authService.initialize({ healthMonitor: manager.monitor });

// ───────────────────────────────────────────────────────────────────────────────────
// Outbox Dispatcher (Domain Logic)
// ───────────────────────────────────────────────────────────────────────────────────
const unifiedPublisher = async (events) => {
  const { Logger } = dependencies;
  for (const event of events) {
    try {
      const topic = event.topic || event.eventType;
      switch (topic) {
        case "MFA_CHALLENGE_DISPATCH":
          await notificationService.sendMfaCode(
            event.payload.userId,
            event.payload.code,
            event.payload.mode
          );
          break;
        case "PASSWORD_RESET_REQUESTED":
          await notificationService.sendResetLink(
            event.payload.email,
            event.payload.link
          );
          break;
        case "SECURITY_LOGOUT_AUDIT":
          Logger.info("SECURITY_AUDIT_FINALIZED", {
            userId: event.payload.userId,
            traceId: event.traceId,
          });
          break;
        default:
          Logger.warn(`OUTBOX_UNHANDLED_TOPIC: ${topic}`, {
            eventId: event._id,
          });
      }
    } catch (err) {
      Logger.error(`OUTBOX_DISPATCH_FAILURE: ${event.topic}`, {
        error: err.message,
      });
      throw err;
    }
  }
};

// ───────────────────────────────────────────────────────────────────────────────────
// Middleware Stack
// ───────────────────────────────────────────────────────────────────────────────────
app.use(
  express.json({
    limit: "20mb",
    verify: (req, res, buf) => (req.rawBody = buf.toString()),
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

require("./middleware/security")(app);
app.use(require("./middleware/rateLimiter").globalLimiter);
app.use(require("./services/idempotencyService").idempotencyMiddleware);
app.use(morgan("dev"));
app.use(cors({ origin: config.CLIENT_ORIGIN, credentials: true }));

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, environment: config.NODE_ENV });
  app.use(Sentry.Handlers.requestHandler());
}

// ───────────────────────────────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────────────────────────────
app.use("/api/v1/auth", require("./routes/authRoutes"));
app.use("/api/v1/admin", require("./routes/adminRoutes"));
app.use("/api/v1/monitoring", require("./routes/monitoring")); // Shared Metrics & Apex Health
app.use("/api/v1/webhooks/payment", require("./routes/paymentWebhook"));
app.use("/api/v1/recs", require("./routes/recommendationRoutes"));

if (config.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../frontend/dist")));
  app.get("*", (_, res) =>
    res.sendFile(path.join(__dirname, "../frontend/dist/index.html"))
  );
}

// Error Handling
app.use(require("./routes/pageNotFound"));
app.use(require("./middleware/cloudinaryErrorHandler"));
if (process.env.SENTRY_DSN) app.use(Sentry.Handlers.errorHandler());
app.use(require("./middleware/errorHandler"));

// ───────────────────────────────────────────────────────────────────────────────────
// Bootstrap Execution
// ───────────────────────────────────────────────────────────────────────────────────
(async function start() {
  try {
    // 1. Run Orchestrated Infrastructure Boot
    await manager.boot(unifiedPublisher);

    // 2. Bind to Port
    server.listen(config.PORT, () => {
      dependencies.Logger.info(`ZENITH OMEGA API online on :${config.PORT}`);
      // Final Gate: Mark as ready for traffic
      manager.monitor.updateStartupPhase("COMPLETED", true);
    });
  } catch (err) {
    dependencies.Logger.fatal("CORE_BOOT_ABORTED", err);
    process.exit(1);
  }
})();

// Graceful Shutdown Bindings
process.on("SIGINT", () => manager.shutdown(server, "SIGINT"));
process.on("SIGTERM", () => manager.shutdown(server, "SIGTERM"));

module.exports = { app, server };
