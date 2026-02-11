// utils/healthMonitorFactory.js (TRANSCENDENT APEX: Lifecycle-Aware Singleton)

const os = require('os');
const { version: appVersion } = require('../package.json');

/**
 * @typedef {'OK' | 'DEGRADED' | 'UNAVAILABLE' | 'SHUTTING_DOWN' | 'INITIALIZING' | 'WARMING_UP'} HealthStatus
 */
/**
 * @typedef {'BOOTING' | 'CONFIG_LOADED' | 'CACHE_READY' | 'COMPLETED'} StartupPhase
 */

// Configuration Defaults (Can be overridden via injection)
const DEFAULT_THRESHOLDS = {
    CPU_MAX_LOAD_AVG_DEGRADED: 0.8,
    MEMORY_MAX_HEAP_USED_MB_DEGRADED: 512,
    BREAKER_MAX_OPEN_COUNT_DEGRADED: 1,
    DEPENDENCY_TIMEOUT_MS: 1500,
};

let monitorInstance = null; // Singleton instance storage

/**
 * @class HealthMonitor
 * @desc Encapsulates all health check logic, requiring external dependencies and configuration to be injected at creation.
 */
class HealthMonitor {
    
    constructor(dependencies, config = {}) {
        this.deps = dependencies;
        this.config = { ...DEFAULT_THRESHOLDS, ...config };
        
        // --- APEX LIFECYCLE STATE ---
        this.isShuttingDown = false;
        /** @type {StartupPhase} */
        this.currentStartupPhase = 'BOOTING'; 
        this.readyForTraffic = false; // Flag set by an external LifecycleManager
    }

    // --- NEW: Lifecycle Management Methods ---

    /**
     * @desc Updates the internal startup phase. Used by the main boot sequence (e.g., 'CACHE_READY').
     * @param {StartupPhase} phase 
     * @param {boolean} [ready=false] - If true, sets readyForTraffic flag.
     */
    updateStartupPhase(phase, ready = false) {
        this.currentStartupPhase = phase;
        this.readyForTraffic = ready;
        this.deps.Logger.info('LIFECYCLE_PHASE_UPDATE', { phase, readyForTraffic: ready });
    }

    /**
     * @desc Triggers a self-healing action for a specific dependency (conceptual).
     * @param {string} dependencyName 
     */
    async initiateSelfHeal(dependencyName) {
        this.deps.Logger.alert('SELF_HEALING_INITIATED', { dependency: dependencyName });
        // In a real system, this would call a maintenance service:
        // await this.deps.MaintenanceClient.reconnect(dependencyName);
        return true; // Assume attempt initiated
    }

    // --- Core Dependency Checkers ---

