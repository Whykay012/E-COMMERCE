// utils/concurrencySemaphore.js (Semaphore for Adaptive Concurrency Control)

class Semaphore {
    constructor(maxConcurrency) {
        this.max = maxConcurrency;
        this.current = 0;
        this.queue = [];
        this.VERSION = '1.0.0';
    }

    async acquire() {
        if (this.current < this.max) {
            this.current++;
            return;
        }

        return new Promise(resolve => {
            this.queue.push(resolve);
        });
    }

    release() {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            next();
        } else {
            this.current = Math.max(0, this.current - 1);
        }
    }

    getStatus() {
        return {
            max: this.max,
            current: this.current,
            waiting: this.queue.length
        };
    }
}

module.exports = Semaphore;