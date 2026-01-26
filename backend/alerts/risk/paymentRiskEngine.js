/**
 * services/risk/unifiedRiskEngine.js
 * UNIFIED RISK ENGINE - Absolute Robustness Edition
 * Combines Identity Intelligence + Payment Protection + Unified Metrics
 */

const crypto = require('crypto');
const { timingSafeEqual } = crypto;
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const Redis = require("ioredis");

// 💡 Internal Dependencies
const { evaluateGeoRisk } = require("../geoip/geoIpService");
const ThresholdConfig = require("../model/thresholdConfig"); 
const { convertAmountToNGN } = require("./currencyService");
const mfaTokenStore = require('../mfa/redisMfaStore'); 
const EventClient = require('../utils/eventMeshClient'); 
const Tracing = require('../utils/tracingClient');
const Logger = require('../utils/logger');
const UnauthorizedError = require('../errors/unauthenication-error');

// 🚀 UPGRADE: Import shared metrics from the Unified Hub
const { riskScoreHistogram, riskActionCounter } = require("../geoip/prometheus");

const redis = new Redis(process.env.REDIS_URL);

// ------------------ CONFIG ------------------
const CFG = {
    TTL_SEC: 300,
    MAX_ATTEMPTS: 3,
    SHA_ALGO: 'sha512',
    SCRYPT_PARAMS: { N: 131072, r: 8, p: 1 },
    HIGH_VALUE_NGN_THRESHOLD: 300000,
    ABSOLUTE_RISK_FLOOR: 75, 
    HIGH_VALUE_RISK_SCORE: 100
};

// ------------------ HELPER FUNCTIONS ------------------

async function getThresholds() {
    try {
        const config = await ThresholdConfig.findOne({ active: true }).lean();
        return {
            highAmount: config?.highAmount || 500,
            highGeoRisk: config?.highGeoRisk || 70,
            velocityLimit: config?.velocityLimit || 5,
            failSafeAction: config?.failSafeAction || "block",
        };
    } catch (err) {
        Logger.error("CRITICAL: Failed to fetch thresholds. Using hardened defaults.", err);
        return {
            highAmount: 1000000, 
            highGeoRisk: 100, 
            velocityLimit: 100, 
            failSafeAction: "block", 
        };
    }
}

