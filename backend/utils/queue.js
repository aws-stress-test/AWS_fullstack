const Queue = require('bull');
const { sentinelConfig } = require('../config/redis');

const messageQueue = new Queue('messageQueue', {
  redis: {
    sentinels: [
      { host: '43.202.179.98', port: 26379 },
      { host: '52.78.152.29', port: 26379 },
      { host: '43.201.72.113', port: 26379 }
    ],
    name: 'mymaster',
    connectTimeout: 15000,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) return null;
      return Math.min(times * 50, 1000);
    }
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
    console.error('Message processing error:', error);
    throw error;
  }
});

// 이벤트 핸들러
messageQueue.on('error', (error) => {
  console.error('Message queue error:', error);
});

messageQueue.on('failed', (job, error) => {
  console.error('Job failed:', job.id, error);
});

messageQueue.on('completed', (job) => {
  console.log('Job completed:', job.id);
});

// 큐 상태 모니터링
setInterval(async () => {
  const jobCounts = await messageQueue.getJobCounts();
  console.log('Queue status:', jobCounts);
}, 30000);

// Redis Sentinel 연결 테스트
(async () => {
  try {
    const isReady = await messageQueue.isReady();
    if (isReady) {
      console.log('Message queue connected successfully.');
    }

    // 테스트 작업 추가
    const testJob = await messageQueue.add({ test: 'data' });
    console.log('Test job added:', testJob.id);
  } catch (error) {
    console.error('Failed to connect message queue or add test job:', error);
  }
})();

module.exports = messageQueue; 