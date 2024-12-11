const Redis = require('ioredis');
const Queue = require('bull');
const logger = require('../utils/logger');

const sentinelConfig = {
  sentinels: [
    { host: process.env.SENTINEL_HOST_1 || 'sentinel-1', port: 26379 },
    { host: process.env.SENTINEL_HOST_2 || 'sentinel-2', port: 26379 },
    { host: process.env.SENTINEL_HOST_3 || 'sentinel-3', port: 26379 }
  ],
  name: 'mymaster',
  ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
  
  connectTimeout: 15000,
  commandTimeout: 8000,
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  enableAutoPipelining: true,
  autoResubscribe: false,
  
  retryStrategy: (times) => {
    if (times > 3) return null;
    return Math.min(times * 200, 1000);
  }
};

class RedisManager {
  constructor() {
    this.pubClient = null;
    this.subClient = null;
    this.queues = new Map();
    this.messageBuffer = [];
    this.BATCH_SIZE = 200;
  }

  async connect() {
    try {
      this.pubClient = new Redis({
        ...sentinelConfig,
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 50, 1000)
      });

      this.subClient = new Redis({
        ...sentinelConfig,
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 50, 1000)
      });

      await Promise.all([
        this.pubClient.connect(),
        this.subClient.connect()
      ]);

      // Sentinel 이벤트 리스너
      this.pubClient.on('+failover-end', this.handleFailover.bind(this));
      this.subClient.on('+failover-end', this.handleFailover.bind(this));

      // 메모리 정책 설정
      await this.setMemoryPolicy();

      logger.info('Redis Sentinel 연결 성공');
      return { pubClient: this.pubClient, subClient: this.subClient };
    } catch (error) {
      logger.error('Redis Sentinel 연결 실패:', error);
      throw error;
    }
  }

  async setMemoryPolicy() {
    try {
      await this.pubClient.config('SET', 'maxmemory-policy', 'volatile-lru');
      await this.pubClient.config('SET', 'maxmemory', '2gb');
      await this.pubClient.config('SET', 'appendonly', 'no');
    } catch (error) {
      logger.error('Redis 메모리 정책 설정 실패:', error);
    }
  }

  // Bull 큐 생성 메서드 최적화
  async createQueue(queueName, options = {}) {
    try {
      if (this.queues.has(queueName)) {
        return this.queues.get(queueName);
      }

      const queue = new Queue(queueName, {
        redis: sentinelConfig,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 500
          },
          removeOnComplete: true,
          removeOnFail: true,
          timeout: 5000,
          ...options
        },
        settings: {
          stalledInterval: 5000,
          maxStalledCount: 3,
          lockDuration: 30000,
          lockRenewTime: 15000
        }
      });

      // 동시성 설정
      queue.process(8, async (job) => {
        try {
          return await job.data;
        } catch (error) {
          logger.error('Job processing error:', error);
          throw error;
        }
      });

      queue.on('error', error => {
        logger.error(`Queue ${queueName} error:`, error);
      });

      queue.on('failed', (job, error) => {
        logger.error(`Job ${job.id} in queue ${queueName} failed:`, error);
      });

      this.queues.set(queueName, queue);
      logger.info(`Queue ${queueName} created successfully`);
      
      return queue;
    } catch (error) {
      logger.error(`Failed to create queue ${queueName}:`, error);
      throw error;
    }
  }

  // 캐싱 메서드 추가 (기존 pubClient 활용)
  async getCache(key) {
    try {
      return await this.pubClient.get(key);
    } catch (error) {
      logger.error('Redis cache get 실패:', error);
      return null;
    }
  }

  async setCache(key, value, ttl = 30) {
    try {
      await this.pubClient.set(key, value, 'EX', ttl);
    } catch (error) {
      logger.error('Redis cache set 실패:', error);
    }
  }

  async delCache(key) {
    try {
      await this.pubClient.del(key);
    } catch (error) {
      logger.error('Redis cache del 실패:', error);
    }
  }

  async getKeys(pattern) {
    try {
      return await this.pubClient.keys(pattern);
    } catch (error) {
      logger.error('Redis cache keys 실패:', error);
      return [];
    }
  }

  // 큐 가져오기 메서드
  getQueue(queueName) {
    return this.queues.get(queueName);
  }

  // 모든 큐 정리 메서드
  async closeQueues() {
    try {
      const closePromises = Array.from(this.queues.values()).map(queue => queue.close());
      await Promise.all(closePromises);
      this.queues.clear();
      logger.info('All queues closed successfully');
    } catch (error) {
      logger.error('Failed to close queues:', error);
      throw error;
    }
  }
}

module.exports = new RedisManager(); 