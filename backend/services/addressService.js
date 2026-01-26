// services/addressService.js (Transactional & Causal Consistency)

const Address = require('../model/address');
const mongoose = require('mongoose'); 
const redisClient = require('../lib/redisClient'); 
// Access the exported queue from worker module (assuming addressWorker.js exposes it)
const addressQueue = require('../backgroundRun/addressWorker').addressQueue; 
const logger = require('../config/logger'); 
const AuditLogger = require('../services/auditLogger'); 
const Tracing = require('../utils/tracingClient'); 
const metrics = require('../utils/metricsClient.js'); 
const { InternalServerError, NotFoundError } = require('../errors/custom-errors'); 

// --- Caching Constants & Configuration ---
const USER_DEFAULT_ADDRESS_KEY = (userId) => `user:address:default:${userId}`;
const USER_ADDRESSES_LIST_KEY = (userId) => `user:address:list:${userId}`; 
const ADDRESS_CACHE_TTL = 60 * 60; 

// --- BullMQ Job Configuration ---
const DEFAULT_GEOCODE_JOB_OPTIONS = {
    attempts: 3, 
    backoff: { type: 'exponential', delay: 5000 },
    priority: 10, 
    removeOnComplete: true,
    removeOnFail: false, // Let DLQ handler remove it
};

class AddressService {
    
    // ----------------------------------------------------------------------
    // 📝 ADDRESS CREATION (Atomic Transactional Integrity & Queueing with Tracing)
    // ----------------------------------------------------------------------

    /**
     * @desc Creates a new address using a MongoDB transaction for atomicity, 
     * invalidates cache, and queues geocoding with tracing context.
     */
    static async createAddress(userId, addressData, jobPriority = 10) {
        // 🚀 TRACING: Start main span for API call
        return Tracing.withSpan('AddressService:createAddress', async (span) => {
            span.setAttributes({ 'user.id': userId, 'address.isDefault': addressData.isDefault });
            metrics.increment('address_create_total'); // 📊 METRICS

            const traceContext = Tracing.serializeContext(Tracing.getCurrentContext());
            
            const session = await mongoose.startSession({
                causalConsistency: true 
            });

            try {
                const newAddress = await session.withTransaction(async () => {
                    
                    // 1. Clear old default flag if necessary (Atomic Write)
                    if (addressData.isDefault) {
                        await Address.updateMany(
                            { user: userId, isDefault: true }, 
                            { isDefault: false }, 
                            { session, writeConcern: { w: 'majority' } }
                        );
                        logger.debug('ADDRESS_PREVIOUS_DEFAULT_CLEARED_TXN', { userId });
                    }
                    
                    // 2. Create the new address (Atomic Write)
                    const [doc] = await Address.create([{ ...addressData, user: userId }], { 
                        session,
                        writeConcern: { w: 'majority', j: true }
                    });
                    
                    logger.debug('ADDRESS_CREATED_TXN_SUCCESS', { addressId: doc._id });
                    return doc;

                }, {
                    readConcern: { level: 'majority' }, 
                    writeConcern: { w: 'majority' }, 
                });

                const addressId = newAddress._id.toString();
                span.setAttribute('address.id', addressId);

                // 3. 🗑️ Invalidate All Related Caches (Post-Commit)
                await this._invalidateAddressCache(userId);

                // 4. Queue High-Latency Task with TRACING CONTEXT
                const fullAddress = `${newAddress.street}, ${newAddress.city}, ${newAddress.state}, ${newAddress.country}`;
                
                await addressQueue.add('geocode-address', {
                    addressId: addressId,
                    fullAddress: fullAddress,
                    traceContext: traceContext, // 🔗 Propagates context
                    userId: userId
                }, {
                    ...DEFAULT_GEOCODE_JOB_OPTIONS,
                    priority: jobPriority,
                    jobId: `geocode:${addressId}`
                });

                logger.info('ADDRESS_CREATED_AND_GEOCODE_QUEUED', { userId, addressId, jobPriority });
                span.addEvent('geocode_job_queued');

                AuditLogger.log({ level: 'INFO', event: 'ADDRESS_CREATE_SUCCESS', userId: userId, details: { addressId: addressId, isDefault: newAddress.isDefault } });
                metrics.increment('address_create_success_total'); // 📊 METRICS
                
                return newAddress;

            } catch (error) {
                logger.error('ADDRESS_CREATE_TXN_FATAL_ERROR', { userId, err: error.message, stack: error.stack });
                metrics.increment('address_create_fail_total'); // 📊 METRICS
                span.recordException(error);
                throw new InternalServerError(`Failed to create address: ${error.message}`);
            } finally {
                session.endSession();
            }
        });
    }

