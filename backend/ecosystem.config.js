module.exports = {
  apps: [{
    name: 'backend',
    script: 'server.js',
    instances: 2,
    exec_mode: 'cluster',
    watch: true,
    sticky_sessions: true,

    max_memory_restart: '1800M',
    autorestart: true,
    
    env_prod: {
      NODE_ENV: 'production',
      PORT: 5000,

      node_args: [
        '--max_old_space_size=1800',
        '--expose-gc',
      ].join(' '),

      UV_THREADPOOL_SIZE: 16,
      
      log_type: 'json',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      combine_logs: true,
      merge_logs: true,
      
      INSTANCE_ID: process.env.EC2_INSTANCE_ID,
      TEST_GROUP: process.env.TEST_GROUP || 'load-test-1',
      
      AWS_CLOUDWATCH_LOG_GROUP: '/load-test/backend',
      AWS_CLOUDWATCH_LOG_STREAM: `backend-${process.env.EC2_INSTANCE_ID}`,
    }
  }]
} 