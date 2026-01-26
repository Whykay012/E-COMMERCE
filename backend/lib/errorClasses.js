// lib/errorClasses.js

/**
 * Custom error class for non-recoverable payout failures.
 * When thrown, the job queue should mark the job as permanently failed and stop retrying.
 * Examples: Insufficient funds, Invalid recipient details, Sanction block.
 */
export class PermanentPayoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PermanentPayoutError';
        // Ensure the prototype chain is set up correctly
        Object.setPrototypeOf(this, PermanentPayoutError.prototype);
    }
}

/**
 * Custom error class for transient, temporary failures.
 * When thrown, the job queue should automatically retry the job (e.g., via BullMQ).
 * Examples: Network timeout, PSP API rate limit, Database contention.
 */
export class TransientPayoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TransientPayoutError';
        // Ensure the prototype chain is set up correctly
        Object.setPrototypeOf(this, TransientPayoutError.prototype);
    }
}