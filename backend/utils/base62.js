/**
 * utils/base62.js
 * Generates highly-entropic, short, unique referral codes using non-biased (rejection sampling) logic.
 * Uses Node's built-in crypto module for maximum security and efficiency.
 */
const crypto = require('crypto');

// Base62 alphabet (62 characters: 0-9, A-Z, a-z)
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length; // 62
// The maximum multiple of BASE that is <= 255. (256 - (256 % 62) = 248)
// Any random byte above 247 must be rejected to ensure uniform distribution.
const MAX_ACCEPTABLE_BYTE = 256 - (256 % BASE); 

const CODE_LENGTH = 10;

/**
 * Generates a cryptographically secure, random Base62 string of a fixed length.
 * This implementation uses rejection sampling to ensure zero statistical bias,
 * a key requirement for cryptographically secure, large-scale systems.
 * * @param {number} length - The desired length of the code (default is 10).
 * @returns {string} The non-biased Base62 code.
 */
const generateSecureCode = (length = CODE_LENGTH) => {
    let code = '';
    
    // We expect to use slightly more than 'length' bytes due to rejections,
    // so we buffer a slightly larger amount (e.g., length * 1.5).
    const BUFFER_SIZE = Math.ceil(length * 1.5);
    let bytes = crypto.randomBytes(BUFFER_SIZE);
    let byteIndex = 0;

    while (code.length < length) {
        if (byteIndex >= bytes.length) {
            // Refill the buffer if exhausted (though rare with the 1.5 multiplier)
            bytes = crypto.randomBytes(BUFFER_SIZE);
            byteIndex = 0;
        }

        const byte = bytes[byteIndex++];

        // 1. Rejection Sampling Check: 
        // Only accept the byte if it's less than 248 (MAX_ACCEPTABLE_BYTE).
        // This eliminates the bias from the modulo operation (256 % 62 = 12).
        if (byte < MAX_ACCEPTABLE_BYTE) {
            // 2. Map the unbiased byte to the Base62 alphabet
            const index = byte % BASE;
            code += ALPHABET[index];
        }
    }

    return code;
};

module.exports = {
    generateBase62Code: generateSecureCode, // Export using the original name for backward compatibility
    CODE_LENGTH: CODE_LENGTH, // Fixed length of 10
    // Strict Regex validation tied to the fixed length
    CODE_REGEX: new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`), 
};