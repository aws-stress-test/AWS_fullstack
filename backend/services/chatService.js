const Message = require('../models/Message');
const messageQueue = require('../utils/queue');
const redisManager = require('../config/redis');
const logger = require('../utils/logger');

class ChatService {
  constructor() {
    this.messageBuffer = [];
    this.BATCH_SIZE = 100;
    this.FLUSH_INTERVAL = 100; // 100ms
    this.CACHE_TTL = 300; // 5분
    
    // 주기적으로 버퍼 비우기
    setInterval(() => this.flushMessageBuffer(), this.FLUSH_INTERVAL);
  }

  async handleMessage(messageData, userId) {
    try {
      // Bull 큐에 메시지 추가
      const jobData = {
        room: messageData.room,
        type: messageData.type,
        content: messageData.content?.trim(),
        userId,
        fileData: messageData.fileData,
        timestamp: Date.now()
      };

      // 배치 처리를 위해 버퍼에 추가
      this.messageBuffer.push(jobData);

      if (this.messageBuffer.length >= this.BATCH_SIZE) {
        await this.flushMessageBuffer();
      }

      // 개별 메시지에 대한 작업 ID 반환
      const job = await messageQueue.add(jobData);
      return {
        success: true,
        tempId: job.id,
        timestamp: jobData.timestamp
      };

    } catch (error) {
      logger.error('Message handling error:', error);
      throw error;
    }
  }

  async flushMessageBuffer() {
    if (this.messageBuffer.length === 0) return;

    const messages = [...this.messageBuffer];
    this.messageBuffer = [];

    try {
      // 배치로 큐에 추가
      await messageQueue.addBulk(
        messages.map(msg => ({
          data: msg,
          opts: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 500
            }
          }
        }))
      );

      // 관련된 캐시 무효화
      const uniqueRooms = [...new Set(messages.map(msg => msg.room))];
      await Promise.all(
        uniqueRooms.map(async roomId => {
          const cacheKeys = await redisManager.getKeys(`messages:${roomId}:*`);
          return Promise.all(cacheKeys.map(key => redisManager.delCache(key)));
        })
      );

    } catch (error) {
      logger.error('Message batch processing failed:', error);
      // 실패한 메시지 재처리를 위해 버퍼에 다시 추가
      this.messageBuffer.push(...messages);
    }
  }

  async loadMessages(roomId, before, limit = 30) {
    const cacheKey = `messages:${roomId}:${before || 'latest'}:${limit}`;
    
    try {
      // 캐시 확인
      const cached = await redisManager.getCache(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // DB 쿼리
      const query = { room: roomId };
      if (before) {
        query.timestamp = { $lt: new Date(before) };
      }

      const messages = await Message.find(query)
        .populate('sender', 'name email profileImage')
        .populate({
          path: 'file',
          select: 'filename originalname mimetype size'
        })
        .sort({ timestamp: -1 })
        .limit(limit + 1)
        .lean();

      // 결과 처리
      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      const result = {
        messages: resultMessages,
        hasMore,
        oldestTimestamp: resultMessages[0]?.timestamp || null
      };

      // 결과 캐싱
      await redisManager.setCache(cacheKey, JSON.stringify(result), this.CACHE_TTL);

      return result;

    } catch (error) {
      logger.error('Message loading error:', error);
      throw error;
    }
  }
}

module.exports = new ChatService(); 