const Queue = require("bull");
const Message = require("../models/Message");
const { createLogger, format, transports } = require("winston");
const Redis = require("ioredis");

// Logger 설정
const logger = createLogger({
  level: "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "error.log", level: "error" }),
  ],
});

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

      try {
        await this.setCache(sessionKey, sessionData, this.defaultTTL);
        console.log(`Session TTL refreshed for user ${userId}.`);
      } catch (ttlError) {
        console.warn(
          `Failed to refresh TTL for session ${sessionId} of user ${userId}:`,
          ttlError.stack || ttlError
        );
      }

      return { isValid: true, message: "Session is valid" };
    } catch (error) {
      console.error(
        `Session validation failed for user ${userId}:`,
        error.stack || error
      );
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

  async getKeys(pattern) {
    try {
      return await this.pubClient.keys(pattern);
    } catch (error) {
      console.error(`Redis getKeys 실패 (pattern: ${pattern}):`, error);
      throw error;
    }
  }
}

const messageQueue = new Queue("messageQueue", {
  redis: {
    sentinels: [
      { host: "43.202.179.98", port: 26379 },
      { host: "52.78.152.29", port: 26379 },
      { host: "43.201.72.113", port: 26379 },
    ],
    name: "mymaster",
    connectTimeout: 15000,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) return null;
      return Math.min(times * 50, 1000);
    },
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 500,
    },
    removeOnComplete: true,
    removeOnFail: true,
    timeout: 5000,
  },
  settings: {
    stalledInterval: 5000,
    maxStalledCount: 3,
    lockDuration: 30000,
    lockRenewTime: 15000,
  },
});

// 메시지 일괄 처리 함수
const processBulkMessages = async (messages) => {
  try {
    // DB 삽입용 메시지 데이터 준비
    const messagesForDB = messages.map((msg) => ({
      room: msg.room,
      content: msg.content,
      type: msg.type || "text",
      sender: msg.userId,
      timestamp: new Date(msg.timestamp),
      file: msg.fileData || null,
      ...(msg.mentions && { mentions: msg.mentions }),
      ...(msg.metadata && { metadata: msg.metadata }),
    }));

    // MongoDB에 벌크 삽입
    const savedMessages = await Message.insertMany(messagesForDB);

    // Redis에 캐싱
    const redisManager = new RedisManager();
    const pipeline = redisManager.pubClient.multi();
    const roomGroups = messages.reduce((acc, msg) => {
      const roomId = msg.room;
      if (!acc[roomId]) acc[roomId] = [];
      acc[roomId].push(msg);
      return acc;
    }, {});

    // Redis Sorted Set에 메시지 추가
    for (const [roomId, roomMessages] of Object.entries(roomGroups)) {
      const key = `messages:${roomId}`;
      roomMessages.forEach((msg) => {
        pipeline.zadd(
          key,
          msg.timestamp,
          JSON.stringify({
            ...msg,
            _id: savedMessages.find(
              (m) =>
                m.room === msg.room && m.timestamp.getTime() === msg.timestamp
            )?._id,
          })
        );
      });
    }

    await pipeline.exec();
    return savedMessages;
  } catch (error) {
    logger.error("Bulk message processing error:", error);
    throw error;
  }
};

// 동시성 설정 (CPU 코어 수에 따라 조정)
messageQueue.process(8, async (job) => {
  try {
    const messages = Array.isArray(job.data) ? job.data : [job.data];
    return await processBulkMessages(messages);
  } catch (error) {
    logger.error("Message processing error:", error);
    throw error;
  }
});

// 이벤트 핸들러
messageQueue.on("error", (error) => {
  logger.error("Message queue error:", error);
});

messageQueue.on("failed", (job, error) => {
  logger.error("Job failed:", job.id, error);
});

messageQueue.on("completed", (job) => {
  logger.info("Job completed:", job.id);
});

// 큐 상태 모니터링
setInterval(async () => {
  const jobCounts = await messageQueue.getJobCounts();
  logger.info("Queue status:", jobCounts);
}, 30000);

// Redis Sentinel 연결 테스트
(async () => {
  try {
    const redisManager = new RedisManager();
    await redisManager.connect();
    logger.info("Message queue connected successfully.");

    // 테스트 작업 추가
    const testJob = await messageQueue.add({ test: "data" });
    logger.info("Test job added:", testJob.id);
  } catch (error) {
    logger.error("Failed to connect message queue or add test job:", error);
  }
})();

module.exports = messageQueue;