async function checkVelocity(userId, ip, type = 'auth') {
    const key = `risk:velocity:${type}:${userId || ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 3600); 
    return count;
}

/* ─────────────────────────────
    🛡️ CORE RISK EVALUATOR
───────────────────────────── */
async function computeComprehensiveRisk(userContext) {
    const { userId, ip, context = {} } = userContext;
    const geo = await evaluateGeoRisk(ip);
    const thresholds = await getThresholds();
    
    const { amount = 0, currency = "NGN" } = context?.payment || {};
    const signals = [];
    let score = 0;

    try {
        let amountInNGN = 0;
        try {
            amountInNGN = await convertAmountToNGN(amount, currency, CFG.HIGH_VALUE_NGN_THRESHOLD);
        } catch (convertErr) {
            Logger.error("Currency conversion failed:", convertErr);
            amountInNGN = (currency === 'NGN') ? amount : 0; 
        }

        if (amountInNGN >= CFG.HIGH_VALUE_NGN_THRESHOLD) {
            score = CFG.HIGH_VALUE_RISK_SCORE;
            signals.push({ code: "HIGH_VALUE_TRANSACTION", weight: 100, severity: "critical" });
        } else {
            if (amount > thresholds.highAmount) {
                score += 40;
                signals.push({ code: "HIGH_AMOUNT", weight: 40 });
            }
            if (geo?.countryRiskScore >= thresholds.highGeoRisk) {
                score += 50;
                signals.push({ code: "HIGH_RISK_GEO", weight: 50 });
            }
            const velocityCount = await checkVelocity(userId, ip, context.payment ? 'payment' : 'auth');
            if (velocityCount > thresholds.velocityLimit) {
                score += 30;
                signals.push({ code: "HIGH_VELOCITY", weight: 30 });
            }
        }
    } catch (err) {
        Logger.error("Risk engine internal error:", err);
        score = 100;
        signals.push({ code: "ENGINE_ERROR", weight: 100 });
    }

    return { totalScore: Math.min(score, 100), signals, geo };
}

/* ─────────────────────────────
    🚀 INITIATE MFA
───────────────────────────── */
exports.initiateMfa = async (userContext, reqContext = {}) => {
    return Tracing.withSpan('mfa.initiate.adaptive', async (span) => {
        const { userId, session } = { ...userContext, ...reqContext };

        const risk = await computeComprehensiveRisk(userContext);
        const mode = (risk.totalScore >= CFG.ABSOLUTE_RISK_FLOOR) ? 'ABSOLUTE' : 'ZENITH';
        const nonce = crypto.randomBytes(mode === 'ABSOLUTE' ? 64 : 32).toString('base64url');
        const rawCode = crypto.randomInt(100000, 999999).toString();

        let state;
        if (mode === 'ZENITH') {
            const hash = crypto.createHash(CFG.SHA_ALGO).update(rawCode).digest('hex');
            state = { u: userId, m: 'ZENITH', h: hash, a: 0, r: risk.totalScore };
        } else {
            const salt = crypto.randomBytes(32);
            const proof = await scrypt(rawCode, salt, 64, CFG.SCRYPT_PARAMS);
            state = { 
                u: userId, m: 'ABSOLUTE', 
                p: proof.toString('hex'), s: salt.toString('hex'), 
                a: 0, r: risk.totalScore 
            };
        }

        await mfaTokenStore.setMfaState(nonce, state, CFG.TTL_SEC);

        // Publish via Traced Event Client
        await EventClient.publish({
            eventType: 'MFA_CHALLENGE_DISPATCH',
            userId: userId,
            payload: { 
                code: rawCode, 
                mode, 
                riskScore: risk.totalScore,
                reasons: risk.signals.map(s => s.code)
            },
            details: {
                ip: userContext.ip,
                userAgent: reqContext.userAgent || 'unknown'
            }
        }, { session });

        // 🚀 UPGRADE: Observe shared metrics
        riskScoreHistogram.observe(risk.totalScore);
        riskActionCounter.inc({ action: 'initiated', mode });

        return {
            mfaRequired: true,
            mfaMode: mode,
            mfaNonce: nonce,
            expiresIn: CFG.TTL_SEC,
            riskScore: risk.totalScore,
            reference: nonce.slice(-6)
        };
    });
};

/* ─────────────────────────────
    ✅ VERIFY MFA
───────────────────────────── */
exports.verifyMfa = async (nonce, providedCode) => {
    return Tracing.withSpan('mfa.verify.adaptive', async (span) => {
        
        const state = await mfaTokenStore.atomicIncrementAndFetch(nonce);

        if (!state || state.a > CFG.MAX_ATTEMPTS) {
            await performFakeWork(); 
            throw new UnauthorizedError('MFA Session Expired or Locked.');
        }

        let isValid = false;
        if (state.m === 'ZENITH') {
            const inputHash = crypto.createHash(CFG.SHA_ALGO).update(providedCode).digest('hex');
            isValid = timingSafeEqual(
                Buffer.from(state.h, 'hex'), 
                Buffer.from(inputHash, 'hex')
            );
        } else {
            const test = await scrypt(
                providedCode, 
                Buffer.from(state.s, 'hex'), 
                64, 
                CFG.SCRYPT_PARAMS
            );
            isValid = timingSafeEqual(Buffer.from(state.p, 'hex'), test);
        }

        if (!isValid) {
            // 🚀 UPGRADE: Count failure in shared metrics
            riskActionCounter.inc({ action: 'failure', mode: state.m });
            throw new UnauthorizedError('Invalid verification code.');
        }

        await mfaTokenStore.destroy(nonce);
        
        // 🚀 UPGRADE: Count success in shared metrics
        riskActionCounter.inc({ action: 'success', mode: state.m });

        return { 
            userId: state.u, 
            status: 'VERIFIED', 
            riskLevel: state.r,
            verifiedAt: new Date().toISOString()
        };
    });
};

async function performFakeWork() {
    const dummy = crypto.randomBytes(32);
    await scrypt(dummy, dummy, 64, CFG.SCRYPT_PARAMS);
}