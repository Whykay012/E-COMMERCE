/*
 * services/slackAlertService.js
 */
const axios = require('axios');
const logger = require('../config/logger');

const sendCriticalAlert = async (jobName, details) => {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) return;

    const message = {
        attachments: [{
            color: "#ff0000", // Critical Red
            title: `🚨 CRITICAL_JOB_FAILURE: ${jobName}`,
            fields: [
                { title: "Event", value: details.event || jobName, short: true },
                { title: "User ID", value: details.userId || details.subjectId || 'N/A', short: true },
                { title: "Error", value: details.error, short: false },
                { title: "Environment", value: process.env.NODE_ENV, short: true }
            ],
            footer: "Zenith Compliance Monitor",
            ts: Math.floor(Date.now() / 1000)
        }]
    };

    try {
        await axios.post(webhookUrl, message);
    } catch (err) {
        logger.error("SLACK_NOTIFICATION_FAILED", { error: err.message });
    }
};

module.exports = { sendCriticalAlert };