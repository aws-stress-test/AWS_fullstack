const Redis = require("ioredis");
const Queue = require("bull");

// Redis 설정 상수
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
    this.queues = new Map();
    this.defaultTTL = REDIS_CONFIG.DEFAULT_TTL;
  }

  async connect() {
    try {
      this.pubClient = new Redis({ ...sentinelConfig, lazyConnect: true });
      this.subClient = new Redis({ ...sentinelConfig, lazyConnect: true });

      await Promise.all([this.pubClient.connect(), this.subClient.connect()]);
      console.log("Redis Sentinel pubClient와 subClient가 연결되었습니다.");

      // Sentinel 이벤트 리스너
      this.pubClient.on("+failover-end", this.handleFailover.bind(this));
      this.subClient.on("+failover-end", this.handleFailover.bind(this));

      this.pubClient.on("+switch-master", (master) => {
        console.log(`Master switched: ${JSON.stringify(master)}`);
        this.connect();
      });

      await this.setMemoryPolicy();

      return { pubClient: this.pubClient, subClient: this.subClient };
    } catch (error) {
      console.error("Redis Sentinel 연결 실패:", error);
      throw error;
    }
  }

  handleFailover() {
    console.log("Redis Sentinel failover detected. Reconnecting...");
    this.connect()
      .then(() => {
        console.log("Reconnected to Redis after failover.");
      })
      .catch((err) => {
        console.error("Failed to reconnect to Redis after failover:", err);
      });
  }

  async setMemoryPolicy() {
    try {
      const commands = [
        ["CONFIG", "SET", "maxmemory-policy", REDIS_CONFIG.MEMORY_POLICY],
        ["CONFIG", "SET", "maxmemory", REDIS_CONFIG.MEMORY_LIMIT],
        ["CONFIG", "SET", "appendonly", REDIS_CONFIG.APPEND_ONLY],
      ];

      for (const [command, ...args] of commands) {
        await this.pubClient.call(command, ...args);
      }

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
        console.log(`Existing session found for user ${userId}. Deleting...`);
        await this.delCache(sessionKey);
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
      console.error(`Failed to create session for user ${userId}:`, error);
      throw error;
    }
  }

  async validateSession(userId, sessionId) {
    const sessionKey = `session:${userId}`;
    try {
      const sessionData = await this.getCache(sessionKey);
      if (!sessionData) {
        console.error(`No session data found for user ${userId}.`);
        return { isValid: false, message: "Session not found" };
      }

      console.log(`Validating session for user ${userId}:`, {
        sessionData,
        sessionId,
      });
      if (sessionData.sessionId !== sessionId) {
        console.error(`Session mismatch for user ${userId}.`);
        return { isValid: false, message: "Session mismatch" };
      }

      await this.setCache(sessionKey, sessionData, this.defaultTTL);
      console.log(`Session for user ${userId} is valid.`);
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
      if (data) {
        try {
          return JSON.parse(data);
        } catch {
          return data;
        }
      }
      return null;
    } catch (error) {
      console.error(`Redis cache get 실패 (key: ${key}):`, error);
      return null;
    }
  }

  async setCache(key, value, ttl = this.defaultTTL) {
    try {
      const stringValue =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      await this.pubClient.setex(key, ttl, stringValue);
    } catch (error) {
      console.error(`Redis cache set 실패 (key: ${key}):`, error);
      throw error;
    }
  }

  async delCache(key) {
    try {
      const type = await this.pubClient.type(key);
      if (type !== "none") {
        await this.pubClient.del(key);
        console.log(`Redis key "${key}" deleted.`);
      }
    } catch (error) {
      console.error(`Redis cache del 실패 (key: ${key}):`, error);
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
