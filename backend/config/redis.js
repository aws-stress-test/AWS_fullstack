const Redis = require("ioredis");

const REDIS_CONFIG = {
  MEMORY_LIMIT: "2gb",
  MEMORY_POLICY: "volatile-lru",
  APPEND_ONLY: "no",
  DEFAULT_TTL: 3600,
  CONNECT_TIMEOUT: 30000,
  COMMAND_TIMEOUT: 15000,
  MAX_RETRIES: 3,
  RETRY_INTERVAL: 200,
  MAX_RETRY_TIME: 1000,
};

const sentinelConfig = {
  sentinels: [
    { host: "52.78.152.29", port: 26379 },
    { host: "43.201.72.113", port: 26379 },
  ],
  name: "mymaster",
  connectTimeout: REDIS_CONFIG.CONNECT_TIMEOUT,
  commandTimeout: REDIS_CONFIG.COMMAND_TIMEOUT,
  maxRetriesPerRequest: REDIS_CONFIG.MAX_RETRIES,
  enableReadyCheck: false,
  enableAutoPipelining: true,
  autoResubscribe: false,
  retryStrategy: (times) => {
    if (times > REDIS_CONFIG.MAX_RETRIES) return null;
    return Math.min(
      times * REDIS_CONFIG.RETRY_INTERVAL,
      REDIS_CONFIG.MAX_RETRY_TIME
    );
  },
};

class RedisManager {
  constructor() {
    this.pubClient = null;
    this.subClient = null;
    this.defaultTTL = REDIS_CONFIG.DEFAULT_TTL;
  }

  async connect() {
    try {
      this.pubClient = new Redis({ ...sentinelConfig, lazyConnect: true });
      this.subClient = new Redis({ ...sentinelConfig, lazyConnect: true });

      await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
      console.log("Redis Sentinel pubClient와 subClient가 연결되었습니다.");

      this.pubClient.on("+switch-master", () => {
        console.log("Master switched. Reconnecting...");
        this.connect();
      });

      await this.setMemoryPolicy();
    } catch (error) {
      console.error("Redis Sentinel 연결 실패:", error);
      throw error;
    }
  }

  async setMemoryPolicy() {
    try {
      await this.pubClient.config(
        "SET",
        "maxmemory-policy",
        REDIS_CONFIG.MEMORY_POLICY
      );
      await this.pubClient.config(
        "SET",
        "maxmemory",
        REDIS_CONFIG.MEMORY_LIMIT
      );
      await this.pubClient.config(
        "SET",
        "appendonly",
        REDIS_CONFIG.APPEND_ONLY
      );
      console.log("Redis 메모리 정책 설정 완료");
    } catch (error) {
      console.error("Redis 메모리 정책 설정 실패:", error);
      throw error;
    }
  }

  async createSession(userId, sessionData) {
    const sessionKey = `session:${userId}`;
    try {
      const existingSession = await this.getCache(sessionKey);
      if (existingSession) {
        console.warn(
          `Existing session found for user ${userId}. Attempting to delete...`
        );
        const isDeleted = await this.delCache(sessionKey);
        if (!isDeleted) {
          console.error(
            `Failed to delete existing session for user ${userId}.`
          );
          throw new Error("Failed to delete existing session");
        }
      }

      const sessionId = this.generateSessionId();
      const newSessionData = {
        ...sessionData,
        sessionId,
        createdAt: Date.now(),
      };
      await this.setCache(sessionKey, newSessionData, this.defaultTTL);

      console.log(`New session created for user ${userId}.`);
      return newSessionData;
    } catch (error) {
      console.error(
        `Failed to create session for user ${userId}:`,
        error.stack || error
      );
      throw error;
    }
  }

  async validateSession(userId, sessionId) {
    const sessionKey = `session:${userId}`;
    try {
      const sessionData = await this.getCache(sessionKey);
      if (!sessionData) {
        console.warn(`No session data found for user ${userId}.`);
        return { isValid: false, message: "Session not found" };
      }

      if (sessionData.sessionId !== sessionId) {
        console.warn(`Session ID mismatch for user ${userId}.`);
        return { isValid: false, message: "Session mismatch" };
      }

      await this.setCache(sessionKey, sessionData, this.defaultTTL);
      console.log(`Session TTL refreshed for user ${userId}.`);

      return { isValid: true, message: "Session is valid" };
    } catch (error) {
      console.error(`Session validation failed for user ${userId}:`, error);
      return { isValid: false, message: "Session validation error" };
    }
  }

  generateSessionId() {
    return `sess_${Math.random().toString(36).substring(2)}_${Date.now()}`;
  }

  async getCache(key) {
    try {
      const data = await this.pubClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error(`Redis getCache 실패: ${key}`, error);
      return null;
    }
  }

  async setCache(key, value, ttl = this.defaultTTL) {
    try {
      const stringValue = JSON.stringify(value);
      await this.pubClient.setex(key, ttl, stringValue);
    } catch (error) {
      console.error(`Redis setCache 실패: ${key}`, error);
      throw error;
    }
  }

  async delCache(key) {
    try {
      const type = await this.pubClient.type(key);
      if (type !== "none") {
        await this.pubClient.del(key);
        console.log(`Redis key "${key}" deleted.`);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Redis delCache 실패: ${key}`, error);
      return false;
    }
  }

  async checkRedisConnection() {
    try {
      await this.pubClient.ping();
      console.log("Redis connection is active.");
    } catch (error) {
      console.error("Redis connection lost. Reconnecting...");
      await this.connect();
    }
  }

  setPeriodicConnectionCheck() {
    setInterval(() => {
      this.checkRedisConnection();
    }, 30000); // 30초마다 확인
  }
}

module.exports = new RedisManager();
