// services/CloudinaryService.js (TITAN NEXUS - Enhanced Observability)
const cloudinary = require("../config/cloudinary");
const streamifier = require("streamifier");
const fs = require("fs");
const logger = require("../config/logger"); 
const Metrics = require("../utils/metricsClient"); // 💡 Import Metrics
const Tracing = require("../utils/tracingClient"); // 💡 Import Tracing

class CloudinaryService {

    // --- Utility Function for Metrics/Tracing Tags ---
    static #getTags(publicId, operation) {
        return { 
            cloud_provider: 'cloudinary', 
            operation: operation, 
            public_id: publicId || 'N/A' 
        };
    }

    /**
     * @desc Uploads a file buffer to Cloudinary.
     */
    static uploadBuffer(buffer, opts = {}) {
        const spanName = 'cloudinary.upload_buffer';
        const tags = CloudinaryService.#getTags(opts.public_id, 'upload_buffer');
        
        // 🚀 Wrap in Tracing span
        return Tracing.withSpan(spanName, () => {
            return new Promise((resolve, reject) => {
                const startTime = Date.now();
                
                const uploadStream = cloudinary.uploader.upload_stream(
                    opts,
                    (err, result) => {
                        const duration = Date.now() - startTime;
                        Metrics.timing('cloudinary.upload_ms', duration, tags);

                        if (err) {
                            Metrics.increment('cloudinary.upload_fail', 1, tags);
                            return reject(err);
                        }
                        
                        Metrics.increment('cloudinary.upload_success', 1, tags);
                        resolve(result);
                    }
                );
                streamifier.createReadStream(buffer).pipe(uploadStream);
            });
        });
    }

    /**
     * @desc Uploads a file from a local path, then deletes the local file.
     */
    static async uploadFromPath(path, opts = {}) {
        const spanName = 'cloudinary.upload_from_path';
        const tags = CloudinaryService.#getTags(opts.public_id, 'upload_path');
        const startTime = Date.now();
        
        // 🚀 Wrap in Tracing span
        const res = await Tracing.withSpan(spanName, async () => {
            try {
                const result = await cloudinary.uploader.upload(path, opts);
                Metrics.timing('cloudinary.upload_ms', Date.now() - startTime, tags);
                Metrics.increment('cloudinary.upload_success', 1, tags);
                return result;
            } catch (error) {
                Metrics.timing('cloudinary.upload_ms', Date.now() - startTime, { ...tags, status: 'failed' });
                Metrics.increment('cloudinary.upload_fail', 1, tags);
                throw error;
            }
        });
        
        // Local file cleanup (always attempt, outside of main timing/span)
        try {
            if (fs.existsSync(path)) {
                fs.unlinkSync(path);
                logger.debug(`Successfully deleted local file: ${path}`);
            }
        } catch (e) {
            logger.warn(`Failed to delete local file at ${path}: ${e.message}`);
        }
        
        return res;
    }

    /**
     * @desc Deletes a single resource by public ID.
     */
    static async deleteByPublicId(publicId, options = {}) {
        const spanName = 'cloudinary.delete_by_id';
        const resourceType = options.resource_type || 'image';
        const tags = CloudinaryService.#getTags(publicId, `delete_${resourceType}`);
        const startTime = Date.now();

        // 🚀 Wrap in Tracing span
        return await Tracing.withSpan(spanName, async (span) => {
            span.setAttribute('cloudinary.public_id', publicId);
            span.setAttribute('cloudinary.resource_type', resourceType);
            
            try {
                const result = await cloudinary.uploader.destroy(publicId, options);
                
                const duration = Date.now() - startTime;
                Metrics.timing('cloudinary.delete_ms', duration, tags);
                
                if (result.result === 'not found') {
                    Metrics.increment('cloudinary.delete_not_found', 1, tags);
                    logger.warn(`Cloudinary Delete: Resource not found for ID ${publicId}.`);
                } else if (result.result === 'ok') {
                    Metrics.increment('cloudinary.delete_success', 1, tags);
                } else {
                    Metrics.increment('cloudinary.delete_fail_result', 1, tags);
                    logger.error(`Cloudinary Delete: Unexpected result for ID ${publicId}.`, { result: result.result });
                }
                
                return result;
            } catch (error) {
                Metrics.timing('cloudinary.delete_ms', Date.now() - startTime, { ...tags, status: 'failed' });
                Metrics.increment('cloudinary.delete_fail', 1, tags);
                throw error;
            }
        });
    }

    /**
     * @desc Replaces an old media resource with a new one.
     */
    static async replaceMedia({ oldPublicId, newBuffer, newPath, opts = {} }) {
        const spanName = 'cloudinary.replace_media';
        
        // 🚀 Wrap the entire replacement sequence in a Tracing span
        return await Tracing.withSpan(spanName, async () => {
            if (oldPublicId) {
                try {
                    // Attempt deletion of old media
                    await CloudinaryService.deleteByPublicId(oldPublicId, opts);
                } catch (e) {
                    logger.error(`Failed to delete old media ${oldPublicId} during replacement: ${e.message}`);
                    /* ignore failure to delete old media to prioritize new upload */
                }
            }

            if (newBuffer) return await CloudinaryService.uploadBuffer(newBuffer, opts);
            if (newPath) return await CloudinaryService.uploadFromPath(newPath, opts);
            
            throw new Error("No new buffer or path provided");
        });
    }

    /**
     * @desc SENTINEL GRADE: Centralized function to destroy multiple product media resources.
     * @param {Array<Object>} images - Array of image objects { public_id: string }.
     * @param {Object | null} video - Video object { public_id: string } or null.
     * @returns {Object} Report on deletion status.
     */
    static async destroyCloudinaryMedia(images = [], video = null) {
        const spanName = 'cloudinary.destroy_multiple_media';
        const tags = CloudinaryService.#getTags('bulk_operation', 'bulk_delete');
        
        // 🚀 Wrap the bulk deletion in a Tracing span
        return await Tracing.withSpan(spanName, async (span) => {
            
            const publicIds = [];
            const deletionOptions = [];
            
            // 1. Collect image public IDs (type: image)
            if (Array.isArray(images)) {
                images.forEach(img => {
                    if (img.public_id) {
                        publicIds.push(img.public_id);
                        deletionOptions.push({ resource_type: "image" });
                    }
                });
            }
            
            // 2. Collect video public ID (type: video)
            if (video && video.public_id) {
                publicIds.push(video.public_id);
                deletionOptions.push({ resource_type: "video" }); 
            }

            span.setAttribute('cloudinary.total_assets', publicIds.length);

            if (publicIds.length === 0) {
                logger.info("Cloudinary Cleanup: No media IDs provided for destruction.");
                return { deleted: 0, status: "No IDs" };
            }

            logger.info(`Cloudinary Cleanup: Starting bulk deletion of ${publicIds.length} assets.`);
            const startTime = Date.now();

            const results = await Promise.all(
                publicIds.map((id, index) => {
                    // Use the explicit deleteByPublicId for better logging/control over options
                    // Note: This relies on the individual `deleteByPublicId` method for its own metrics/tracing
                    return CloudinaryService.deleteByPublicId(id, deletionOptions[index])
                        .then(res => ({ id, status: res.result }))
                        .catch(err => {
                            logger.error(`Failed to delete asset ${id}.`, { error: err.message });
                            return { id, status: 'failed', error: err.message };
                        });
                })
            );
            
            const successCount = results.filter(r => r.status === 'ok').length;
            const duration = Date.now() - startTime;
            
            logger.info(`Cloudinary Cleanup: Finished. Successfully deleted ${successCount}/${publicIds.length} assets.`);

            // 📊 Final Bulk Metrics
            Metrics.timing('cloudinary.bulk_delete_ms', duration, tags);
            Metrics.gauge('cloudinary.bulk_delete_total', publicIds.length, tags);
            Metrics.gauge('cloudinary.bulk_delete_success', successCount, tags);
            
            return {
                deleted: successCount,
                results: results,
                status: successCount === publicIds.length ? "complete" : "partial_failure",
            };
        });
    }

    /**
     * @desc Server-side signature for direct client uploads (optional)
     */
    static createSignature(payload) {
        // No heavy I/O, no need for tracing span or metrics
        const signature = cloudinary.utils.api_sign_request(
            payload,
            process.env.CLOUDINARY_API_SECRET
        );
        return signature;
    }
}

module.exports = CloudinaryService;