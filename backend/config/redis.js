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
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  }
};

class RedisManager {
  constructor() {
    this.pubClient = null;
    this.subClient = null;
    this.queues = new Map();
  }

  async connect() {
    try {
      this.pubClient = new Redis(sentinelConfig);
      this.subClient = new Redis(sentinelConfig);

      // Sentinel 이벤트 리스너
      this.pubClient.on('+failover-end', this.handleFailover.bind(this));
      this.subClient.on('+failover-end', this.handleFailover.bind(this));

      logger.info('Redis Sentinel 연결 성공');
      return { pubClient: this.pubClient, subClient: this.subClient };
    } catch (error) {
      logger.error('Redis Sentinel 연결 실패:', error);
      throw error;
    }
  }

  async handleFailover() {
    logger.info('Redis Failover 감지됨');
    await this.reconnectClients();
  }

  async reconnectClients() {
    try {
      await this.pubClient.disconnect();
      await this.subClient.disconnect();
      await this.connect();
      logger.info('Redis 클라이언트 재연결 성���');
    } catch (error) {
      logger.error('Redis 클라이언트 재연결 실패:', error);
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

  // Bull 큐 생성 메서드 추가
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
            delay: 1000
          },
          removeOnComplete: true,
          removeOnFail: false,
          ...options
        }
      });

      // 큐 이벤트 리스너 설정
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