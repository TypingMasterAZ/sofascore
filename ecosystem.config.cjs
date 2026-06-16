module.exports = {
  apps: [
    {
      name: "rabona-media",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      time: true,
      max_memory_restart: "700M",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        KEEPALIVE_ENABLED: "false",
        ALWAYS_ON_ENABLED: "true",
        LIVE_SCORE_POLL_INTERVAL_MS: "1000",
        BACKGROUND_REFRESH_INTERVAL_MS: "5000",
        RUNTIME_WARMUP_INTERVAL_MS: "60000",
        CATEGORY_WARMUP_INTERVAL_MS: "180000"
      }
    }
  ]
};
