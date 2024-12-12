const Queue = require("bull");
const Message = require("../models/Message");
const { createLogger, format, transports } = require("winston");

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
    const isReady = await messageQueue.isReady();
    if (isReady) {
      logger.info("Message queue connected successfully.");
    }

    // 테스트 작업 추가
    const testJob = await messageQueue.add({ test: "data" });
    logger.info("Test job added:", testJob.id);
  } catch (error) {
    logger.error("Failed to connect message queue or add test job:", error);
  }
})();

module.exports = messageQueue;