    async checkDependency(name, action) {
        const startTime = Date.now();
        try {
            await Promise.race([
                action(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error(`Timeout after ${this.config.DEPENDENCY_TIMEOUT_MS}ms`)), 
                    this.config.DEPENDENCY_TIMEOUT_MS)
                )
            ]);
            const latencyMs = Date.now() - startTime;
            return { status: 'OK', message: `Connected and responsive.`, latencyMs };
        } catch (error) {
            const latencyMs = Date.now() - startTime;
            // PEAK: Check if the error is chronic and trigger self-heal (conceptual)
            if (error.message.includes("Connection refused")) {
                this.initiateSelfHeal(name);
            }
            this.deps.Logger.alert(`HEALTH_FAIL_${name.toUpperCase()}`, { error: error.message });
            return { status: 'UNAVAILABLE', message: `${name} check failed: ${error.message}`, latencyMs };
        }
    }

    async checkRedisHealth() {
        return this.checkDependency('Redis', async () => {
            const client = this.deps.getRedisClient();
            if (!client || client.status !== 'ready') {
                throw new Error(`Client not ready (Status: ${client?.status || 'uninitialized'})`);
            }
            await client.ping();
        });
    }

    async checkDatabaseHealth() {
        return this.checkDependency('Database', async () => {
            const db = this.deps.getDBConnection();
            await db.query('SELECT 1'); 
        });
    }
    
    /**
     * @desc Checks the health of the injected Message Queue Client.
     * **NEW: Specific Queue Health Check**
     */
    async checkQueueHealth() {
        return this.checkDependency('QueueClient', async () => {
            const queueClient = this.deps.getQueueClient();
            if (!queueClient || !queueClient.checkHealth) {
                // If the injected client doesn't expose the method, this is a configuration error
                throw new Error('Queue client is not initialized or lacks a checkHealth method.');
            }
            const status = await queueClient.checkHealth();
            if (status.status !== 'OK') {
                throw new Error(`Queue reported: ${status.reason || 'Not OK'}`);
            }
        });
    }

    // --- Resource & Breaker Checkers ---

    getResourceReport() {
        const memoryUsage = process.memoryUsage();
        const loadAvg = os.loadavg()[0]; 
        const heapUsedMB = (memoryUsage.heapUsed / 1024 / 1024);

        let status = 'OK';
        let message = 'Resources within limits.';

        if (loadAvg > this.config.CPU_MAX_LOAD_AVG_DEGRADED) {
            status = 'DEGRADED';
            message = `High CPU Load (${loadAvg.toFixed(2)}).`;
        }
        if (heapUsedMB > this.config.MEMORY_MAX_HEAP_USED_MB_DEGRADED) {
            status = 'DEGRADED';
            message = `High Memory Usage (${heapUsedMB.toFixed(2)}MB).`;
        }

        return {
            status,
            message,
            details: {
                uptimeSeconds: process.uptime(),
                cpuLoadAvg: parseFloat(loadAvg.toFixed(2)),
                memoryMB: {
                    rss: (memoryUsage.rss / 1024 / 1024).toFixed(2),
                    heapUsed: heapUsedMB.toFixed(2),
                    heapTotal: (memoryUsage.heapTotal / 1024 / 1024).toFixed(2),
                }
            }
        };
    }

    reportBreakerStatus() {
        const breakers = this.deps.getAllBreakers(); 
        const report = {};
        let openBreakerCount = 0;

        for (const [name, breaker] of Object.entries(breakers)) {
            const state = breaker.getState();
            report[name] = { state, errorRate: breaker.errorRate ? parseFloat(breaker.errorRate.toFixed(1)) : 0 };
            if (state === 'OPEN') {
                openBreakerCount++;
            }
        }

        let status = 'OK';
        if (openBreakerCount > 0) {
            status = openBreakerCount >= this.config.BREAKER_MAX_OPEN_COUNT_DEGRADED ? 'DEGRADED' : 'OK';
        }

        return {
            status,
            message: openBreakerCount > 0 
                ? `${openBreakerCount} circuit(s) are OPEN or HALF-OPEN.` 
                : 'All circuits CLOSED.',
            details: report,
            openBreakerCount
        };
    }

    // --- Public API Methods ---

    async generateReport(deepCheck = true) {
        const startTime = Date.now();
        const resourceStatus = this.getResourceReport();
        const breakerReport = this.reportBreakerStatus();
        let checks = {};

        // 1. Initial/Shutdown State Check (Highest Priority)
        if (this.isShuttingDown) {
            return this.createFinalReport('SHUTTING_DOWN', 'Application is draining requests.', {}, startTime);
        }
        if (!this.readyForTraffic) {
             // If deep check requested but not ready, we report WARMING_UP
            if (deepCheck) {
                const currentStatus = this.currentStartupPhase === 'BOOTING' ? 'INITIALIZING' : 'WARMING_UP';
                return this.createFinalReport(currentStatus, `Application in phase: ${this.currentStartupPhase}`, {}, startTime);
            }
        }
        
        // 2. Dependency Checks (Only for Readiness/Deep Check)
        if (deepCheck) {
            // PEAK: Run all critical checks in parallel
            const [redisStatus, dbStatus, queueStatus] = await Promise.all([
                this.checkRedisHealth(),
                this.checkDatabaseHealth(),
                this.checkQueueHealth(), // <--- NEW CHECK INTEGRATED HERE
            ]);
            checks = { redis: redisStatus, database: dbStatus, queue: queueStatus };
        }
        
        // 3. Overall Status Aggregation
        const allChecks = { ...checks, resources: resourceStatus, circuitBreakers: breakerReport };
        let overallStatus = 'OK';
        let overallMessage = 'Service operational and ready for traffic.';

        // Check the newly added queue status in the UNAVAILABLE tier
        if (allChecks.redis?.status === 'UNAVAILABLE' || allChecks.database?.status === 'UNAVAILABLE' || allChecks.queue?.status === 'UNAVAILABLE') {
            overallStatus = 'UNAVAILABLE';
            overallMessage = 'Critical dependencies unavailable.';
        } else if (resourceStatus.status === 'DEGRADED' || breakerReport.status === 'DEGRADED') {
            overallStatus = 'DEGRADED';
            overallMessage = 'Resource contention or external service degradation detected.';
        }
        
        return this.createFinalReport(overallStatus, overallMessage, allChecks, startTime, deepCheck);
    }
    
    /**
     * @private
     * @desc Constructs the final report object.
     */
    createFinalReport(overallStatus, overallMessage, checks, startTime, deepCheck = false) {
        const duration = Date.now() - startTime;
        this.deps.Metrics.timing('health_monitor.latency_ms', duration, { type: deepCheck ? 'readiness' : 'liveness', status: overallStatus });
        
        return {
            overallStatus,
            overallMessage,
            timestamp: new Date().toISOString(),
            serviceName: process.env.SERVICE_NAME || 'api-gateway',
            version: appVersion,
            responseTimeMs: duration,
            checks,
        };
    }

    getReadinessReport() {
        return this.generateReport(true);
    }

    getLivenessReport() {
        // Liveness check must pass as soon as the process is running, 
        // regardless of external dependencies or readiness.
        return this.generateReport(false);
    }

    setShuttingDown(status) {
        this.isShuttingDown = status;
        if (status) {
            this.deps.Logger.alert('SYSTEM_STATE_CHANGE', { state: 'SHUTTING_DOWN' });
        }
    }
}

/**
 * @function initHealthMonitor
 * @desc Singleton factory function. Initializes and returns the HealthMonitor instance.
 * @param {object} dependencies - Required dependencies (Logger, Clients, etc.).
 * @param {object} [config] - Optional configuration overrides.
 * @returns {HealthMonitor} The singleton HealthMonitor instance.
 */
function initHealthMonitor(dependencies, config) {
    if (!monitorInstance) {
        // Enforce dependency injection at the factory level
        if (!dependencies.Logger || !dependencies.Metrics || !dependencies.getRedisClient || !dependencies.getDBConnection || !dependencies.getAllBreakers || !dependencies.getQueueClient) {
            throw new Error('HealthMonitor requires all core dependencies (Logger, Metrics, Clients, Breaker Registry, and now getQueueClient) to be injected.');
        }
        monitorInstance = new HealthMonitor(dependencies, config);
    }
    return monitorInstance;
}

// Export the factory function, NOT the instance.
module.exports = {
    initHealthMonitor,
};