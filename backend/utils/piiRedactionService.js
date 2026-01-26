/**
 * utils/piiRedactionService.js
 * ZENITH SECURITY - PII Redaction & Pseudonymization Service
 * Supports: Full Redaction, Deterministic Hashing, and IP Masking
 */

const crypto = require('crypto');

// Fields that should be completely hidden
const REDACT_FIELDS = ['creditCardNumber', 'ssn', 'password', 'cvv', 'pin', 'address'];

// Fields that should be hashed (allows for correlation in logs without exposing raw ID)
const HASH_FIELDS = ['userId', 'aggregateId', 'email', 'phone', 'accountNumber'];

// Fields that should be partially masked
const MASK_FIELDS = ['ip', 'ipAddress', 'ipv6'];

const SALT = process.env.PII_HASH_SALT || 'zenith-default-salt-change-me';

const PIIProcessor = {
    
    /**
     * @desc Hashes a value using SHA-256 with a salt.
     * Use this for IDs so you can track "User A" across logs without knowing who "User A" is.
     */
    hashValue(value) {
        if (!value) return value;
        return crypto
            .createHmac('sha256', SALT)
            .update(String(value).toLowerCase())
            .digest('hex')
            .slice(0, 16); // 16 chars is enough for log correlation
    },

    /**
     * @desc Masks an IP address (e.g., 192.168.1.45 -> 192.168.xxx.xxx)
     */
    maskIP(ip) {
        if (typeof ip !== 'string') return ip;
        if (ip.includes('.')) {
            // IPv4
            return ip.split('.').slice(0, 2).join('.') + '.xxx.xxx';
        } else if (ip.includes(':')) {
            // IPv6
            return ip.split(':').slice(0, 3).join(':') + ':xxxx:xxxx';
        }
        return '[MASKED_IP]';
    },

    /**
     * @desc Recursively processes objects to apply security policies.
     */
    redact(data) {
        if (typeof data !== 'object' || data === null) {
            return data;
        }

        const cleanedData = Array.isArray(data) ? [] : {};

        for (const key in data) {
            if (!Object.prototype.hasOwnProperty.call(data, key)) continue;

            const value = data[key];

            // 1. Full Redaction
            if (REDACT_FIELDS.includes(key)) {
                cleanedData[key] = '[REDACTED]';
            } 
            // 2. Deterministic Hashing (Pseudonymization)
            else if (HASH_FIELDS.includes(key)) {
                cleanedData[key] = `hash:${this.hashValue(value)}`;
            } 
            // 3. IP Masking
            else if (MASK_FIELDS.includes(key)) {
                cleanedData[key] = this.maskIP(value);
            } 
            // 4. Recursive traversal for nested objects/arrays
            else if (typeof value === 'object' && value !== null) {
                cleanedData[key] = this.redact(value);
            } 
            // 5. Safe fields
            else {
                cleanedData[key] = value;
            }
        }

        return cleanedData;
    }
};

module.exports = PIIProcessor;