/**
 * 🛰️ ZENITH ENTERPRISE AUTH INSTRUMENTATION (ULTRA-BLACK)
 * High-Precision Identity Observability & SIEM-Ready Telemetry.
 */
const metricsClient = require("./metricsClient");
const auditLogger = require("./auditLogger");
const tracingClient = require("./tracingClient");
const Logger = require("./logger");
const { SemanticAttributes } = require("@opentelemetry/semantic-conventions");

const instrument =
  (fnName, fn) =>
  async (...args) => {
    // 1. SMART CONTEXT EXTRACTION (Enterprise Level)
    // Recursively finds context regardless of position, or defaults to safe object
    const context =
      args.find(
        (arg) => arg && typeof arg === "object" && (arg.ip || arg.traceId),
      ) || {};
    const traceId =
      context.traceId ||
      tracingClient.getActiveSpan()?.spanContext()?.traceId ||
      "system-gen";

    return tracingClient.withSpan(
      `zenith.identity.orchestrator.${fnName}`,
      async (span) => {
        const startTime = process.hrtime(); // High-resolution timer for enterprise precision

        // 2. ENHANCED SEMANTIC TAGGING (OTel Standards)
        span.setAttributes({
          [SemanticAttributes.RPC_METHOD]: fnName,
          [SemanticAttributes.HTTP_CLIENT_IP]: context.ip || "0.0.0.0",
          [SemanticAttributes.HTTP_USER_AGENT]: context.userAgent || "internal",
          "identity.provider": "ZenithCore",
          "identity.session_id": context.sessionId || "anonymous",
          "security.zone": context.zone || "untrusted",
        });

        try {
          // 3. ATOMIC EXECUTION
          const result = await fn(...args);

          // 4. PERFORMANCE ANALYTICS (Nanosecond Precision)
          const [seconds, nanoseconds] = process.hrtime(startTime);
          const durationMs = (seconds * 1000 + nanoseconds / 1e6).toFixed(4);

          // 5. SUCCESS & CONVERSION TELEMETRY
          metricsClient.increment(`identity.${fnName}.success`, {
            env: process.env.NODE_ENV,
            tier: context.role || "public",
          });
          metricsClient.timing(
            `identity.${fnName}.latency_precise`,
            durationMs,
          );

          // 6. BUSINESS LOGIC CHECKPOINTS (Funnel Tracking)
          if (result) {
            const metadata = {};
            if (result.accountUnverified)
              metadata.status = "PENDING_VERIFICATION";
            if (result.mfaRequired) metadata.status = "MFA_CHALLENGE";
            if (result.passwordExpired)
              metadata.status = "PASSWORD_ROTATION_REQUIRED";

            if (metadata.status) {
              metricsClient.increment(`identity.flow.checkpoint`, {
                step: metadata.status,
              });
              span.addEvent("identity_flow_checkpoint", metadata);
            }
          }

          return result;
        } catch (error) {
          // 7. SIEM-GRADE FAILURE CLASSIFICATION
          const errorType =
            error.metricReason || error.name || "IdentityProtocolError";
          const statusCode = error.status || 500;
          const [s, ns] = process.hrtime(startTime);
          const totalLatency = (s * 1000 + ns / 1e6).toFixed(2);

          // Rich Exception Logging for Flame Graphs
          span.recordException(error);
          span.setStatus({ code: 2, message: errorType });

          // Metric Tagging (High Cardinality dimensions for Prometheus/Grafana)
          metricsClient.increment(`identity.${fnName}.failure`, {
            reason: errorType,
            status_code: statusCode.toString(),
            is_security_event: (
              statusCode === 401 || statusCode === 403
            ).toString(),
          });

          // 8. AUTONOMOUS AUDIT & SIEM DISPATCH
          const isSecurityEvent = [401, 403, 422, 429].includes(statusCode);

          if (isSecurityEvent) {
            auditLogger.log({
              level: "CRITICAL",
              event: `IDENTITY_${fnName.toUpperCase()}_VIOLATION`,
              actor: context.userId || "anonymous",
              identity_context: {
                traceId,
                ip: context.ip,
                userAgent: context.userAgent,
                reason: errorType,
                msg: error.message,
                latency: `${totalLatency}ms`,
              },
              remediation:
                statusCode === 429
                  ? "RATE_LIMIT_BLOCK"
                  : "CREDENTIAL_REJECTION",
            });
          } else {
            // Operational Error (Level: ALERT)
            Logger.alert(`Zenith Identity System Error [${fnName}]`, {
              error: error.message,
              stack: error.stack,
              traceId,
            });
          }

          throw error;
        }
      },
    );
  };

module.exports = { instrument };
