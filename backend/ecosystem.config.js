module.exports = {
  apps: [{
    name: 'backend',
    script: 'server.js',
    instances: 1,               // fork 모드 유지
    exec_mode: 'fork',
    watch: false,              // 프로덕션에서는 비활성화
    sticky_sessions: true,     // WebSocket 연결 유지

    // 메모리 관련 설정 최적화
    max_memory_restart: '1500M',  // 여유 메모리 확보를 위해 조정
    autorestart: true,
    
    env_prod: {
      NODE_ENV: 'production',
      PORT: 5000,

      node_args: [
        '--max_old_space_size=1500',
        '--expose-gc',
        '--optimize-for-size',     // 메모리 사용 최적화
      ].join(' '),

      UV_THREADPOOL_SIZE: 8,      // 적절한 스레드풀 크기로 조정
      
      // 기존 로깅 설정 유지
      log_type: 'json',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      combine_logs: true,
      merge_logs: true,
      
      // 환경변수 유지
      INSTANCE_ID: process.env.EC2_INSTANCE_ID,
      TEST_GROUP: process.env.TEST_GROUP || 'load-test-1',
      AWS_CLOUDWATCH_LOG_GROUP: '/load-test/backend',
      AWS_CLOUDWATCH_LOG_STREAM: `backend-${process.env.EC2_INSTANCE_ID}`,
    }
  }]
}