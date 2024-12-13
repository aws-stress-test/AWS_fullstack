const Queue = require("bull");
const Message = require("../models/Message");
const { createLogger, format, transports } = require("winston");
const redisManager = require("../config/redis");

// Logger 설정
const logger = createLogger({
  level: "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [
    new transports.Console(),
    new transports.File({ filename: "error.log", level: "error" }),
  ],
});

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

    // MongoDB 결과를 Map으로 변환
    const messageMap = new Map(
      savedMessages.map((msg) => [
        `${msg.room}-${msg.timestamp.getTime()}`,
        msg._id,
      ])
    );

    // Redis에 캐싱
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
        const messageId = messageMap.get(`${msg.room}-${msg.timestamp}`);
        pipeline.zadd(
          key,
          msg.timestamp,
          JSON.stringify({ ...msg, _id: messageId })
        );
      });
    }

    const results = await pipeline.exec();
    const failedCommands = results.filter(([err]) => err);
    if (failedCommands.length > 0) {
      logger.error("Redis pipeline errors:", failedCommands);
    }

    return savedMessages;
  } catch (error) {
    logger.error("Bulk message processing error:", { error, messages });
    throw error;
  }
};

// 동시성 설정 (CPU 코어 수에 따라 조정)
messageQueue.process(8, async (job) => {
  console.log("Processing job:", job.id);
  try {
    const messages = Array.isArray(job.data) ? job.data : [job.data];
    console.log("Job data:", messages);
    const result = await processBulkMessages(messages);
    console.log("Job completed successfully:", job.id);
    return result;
  } catch (error) {
    console.error("Job processing error:", { jobId: job.id, error });
    throw error;
  }
});

// 큐 상태 모니터링
setInterval(async () => {
  try {
    const jobCounts = await messageQueue.getJobCounts();
    console.log("Queue status:", jobCounts);
    if (jobCounts.active === 0 && jobCounts.waiting > 0) {
      console.warn("Jobs are waiting but not processing. Check worker status.");
    }
  } catch (error) {
    console.error("Error fetching queue status:", error);
  }
}, 10000);

// Redis 상태 체크
setInterval(() => {
  const pubStatus = redisManager.pubClient.status;
  const subStatus = redisManager.subClient.status;
  console.log("Redis pubClient status:", pubStatus);
  console.log("Redis subClient status:", subStatus);
}, 30000);

// Redis 초기화 및 테스트 Job 추가
(async () => {
  try {
    await redisManager.connect();
    console.log("Redis connected successfully.");
    console.log("Redis pubClient status:", redisManager.pubClient.status);
    console.log("Redis subClient status:", redisManager.subClient.status);

    const testJob = await messageQueue.add({ test: "data" });
    console.log("Test job added:", testJob.id);
  } catch (error) {
    console.error("Failed to connect Redis or add test job:", error);
  }
})();

module.exports = messageQueue;