    // ----------------------------------------------------------------------
    // 📝 ADDRESS UPDATE (Transactional Integrity)
    // ----------------------------------------------------------------------

    /**
     * @desc Updates an existing address using a transaction, handling default flag integrity.
     */
    static async updateAddress(userId, addressId, updateData) {
        // 🚀 TRACING: Start main span for API call
        return Tracing.withSpan('AddressService:updateAddress', async (span) => {
            span.setAttributes({ 'user.id': userId, 'address.id': addressId, 'fields.updated': Object.keys(updateData).join(',') });
            metrics.increment('address_update_total'); // 📊 METRICS

            const traceContext = Tracing.serializeContext(Tracing.getCurrentContext());
            
            const session = await mongoose.startSession({ causalConsistency: true });
            let updatedAddress = null;

            try {
                updatedAddress = await session.withTransaction(async () => {
                    // 1. Clear old default flag if a new default is being set
                    if (updateData.isDefault) {
                        await Address.updateMany(
                            { user: userId, isDefault: true }, 
                            { isDefault: false }, 
                            { session, writeConcern: { w: 'majority' } }
                        );
                        logger.debug('ADDRESS_PREVIOUS_DEFAULT_CLEARED_TXN', { userId });
                    }
                    
                    // 2. Update the specific address
                    const result = await Address.findOneAndUpdate(
                        { _id: addressId, user: userId }, 
                        updateData, 
                        { new: true, runValidators: true, session, writeConcern: { w: 'majority' } }
                    ).lean();

                    if (!result) {
                        throw new NotFoundError(`Address ID ${addressId} not found or unauthorized.`);
                    }
                    
                    return result;
                }, {
                    readConcern: { level: 'majority' }, 
                    writeConcern: { w: 'majority' }, 
                });

                // 3. 🗑️ Invalidate All Related Caches
                await this._invalidateAddressCache(userId);
                
                // 4. Re-queue Geocoding if necessary
                const addressFieldsChanged = updateData.street || updateData.city || updateData.country || updateData.postalCode;
                const needsGeocoding = addressFieldsChanged && updatedAddress.metadata?.isGeocoded !== true;

                if (needsGeocoding) {
                     const fullAddress = `${updatedAddress.street}, ${updatedAddress.city}, ${updatedAddress.state}, ${updatedAddress.country}`;
                     await addressQueue.add('geocode-address', {
                         addressId: addressId,
                         fullAddress: fullAddress,
                         traceContext: traceContext, // 🔗 Propagates context
                         userId: userId
                     }, {
                         ...DEFAULT_GEOCODE_JOB_OPTIONS,
                         priority: 5, 
                         jobId: `geocode:${addressId}`
                     });
                     logger.info('ADDRESS_UPDATED_AND_REQUEUED_GEOCODE', { userId, addressId });
                     span.addEvent('geocode_job_requeued');
                }

                AuditLogger.log({
                    level: 'INFO', 
                    event: 'ADDRESS_UPDATE_SUCCESS',
                    userId: userId,
                    details: { addressId: addressId, fieldsUpdated: Object.keys(updateData) }
                });
                metrics.increment('address_update_success_total'); // 📊 METRICS

                return updatedAddress;
            } catch (error) {
                logger.error('ADDRESS_UPDATE_TXN_FATAL_ERROR', { userId, addressId, err: error.message });
                metrics.increment('address_update_fail_total'); // 📊 METRICS
                span.recordException(error);
                throw error instanceof NotFoundError ? error : new InternalServerError(`Failed to update address: ${error.message}`);
            } finally {
                session.endSession();
            }
        });
    }
    
    // ----------------------------------------------------------------------
    // ❌ ADDRESS DELETION (Transactional Integrity)
    // ----------------------------------------------------------------------
    
