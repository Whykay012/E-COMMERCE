module.exports = {
  apps: [
    {
      name: "omega-api",
      script: "./server.js",
      instances: "max", // High scaling for HTTP traffic
      exec_mode: "cluster",
    },
    {
      name: "worker-generic",
      script: "./generic_worker_runner.js", // Main jobRouter cluster
      instances: 2,
    },
    {
      name: "worker-financial",
      script: "./financial_worker_runner.js", // Payouts/Commissions
      instances: 1, // Keep to 1 for strict sequence if necessary, otherwise 2
    },
    {
      name: "worker-security",
      script: "./security_worker_runner.js", // Logout/Revocation
      instances: 1,
    },
    {
      name: "worker-infra",
      script: "./infra_worker_runner.js", // GeoIP/Utilities
      instances: 1,
    },
    {
      name: "worker-address",
      script: "./queues/addressWorker.js", // Geocoding/Adaptive Concurrency
      instances: 1, 
      env: {
        WORKER_CONCURRENCY: "5"
      }
    }
  ]
};