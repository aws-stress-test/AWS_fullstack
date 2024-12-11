const Redis = require('ioredis');
const logger = require('../utils/logger');

const sentinelConfig = {
  sentinels: [
    { host: process.env.SENTINEL_HOST_1 || 'sentinel-1', port: 26379 },
    { host: process.env.SENTINEL_HOST_2 || 'sentinel-2', port: 26379 },
    { host: process.env.SENTINEL_HOST_3 || 'sentinel-3', port: 26379 }
  ],
  name: 'mymaster',
  password: process.env.REDIS_PASSWORD,
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
    // Failover 후 재연결 로직
    await this.reconnectClients();
  }

  async reconnectClients() {
    try {
      await this.pubClient.disconnect();
      await this.subClient.disconnect();
      await this.connect();
      logger.info('Redis 클라이언트 재연결 성공');
    } catch (error) {
      logger.error('Redis 클라이언트 재연결 실패:', error);
      throw error;
    }
  }
}

module.exports = new RedisManager(); 