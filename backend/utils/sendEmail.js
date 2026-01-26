const nodemailer = require("nodemailer");
const postmark = require("postmark");
const SendGrid = require("@sendgrid/mail");
const fs = require("fs").promises;
const path = require("path");
const Logger = require("../config/logger");
const Metrics = require("../utils/metricsClient");

// 1. Singleton Clients & Cache
const templateCache = new Map();
const postmarkClient = new postmark.ServerClient(process.env.POSTMARK_API_KEY);
SendGrid.setApiKey(process.env.SENDGRID_API_KEY);

// 2. Persistent SMTP Transporter (from your original setup)
// Keeps a "Warm Tunnel" open to save 1-2 seconds on non-critical mail.
const smtpTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: false,
  pool: true, // Reuses connections for efficiency
  maxConnections: 5,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 5000,
});

/**
 * THE ZENITH HYBRID DISPATCHER
 * Automatically routes between SDK (Speed) and SMTP (Pooled/Cheap)
 */
const sendEmail = async ({
  to,
  subject,
  htmlTemplatePath,
  placeholders = {},
  priority = "normal",
  text = "", // Added support for plain text fallback
}) => {
  const start = Date.now();
  const traceId = `zen_${Date.now()}`;

  try {
    // A. Optimized Template Loading (with Cache)
    let htmlContent = templateCache.get(htmlTemplatePath);
    if (!htmlContent) {
      const filePath = path.join(__dirname, "..", htmlTemplatePath);
      htmlContent = await fs.readFile(filePath, "utf8");
      templateCache.set(htmlTemplatePath, htmlContent);
    }

    // B. Fast Placeholder Injection
    const processedHtml = Object.entries(placeholders).reduce(
      (acc, [key, val]) => acc.replace(new RegExp(`{{${key}}}`, "g"), val),
      htmlContent
    );

    // C. Logic: Intelligence Routing
    const isCritical =
      /OTP|Verify|Code|Reset|Secure/i.test(subject) || priority === "high";

    const payload = { to, subject, html: processedHtml, text, traceId };

    if (isCritical) {
      // ⚡ FAST TRACK: Try Postmark SDK -> SendGrid SDK -> SMTP Fallback
      return await dispatchCritical(payload);
    } else {
      // 🐢 STANDARD TRACK: Use Pooled SMTP (Cheaper/Bulk)
      return await sendViaSMTP(payload);
    }
  } catch (error) {
    Logger.error("ZENITH_MAIL_SYSTEM_HALT", {
      traceId,
      to,
      error: error.message,
    });
    throw error;
  }
};

/**
 * CRITICAL PATH: Triple-Layer Fallback
 */
async function dispatchCritical(payload) {
  try {
    return await sendViaPostmark(payload);
  } catch (err) {
    Logger.warn("POSTMARK_FAIL_FALLING_BACK_TO_SENDGRID", { to: payload.to });
    try {
      return await sendViaSendGrid(payload);
    } catch (sgErr) {
      Logger.error("ALL_SDKS_DOWN_FINAL_SMTP_ATTEMPT");
      return await sendViaSMTP(payload); // Last chance safety net
    }
  }
}

/**
 * PROVIDER 1: Postmark SDK (Primary for MFA)
 */
async function sendViaPostmark({ to, subject, html, traceId }) {
  const start = Date.now();
  const res = await postmarkClient.sendEmail({
    From: process.env.EMAIL_FROM,
    To: to,
    Subject: subject,
    HtmlBody: html,
    MessageStream: "outbound",
    Metadata: { traceId },
  });
  recordMetrics("postmark", true, start);
  return { success: true, provider: "postmark", messageId: res.MessageID };
}

/**
 * PROVIDER 2: SendGrid SDK (Secondary for MFA)
 */
async function sendViaSendGrid({ to, subject, html, traceId }) {
  const start = Date.now();
  await SendGrid.send({
    to,
    from: process.env.EMAIL_FROM,
    subject,
    html,
    customArgs: { traceId },
  });
  recordMetrics("sendgrid", true, start);
  return { success: true, provider: "sendgrid" };
}

/**
 * PROVIDER 3: Nodemailer SMTP (Standard/Fallback)
 */
async function sendViaSMTP({ to, subject, html, text }) {
  const start = Date.now();
  const info = await smtpTransporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text,
    html,
    headers: {
      "X-Priority": "1 (Highest)",
      "X-MSMail-Priority": "High",
    },
  });
  recordMetrics("smtp", true, start);
  return { success: true, provider: "smtp", messageId: info.messageId };
}

function recordMetrics(provider, success, start) {
  if (!Metrics) return;
  Metrics.increment(`email.dispatch.${success ? "ok" : "fail"}`, 1, {
    provider,
  });
  Metrics.timing(`email.latency.${provider}`, Date.now() - start);
}

module.exports = sendEmail;
