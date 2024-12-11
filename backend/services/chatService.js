const Message = require('../models/Message');
const messageQueue = require('../utils/queue');
const redisManager = require('../config/redis');
const logger = require('../utils/logger');

class ChatService {
  constructor() {
    this.messageBuffer = [];
    this.BATCH_SIZE = 100;
    this.FLUSH_INTERVAL = 100;
    this.CACHE_TTL = 300;
    
    setInterval(() => this.flushMessageBuffer(), this.FLUSH_INTERVAL);
  }

  async handleMessage(messageData, userId) {
    try {
      const jobData = {
        room: messageData.room,
        type: messageData.type || 'text',
        content: messageData.content?.trim(),
        userId,
        timestamp: Date.now()
      };

      // 파일 데이터가 있는 경우만 포함
      if (messageData.fileData) {
        jobData.fileData = messageData.fileData;
      }

      this.messageBuffer.push(jobData);

      // 버퍼가 가득 찼을 때만 플러시
      if (this.messageBuffer.length >= this.BATCH_SIZE) {
        await this.flushMessageBuffer();
      }

      const job = await messageQueue.add(jobData, {
        removeOnComplete: true,  // 작업 완료 후 자동 삭제
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 500
        }
      });

      return { success: true, tempId: job.id, timestamp: jobData.timestamp };

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
      // 벌크 작업을 트랜잭션으로 처리
      const bulkOps = messages.map(msg => ({
        data: msg,
        opts: {
          removeOnComplete: true,
          attempts: 3,
          backoff: { type: 'exponential', delay: 500 }
        }
      }));

      await messageQueue.addBulk(bulkOps);

      // 캐시 무효화 최적화: 룸별로 그룹화하여 처리
      const roomGroups = messages.reduce((acc, msg) => {
        if (!acc[msg.room]) acc[msg.room] = [];
        acc[msg.room].push(msg);
        return acc;
      }, {});

      await Promise.all(
        Object.keys(roomGroups).map(async roomId => {
          const pattern = `messages:${roomId}:*`;
          await redisManager.delByPattern(pattern);
        })
      );

    } catch (error) {
      logger.error('Message batch processing failed:', error);
      this.messageBuffer.push(...messages);
    }
  }

  async loadMessages(roomId, before, limit = 30) {
    const cacheKey = `messages:${roomId}:${before || 'latest'}:${limit}`;
    
    try {
      // 캐시 확인
      const cached = await redisManager.getCache(cacheKey);
      if (cached) return JSON.parse(cached);

      // 쿼리 최적화
      const query = { 
        room: roomId,
        isDeleted: false,
        ...(before && { timestamp: { $lt: new Date(before) } })
      };

      // 필요한 필드만 선택하고 인덱스 활용
      const messages = await Message.find(query)
        .select({
          content: 1,
          type: 1,
          sender: 1,
          timestamp: 1,
          file: 1,
          reactions: 1
        })
        .populate('sender', 'name profileImage')
        .populate('file', 'filename mimetype size')
        .sort({ timestamp: -1 })
        .limit(limit + 1)
        .lean()
        .hint({ room: 1, timestamp: -1 });  // 인덱스 힌트 추가

      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      
      const result = {
        messages: resultMessages,
        hasMore,
        oldestTimestamp: resultMessages[0]?.timestamp || null
      };

      // 결과 캐싱 (비동기로 처리)
      redisManager.setCache(cacheKey, JSON.stringify(result), this.CACHE_TTL)
        .catch(err => logger.error('Cache setting error:', err));

      return result;

    } catch (error) {
      logger.error('Message loading error:', error);
      throw error;
    }
  }
}

module.exports = new ChatService();