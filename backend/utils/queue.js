const Queue = require('bull');
const { sentinelConfig } = require('../config/redis');  // Redis 설정 import
const logger = require('./logger');

const messageQueue = new Queue('messageQueue', {
  redis: sentinelConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnComplete: true,
    removeOnFail: false
  }
});

// 에러 처리
messageQueue.on('error', (error) => {
  logger.error('Message queue error:', error);
});

messageQueue.on('failed', (job, error) => {
  logger.error('Job failed:', job.id, error);
});

module.exports = messageQueue; 