    /**
     * @desc Deletes an address using a transaction and ensures cache is invalidated.
     */
    static async deleteAddress(userId, addressId) {
        // 🚀 TRACING: Start main span for API call
        return Tracing.withSpan('AddressService:deleteAddress', async (span) => {
            span.setAttributes({ 'user.id': userId, 'address.id': addressId });
            metrics.increment('address_delete_total'); // 📊 METRICS

            const session = await mongoose.startSession({ causalConsistency: true });
            
            try {
                await session.withTransaction(async () => {
                    const deletedDoc = await Address.findOneAndDelete({ 
                        _id: addressId, 
                        user: userId 
                    }, { 
                        session,
                        writeConcern: { w: 'majority', j: true }
                    });
                    
                    if (!deletedDoc) {
                        throw new NotFoundError(`Address ID ${addressId} not found or unauthorized for deletion.`);
                    }
                    return deletedDoc;
                }, {
                    writeConcern: { w: 'majority' }, 
                });

                // 2. 🗑️ Invalidate All Related Caches (Post-Commit)
                await this._invalidateAddressCache(userId);
                
                logger.info('ADDRESS_DELETED_SUCCESS', { userId, addressId });
                
                AuditLogger.log({
                    level: 'SECURITY', 
                    event: 'ADDRESS_DELETE_SUCCESS',
                    userId: userId,
                    details: { addressId: addressId }
                });
                metrics.increment('address_delete_success_total'); // 📊 METRICS

                return true;
            } catch (error) {
                logger.error('ADDRESS_DELETE_TXN_FATAL_ERROR', { userId, addressId, err: error.message });
                metrics.increment('address_delete_fail_total'); // 📊 METRICS
                span.recordException(error);
                throw error instanceof NotFoundError ? error : new InternalServerError(`Failed to delete address: ${error.message}`);
            } finally {
                session.endSession();
            }
        });
    }

    // ----------------------------------------------------------------------
    // 📝 GET DEFAULT ADDRESS (Read Concern: majority)
    // ----------------------------------------------------------------------
    static async getDefaultAddress(userId) {
        // 🚀 TRACING: Start main span for API call
        return Tracing.withSpan('AddressService:getDefaultAddress', async (span) => {
            span.setAttributes({ 'user.id': userId });
            metrics.increment('address_read_default_total'); // 📊 METRICS
            
            const cached = await redisClient.get(USER_DEFAULT_ADDRESS_KEY(userId));
            if (cached) {
                metrics.counter('cache_hits', 1, { resource: 'address' });
                span.setAttribute('cache.hit', true);
                return JSON.parse(cached);
            }

            metrics.counter('cache_misses', 1, { resource: 'address' });
            span.setAttribute('cache.hit', false);
            
            // Use readConcern: 'majority' for high data guarantee on critical reads
            const defaultAddress = await Address.findOne({ user: userId, isDefault: true })
                .lean()
                .readConcern('majority'); 

            if (defaultAddress) {
                await redisClient.set(USER_DEFAULT_ADDRESS_KEY(userId), JSON.stringify(defaultAddress), 'EX', ADDRESS_CACHE_TTL);
            }
            return defaultAddress;
        });
    }
    
    // ----------------------------------------------------------------------
    // 🛠️ INTERNAL UTILITIES (Static Helpers)
    // ----------------------------------------------------------------------
    
    /**
     * Helper to consistently invalidate all relevant cache keys for a user.
     */
    static async _invalidateAddressCache(userId) {
        // 🚀 TRACING: Internal utility span
        return Tracing.withSpan('AddressService:invalidateCache', async (span) => {
            span.setAttributes({ 'user.id': userId });
            const keysToInvalidate = [
                USER_DEFAULT_ADDRESS_KEY(userId), 
                USER_ADDRESSES_LIST_KEY(userId)
            ];
            
            const deletedCount = await redisClient.del(keysToInvalidate);
            logger.debug('ADDRESS_CACHE_INVALIDATED', { userId, deletedCount });
            span.setAttribute('keys.deleted_count', deletedCount);
            return deletedCount;
        });
    }
}

module.exports = AddressService;