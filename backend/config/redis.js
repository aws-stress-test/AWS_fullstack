const Redis = require('ioredis');
const Queue = require('bull');
const logger = require('../utils/logger');

// Redis 설정 상수
const REDIS_CONFIG = {
  MEMORY_LIMIT: '2gb',
  MEMORY_POLICY: 'volatile-lru',
  APPEND_ONLY: 'no',
  DEFAULT_TTL: 3600,
  CONNECT_TIMEOUT: 15000,
  COMMAND_TIMEOUT: 8000,
  MAX_RETRIES: 3,
  RETRY_INTERVAL: 200,
  MAX_RETRY_TIME: 1000
};

const sentinelConfig = {
    sentinels: [
      // { host: process.env.SENTINEL_HOST_1 || '52.78.152.29', port: 26379 },
      // { host: process.env.SENTINEL_HOST_2 || '43.201.72.113', port: 26379 }
      { host: '43.202.179.98', port: 26379 },
      { host: '52.78.152.29', port: 26379 },
      { host: '43.201.72.113', port: 26379 }
    ],
    name: 'mymaster',
    connectTimeout: REDIS_CONFIG.CONNECT_TIMEOUT,
    commandTimeout: REDIS_CONFIG.COMMAND_TIMEOUT,
    maxRetriesPerRequest: REDIS_CONFIG.MAX_RETRIES,
    enableReadyCheck: false,
    enableAutoPipelining: true,
    autoResubscribe: false,
    retryStrategy: (times) => {
      if (times > REDIS_CONFIG.MAX_RETRIES) return null;
      return Math.min(times * REDIS_CONFIG.RETRY_INTERVAL, REDIS_CONFIG.MAX_RETRY_TIME);
    }
};

class RedisManager {
  constructor() {
    this.pubClient = null;
    this.subClient = null;
    this.queues = new Map();
    this.messageBuffer = [];
    this.BATCH_SIZE = 200;
    this.defaultTTL = REDIS_CONFIG.DEFAULT_TTL;
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

      console.log('Redis Sentinel pubClient와 subClient가 연결되었습니다.');

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
      const commands = [
        ['CONFIG', 'SET', 'maxmemory-policy', REDIS_CONFIG.MEMORY_POLICY],
        ['CONFIG', 'SET', 'maxmemory', REDIS_CONFIG.MEMORY_LIMIT],
        ['CONFIG', 'SET', 'appendonly', REDIS_CONFIG.APPEND_ONLY]
      ];

      // await Promise.all(
      //   commands.map(cmd => this.pubClient.config(...cmd))
      // );

      for (const cmd of commands) {
        await this.pubClient.sendCommand(cmd);
      }

      // logger.info('Redis 메모리 정책 설정 완료', {
      //   policy: REDIS_CONFIG.MEMORY_POLICY,
      //   limit: REDIS_CONFIG.MEMORY_LIMIT
      // });
    } catch (error) {
      logger.error('Redis 메모리 정책 설정 실패:', error);
      throw error;
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

  async setCache(key, value, ttl = this.defaultTTL) {
    try {
      const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      await this.pubClient.setex(key, ttl, stringValue);
    } catch (error) {
      logger.error('Redis cache set 실패:', error);
      throw error;
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