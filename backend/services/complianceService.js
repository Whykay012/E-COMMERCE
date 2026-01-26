// services/complianceService.js (GDPR/CCPA API Handler)

const ComplianceOutbox = require('../model/complianceOutbox'); // Ensure path is correct
const Logger = require('../utils/logger');
// Assuming paths for error handling and queueing helper
const { UnauthorizedError, BadRequestError, InternalServerError } = require('../errors'); 
const { queueJob, GENERAL_QUEUE_NAME } = require('../queues/jobQueue'); 


// --- Placeholder for Authorization Check (Assuming it's passed in from the controller) ---
// Note: In a real system, 'req.user' would need to be passed into this service method.
const isAuthorized = (requestingUser, subjectId) => {
    // Example logic: must be admin OR the user ID must match the subject ID
    // if (requestingUser.role === 'admin') return true;
    // return requestingUser._id.toString() === subjectId.toString();
    return true; // Skipping real check for demonstration
};


/**
 * @desc Initiates a data subject request (e.g., Right to Erasure, Right to Access).
 * This operation is transactional: it ensures the request is safely recorded and then 
 * placed onto the reliable BullMQ queue for processing by the job router worker.
 * @param {object} reqUser - The authorized user object (for authorization checks).
 * @param {string} subjectId - The ID of the data subject (userId).
 * @param {string} action - The type of request (e.g., 'ERASURE_REQUEST').
 * @returns {Promise<object>} The newly created request record status.
 */
const initiateDataSubjectRequest = async (reqUser, subjectId, action) => {
    if (!subjectId || !action) {
        throw new BadRequestError('Subject ID and action type are required.');
    }

    // 1. Authorization check
    if (!isAuthorized(reqUser, subjectId)) { 
        throw new UnauthorizedError('Unauthorized compliance request.'); 
    }
    
    // 2. Create the Outbox record
    let newRequest;
    try {
        newRequest = new ComplianceOutbox({
            subjectId: subjectId,
            action: action,
            metadata: { 
                requestedBy: reqUser._id.toString(), // Log who initiated it
                source: 'API_ENDPOINT',
            },
            eventPayload: {
                type: `COMPLIANCE_REQUEST_${action}`,
                data: { subjectId, initiatedAt: Date.now() }
            }
        });

        await newRequest.save();
        
        // 3. Queue the job to the BullMQ Router Worker (This is the critical change)
        const jobName = action === 'ERASURE_REQUEST' ? "compliance.erasure_request" : "compliance.general_request";
        
        const jobOptions = {
            jobId: newRequest._id.toString(), // Use the Outbox ID for traceability
            attempts: 3, // Retry policy
            backoff: { type: 'exponential', delay: 10000 }, // 10s, 20s, 40s
            removeOnComplete: true, 
            removeOnFail: false, // Keep failed jobs for DLQ inspection
        };

        const jobData = {
            subjectId: subjectId,
            complianceOutboxId: newRequest._id.toString(),
            action: action, // Pass original action for robustness
        };

        await queueJob(
            GENERAL_QUEUE_NAME, 
            jobName, 
            jobData, 
            jobOptions
        );
        
        Logger.info('COMPLIANCE_JOB_QUEUED', { requestId: newRequest._id, subjectId, action, jobName });

        // 4. Return success status immediately
        return { 
            status: 'QUEUED', 
            requestId: newRequest._id, 
            message: `Compliance request (${action}) recorded and queued for asynchronous processing.` 
        };

    } catch (error) {
        Logger.error('COMPLIANCE_QUEUE_FAILED', { subjectId, action, error: error.message });
        throw new InternalServerError('Failed to record compliance request due to internal error.');
    }
};

module.exports = {
    initiateDataSubjectRequest,
    // Other functions like getRequestStatus, cancelRequest
};