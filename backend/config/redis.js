const Redis = require('ioredis');
const logger = require('../utils/logger');

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'redis', // docker-compose에서의 서비스명
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => {
    const maxRetryDelay = 3000;
    const delay = Math.min(times * 50, maxRetryDelay);
    logger.info(`Redis 재연결 시도 ${times}회 차, ${delay}ms 후 재시도`);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  }
};

class RedisClient {
  constructor() {
    this.pubClient = null;
    this.subClient = null;
    this.isConnected = false;
    this.connectionPromise = null;
  }

  async connect() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise(async (resolve, reject) => {
      try {
        this.pubClient = new Redis(REDIS_CONFIG);
        this.subClient = this.pubClient.duplicate();

        await Promise.all([
          this._setupClient(this.pubClient, 'Publisher'),
          this._setupClient(this.subClient, 'Subscriber')
        ]);

        this.isConnected = true;
        logger.info('Redis 클라이언트 연결 완료');
        
        resolve({
          pubClient: this.pubClient,
          subClient: this.subClient
        });
      } catch (error) {
        logger.error('Redis 연결 실패:', error);
        this.connectionPromise = null;
        reject(error);
      }
    });

    return this.connectionPromise;
  }

  async _setupClient(client, clientType) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${clientType} 연결 타임아웃`));
      }, 5000);

      client
        .on('connect', () => {
          logger.info(`Redis ${clientType} 연결 중...`);
        })
        .on('ready', () => {
          clearTimeout(timeout);
          logger.info(`Redis ${clientType} 준비 완료`);
          resolve();
        })
        .on('error', (err) => {
          logger.error(`Redis ${clientType} 에러:`, err);
          this.isConnected = false;
        })
        .on('close', () => {
          logger.warn(`Redis ${clientType} 연결 종료`);
          this.isConnected = false;
        })
        .on('reconnecting', () => {
          logger.info(`Redis ${clientType} 재연결 중...`);
        });
    });
  }

  async disconnect() {
    try {
      const clients = [this.pubClient, this.subClient].filter(Boolean);
      await Promise.all(clients.map(client => client.quit()));
      
      this.pubClient = null;
      this.subClient = null;
      this.isConnected = false;
      this.connectionPromise = null;
      
      logger.info('Redis 연결 정상 종료');
    } catch (error) {
      logger.error('Redis 연결 종료 중 에러:', error);
      throw error;
    }
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      pubClientStatus: this.pubClient?.status || 'not_initialized',
      subClientStatus: this.subClient?.status || 'not_initialized'
    };
  }

  // 헬스체크 메서드
  async healthCheck() {
    if (!this.isConnected) {
      return { status: 'disconnected' };
    }

    try {
      const ping = await this.pubClient.ping();
      return {
        status: 'connected',
        ping: ping === 'PONG',
        clients: this.getStatus()
      };
    } catch (error) {
      logger.error('Redis 헬스체크 실패:', error);
      return {
        status: 'error',
        error: error.message
      };
    }
  }
}

// 싱글톤 인스턴스 export
module.exports = new RedisClient(); 