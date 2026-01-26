/**
 * controllers/notificationController.js
 * ZENITH OMEGA - Full Orchestration Layer (v5.0)
 */
const { StatusCodes } = require('http-status-codes');
const asyncHandler = require('../middleware/asyncHandler');
const NotificationService = require('../services/notificationService');
const AuditLogger = require('../services/auditLogger');
const Tracing = require('../utils/tracingClient');
const Metrics = require('../utils/metricsClient');

// --- READ OPERATIONS ---

const getNotifications = asyncHandler(async (req, res) => {
    return Tracing.withSpan('Controller.getNotifications', async (span) => {
        const userID = req.user.userID;
        const startTime = Date.now();

        const result = await NotificationService.getUserNotifications(userID, req.query);

        Metrics.timing('api.notifications.fetch_latency', Date.now() - startTime);
        Metrics.increment('api.notifications.fetch_count', 1, { status: 'success' });

        res.status(StatusCodes.OK).json({ success: true, ...result });
    });
});

const getNotificationStats = asyncHandler(async (req, res) => {
    return Tracing.withSpan('Controller.getNotificationStats', async (span) => {
        const stats = await NotificationService.getNotificationStats(req.user.userID);
        res.status(StatusCodes.OK).json({ success: true, stats });
    });
});

// --- UPDATE OPERATIONS ---

const markAsRead = asyncHandler(async (req, res) => {
    return Tracing.withSpan('Controller.markAsRead', async (span) => {
        const { id } = req.params;
        const userID = req.user.userID;

        const success = await NotificationService.markAsRead(userID, id);
        
        if (!success) {
            return res.status(StatusCodes.NOT_MODIFIED).json({ message: "Already read or invalid ID" });
        }

        AuditLogger.log({
            level: 'INFO',
            event: 'NOTIFICATION_READ',
            userId: userID,
            details: { notificationId: id }
        });

        res.status(StatusCodes.OK).json({ success: true, message: "Marked as read (Pending Cache Refresh)" });
    });
});

const markAllRead = asyncHandler(async (req, res) => {
    return Tracing.withSpan('Controller.markAllRead', async (span) => {
        const userID = req.user.userID;
        const result = await NotificationService.markAllRead(userID);
        
        res.status(StatusCodes.OK).json({ 
            success: true, 
            affected: result.affectedCount,
            status: result.isAsync ? 'PROCESSING_IN_BACKGROUND' : 'COMPLETED'
        });
    });
});

// --- DELETE / ARCHIVE OPERATIONS ---

const archiveNotification = asyncHandler(async (req, res) => {
    return Tracing.withSpan('Controller.archiveNotification', async (span) => {
        const { id } = req.params;
        const userID = req.user.userID;

        await NotificationService.archiveNotification(userID, id);
        
        AuditLogger.log({
            level: 'INFO',
            event: 'NOTIFICATION_ARCHIVED',
            userId: userID,
            details: { notificationId: id }
        });

        res.status(StatusCodes.OK).json({ success: true, message: "Moved to ARCHIVE" });
    });
});

const deleteNotification = asyncHandler(async (req, res) => {
    return Tracing.withSpan('Controller.deleteNotification', async (span) => {
        const { id } = req.params;
        const userID = req.user.userID;

        await NotificationService.deleteNotification(userID, id);
        
        AuditLogger.log({
            level: 'WARN',
            event: 'NOTIFICATION_DELETED',
            userId: userID,
            details: { notificationId: id }
        });

        res.status(StatusCodes.NO_CONTENT).send();
    });
});

// --- PREFERENCES ---

const updateNotificationSettings = asyncHandler(async (req, res) => {
    return Tracing.withSpan('Controller.updateSettings', async (span) => {
        const userID = req.user.userID;
        const settings = await NotificationService.updateSettings(userID, req.body);

        AuditLogger.log({
            level: 'WARN',
            event: 'PREFERENCES_UPDATED',
            userId: userID,
            details: { newSettings: req.body }
        });

        res.status(StatusCodes.OK).json({ success: true, settings });
    });
});

module.exports = { 
    getNotifications, 
    getNotificationStats, 
    markAsRead, 
    markAllRead, 
    archiveNotification, 
    deleteNotification, 
    updateNotificationSettings 
};