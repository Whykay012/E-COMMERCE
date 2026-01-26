/**
 * repositories/referralRepository.js
 * Production-ready database access layer for the Referral system.
 * Implements Read-Through Caching, Atomic Updates, and Keyset Pagination.
 */
const Referral = require('../model/Referral');
const mongoose = require('mongoose');

// ✅ Correct Redis usage
const { getRedisClient } = require('../utils/redisClient');
const redis = getRedisClient();

// ✅ Structured logger
const logger = require('../utils/logger');

// --- Constants ---
const REFERRAL_CACHE_PREFIX = 'referral:code:';
const REFERRAL_TTL_SECONDS = 3600;

class ReferralRepository {

    async createCode(code, referrerId) {
        try {
            const newReferral = await Referral.create({
                code,
                referrerId: new mongoose.Types.ObjectId(referrerId),
            });

            const cacheKey = `${REFERRAL_CACHE_PREFIX}${code}`;

            // ✅ Write-through cache
            await redis.set(
                cacheKey,
                JSON.stringify(newReferral.toObject()),
                'EX',
                REFERRAL_TTL_SECONDS
            );

            logger.info({ code, referrerId }, 'Referral code created & cached');
            return newReferral;

        } catch (error) {
            logger.error({ err: error, code, referrerId }, 'Create referral failed');
            throw error;
        }
    }

    async findActiveCodeByCode(code) {
        const cacheKey = `${REFERRAL_CACHE_PREFIX}${code}`;

        try {
            // ✅ Read-through cache
            const cached = await redis.get(cacheKey);
            if (cached) {
                logger.debug({ code }, 'Referral cache hit');
                return JSON.parse(cached);
            }

            logger.debug({ code }, 'Referral cache miss');

            const referral = await Referral.findOne({
                code,
                isActive: true,
                $or: [
                    { expiresAt: { $exists: false } },
                    { expiresAt: { $gt: new Date() } },
                ],
            })
            .select('code referrerId usageCount maxUsages isActive')
            .lean()
            .exec();

            if (referral) {
                await redis.set(
                    cacheKey,
                    JSON.stringify(referral),
                    'EX',
                    REFERRAL_TTL_SECONDS
                );
            }

            return referral;

        } catch (error) {
            logger.error({ err: error, code }, 'Find referral failed');
            throw error;
        }
    }

    async recordUsage(code, referredId, earnedAmount, maxUsages = Infinity) {
        const cacheKey = `${REFERRAL_CACHE_PREFIX}${code}`;

        try {
            const objectReferredId = new mongoose.Types.ObjectId(referredId);

            const query = {
                code,
                isActive: true,
                'usages.referredId': { $ne: objectReferredId },
            };

            if (Number.isFinite(maxUsages)) {
                query.usageCount = { $lt: maxUsages };
            }

            const result = await Referral.updateOne(
                query,
                {
                    $inc: { usageCount: 1 },
                    $push: {
                        usages: {
                            referredId: objectReferredId,
                            earnedAmount,
                            usedAt: new Date(),
                        },
                    },
                }
            ).exec();

            if (result.modifiedCount === 1) {
                // ✅ Write-back cache invalidation
                await redis.del(cacheKey);

                logger.info({ code, referredId }, 'Referral usage recorded');
                return true;
            }

            logger.warn({ code, referredId }, 'Referral usage blocked');
            return false;

        } catch (error) {
            logger.error({ err: error, code, referredId }, 'Record usage failed');
            await redis.del(cacheKey); // fail-safe invalidation
            throw error;
        }
    }

    async findCodesByReferrer(referrerId, limit, lastId = null) {
        try {
            const query = { referrerId: new mongoose.Types.ObjectId(referrerId) };

            if (lastId) {
                query._id = { $lt: new mongoose.Types.ObjectId(lastId) };
            }

            const data = await Referral.find(query)
                .select('_id code isActive usageCount createdAt maxUsages')
                .sort({ _id: -1 })
                .limit(limit + 1)
                .lean()
                .exec();

            const hasNextPage = data.length > limit;

            return {
                data: hasNextPage ? data.slice(0, limit) : data,
                hasNextPage,
            };

        } catch (error) {
            logger.error({ err: error, referrerId }, 'Keyset pagination failed');
            throw error;
        }
    }

    async deactivateCode(code) {
        const cacheKey = `${REFERRAL_CACHE_PREFIX}${code}`;

        try {
            const result = await Referral.updateOne(
                { code, isActive: true },
                { $set: { isActive: false } }
            ).exec();

            if (result.modifiedCount === 1) {
                await redis.del(cacheKey);
                logger.info({ code }, 'Referral code deactivated');
                return true;
            }

            return false;

        } catch (error) {
            logger.error({ err: error, code }, 'Deactivate referral failed');
            throw error;
        }
    }
}

module.exports = new ReferralRepository();
