const Queue = require('bull');
const { sentinelConfig } = require('../config/redis');
const logger = require('./logger');

const messageQueue = new Queue('messageQueue', {
  redis: {
    ...sentinelConfig,
    enableReadyCheck: false,
    maxRetriesPerRequest: 3
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 500
    },
    removeOnComplete: true,
    removeOnFail: true,
    timeout: 5000
  },
  settings: {
    stalledInterval: 5000,
    maxStalledCount: 3,
    lockDuration: 30000,
    lockRenewTime: 15000
  }
});

// 동시성 설정 (CPU 코어 수에 따라 조정)
messageQueue.process(8, async (job) => {
  try {
    return await job.data;
  } catch (error) {
    logger.error('Message processing error:', error);
    throw error;
  }
});

// 이벤트 핸들러
messageQueue.on('error', (error) => {
  logger.error('Message queue error:', error);
});

messageQueue.on('failed', (job, error) => {
  logger.error('Job failed:', job.id, error);
});

messageQueue.on('completed', (job) => {
  logger.debug('Job completed:', job.id);
});

// 큐 상태 모니터링
setInterval(async () => {
  const jobCounts = await messageQueue.getJobCounts();
  logger.info('Queue status:', jobCounts);
}, 30000);

module.exports = messageQueue; 