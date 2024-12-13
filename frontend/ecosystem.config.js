module.exports = {
  apps: [{
    name: "frontend",
    script: "server.js",
    exec_mode: "fork",
    instances: 1,
    
    max_memory_restart: '1536M',
    node_args: '--max-old-space-size=1536',
    
    env: {
      NODE_ENV: "production",
      PORT: 3000,
      INSTANCE_ID: process.env.EC2_INSTANCE_ID,
    },

    wait_ready: true,
    listen_timeout: 70000,      // 추가: 앱 시작 시 ready 이벤트 대기 시간
    kill_timeout: 30000,        // 수정: 5000 -> 30000으로 증가
    max_restarts: 10,           // 추가: 최대 재시작 횟수 제한
    restart_delay: 4000,        // 추가: 재시작 간 지연 시간
    autorestart: true,
    watch: false,
  }]
};