module.exports = {
  apps: [{
    name: "frontend",
    script: "npm",
    args: "start",
    exec_mode: "cluster",
    instances: 2,
    
    max_memory_restart: '1536M',
    node_args: '--max-old-space-size=1536',
    
    env: {
      NODE_ENV: "production",
      PORT: 3000,
      INSTANCE_ID: process.env.EC2_INSTANCE_ID,
    },

    wait_ready: true,
    kill_timeout: 5000,
    autorestart: true,
    watch: false,
  }]
}; 