const Message = require('../models/Message');
const messageQueue = require('../utils/queue');
const redisManager = require('../config/redis');
const logger = require('../utils/logger');

class ChatService {
  constructor() {
    this.messageBuffer = [];
    this.BATCH_SIZE = redisManager.BATCH_SIZE;
    this.FLUSH_INTERVAL = 100;
    this.CACHE_TTL = redisManager.defaultTTL;
    this.MESSAGES_PER_PAGE = 30;
    this.USER_CACHE_TTL = 3600; // 1시간
    this.FILE_CACHE_TTL = 3600; // 1시간
    
    setInterval(() => this.flushMessageBuffer(), this.FLUSH_INTERVAL);
  }

  // User 캐싱 관련 메서드들
  async getUserFromCache(userId) {
    try {
      const cacheKey = `user:${userId}`;
      let userData = await redisManager.pubClient.get(cacheKey);
      
      if (!userData) {
        const user = await User.findById(userId)
          .select('name profileImage')
          .lean();
          
        if (user) {
          userData = JSON.stringify({
            _id: userId,
            name: user.name,
            profileImage: user.profileImage
          });
          await redisManager.pubClient.setex(cacheKey, this.USER_CACHE_TTL, userData);
        }
      }
      
      return userData ? JSON.parse(userData) : null;
    } catch (error) {
      logger.error('User cache error:', error);
      return null;
    }
  }

  // File 캐싱 관련 메서드들
  async getFileFromCache(fileId) {
    try {
      const cacheKey = `file:${fileId}`;
      let fileData = await redisManager.pubClient.get(cacheKey);
      
      if (!fileData) {
        const file = await File.findById(fileId)
          .select('filename mimetype size')
          .lean();
          
        if (file) {
          fileData = JSON.stringify({
            _id: fileId,
            filename: file.filename,
            mimetype: file.mimetype,
            size: file.size
          });
          await redisManager.pubClient.setex(cacheKey, this.FILE_CACHE_TTL, fileData);
        }
      }
      
      return fileData ? JSON.parse(fileData) : null;
    } catch (error) {
      logger.error('File cache error:', error);
      return null;
    }
  }

  // 메시지 관련 데이터 enrichment
  async enrichMessageData(message) {
    try {
      const enrichedMessage = { ...message };
      
      if (message.sender) {
        enrichedMessage.sender = await this.getUserFromCache(message.sender);
      }
      
      if (message.file) {
        enrichedMessage.file = await this.getFileFromCache(message.file);
      }
      
      return enrichedMessage;
    } catch (error) {
      logger.error('Message enrichment error:', error);
      return message;
    }
  }

  async handleMessage(messageData, userId) {
    try {
      const message = {
        room: messageData.room,
        type: messageData.type || 'text',
        content: messageData.content?.trim(),
        sender: userId,
        timestamp: Date.now(),
        ...(messageData.fileData && { file: messageData.fileData })
      };

      // 사용자 정보 캐싱 (없는 경우)
      await this.getUserFromCache(userId);
      
      // 파일 정보 캐싱 (파일 메시지인 경우)
      if (message.file) {
        await this.getFileFromCache(message.file);
      }

      const roomKey = `chat:room:${message.room}:messages`;
      const messageCacheKey = `chat:message:${message.room}:${message.timestamp}`;
      
      const pipeline = redisManager.pubClient.pipeline();
      
      // enriched 메시지 데이터 저장
      const enrichedMessage = await this.enrichMessageData(message);
      
      pipeline.zadd(roomKey, message.timestamp, message.timestamp.toString());
      pipeline.set(messageCacheKey, JSON.stringify(enrichedMessage), 'EX', this.CACHE_TTL);
      pipeline.expire(roomKey, this.CACHE_TTL);
      
      await pipeline.exec();

      this.messageBuffer.push(message);
      if (this.messageBuffer.length >= this.BATCH_SIZE) {
        await this.flushMessageBuffer();
      }

      const job = await messageQueue.add('newMessage', message, {
        removeOnComplete: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 500 }
      });

      return { 
        success: true, 
        tempId: job.id, 
        timestamp: message.timestamp,
        enrichedData: enrichedMessage 
      };

    } catch (error) {
      logger.error('Message handling error:', error);
      throw error;
    }
  }

  /**
   * handleBulkMessages(messages)
   * 메시지 배열을 받아 버퍼에 넣고 버퍼 차면 flush
   */
  async handleBulkMessages(messages) {
    try {
      if (!Array.isArray(messages)) {
        throw new Error('handleBulkMessages: messages should be an array');
      }

      // messages 각 메시지에 대해 enrichment 또는 기타 처리가 필요하다면 여기서 가능
      // 단순히 버퍼에 추가
      this.messageBuffer.push(...messages);

      // 버퍼가 가득 차면 flush 시도
      if (this.messageBuffer.length >= this.BATCH_SIZE) {
        await this.flushMessageBuffer();
      }
    } catch (error) {
      logger.error('handleBulkMessages error:', error);
      throw error;
    }
  }

  /**
   * markMessagesAsRead(roomId, userId, messageIds)
   * 특정 메시지들에 대한 읽음 처리
   */
  async markMessagesAsRead(roomId, userId, messageIds) {
    try {
      if (!messageIds || !messageIds.length) return;

      const modifiedCount = await Message.markAsRead(messageIds, userId);
      // 읽음 처리 후 Redis 캐시 갱신할 필요가 있다면 여기서 처리
      // (예: 캐시된 메시지 데이터를 다시 set)

      // 캐시에 반영 (선택 사항)
      // messageIds.forEach(async msgId => {
      //   await this.updateMessageInCache(roomId, msgId);
      // });

      return modifiedCount;
    } catch (error) {
      logger.error('markMessagesAsRead error:', error);
      throw error;
    }
  }

  /**
   * handleReaction(messageId, reaction, type, userId)
   * 메시지에 리액션 추가/제거
   */
  async handleReaction(messageId, reaction, type, userId) {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) throw new Error('Message not found');

      let updatedUsers = [];
      if (type === 'add') {
        updatedUsers = await msg.addReaction(reaction, userId);
      } else if (type === 'remove') {
        updatedUsers = await msg.removeReaction(reaction, userId);
      } else {
        throw new Error('Invalid reaction type');
      }

      // 리액션 변경 후 Redis 캐시 갱신(선택)
      // await this.updateMessageInCache(msg.room, msg._id);

      return updatedUsers;
    } catch (error) {
      logger.error('handleReaction error:', error);
      throw error;
    }
  }

  /**
   * getMessageById(messageId)
   * Redis 캐시 -> DB 순서로 조회
   */
  async getMessageById(messageId) {
    try {
      if (!messageId) throw new Error('messageId is required');

      // Redis 키 생성: 메시지에서 roomId를 알아야 하는데, 없다면 DB 먼저 조회 필요
      // 여기서는 메시지 캐시 키를 만들기 위해 메시지 timestamp나 roomId가 필요한데,
      // messageId만으로는 timestamp나 room을 알 수 없으므로 DB조회 후 캐싱하는 방법 사용.
      
      // 가장 간단한 접근: DB에서 메시지 조회 후 캐싱
      // (messageId가 ObjectId라서 Redis키로 바로 사용하기 애매하므로 room:timestamp 기반이 아닌 messageId 기반 캐싱도 가능)
      const cacheKey = `chat:message:id:${messageId}`;
      let cached = await redisManager.pubClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        return parsed;
      }

      const msg = await Message.findById(messageId)
        .lean();
      if (!msg) return null;

      const enrichedMsg = await this.enrichMessageData(msg);

      // 캐싱
      await redisManager.pubClient.setex(cacheKey, this.CACHE_TTL, JSON.stringify(enrichedMsg));
      return enrichedMsg;
    } catch (error) {
      logger.error('getMessageById error:', error);
      throw error;
    }
  }

  async loadMessages(roomId, before, limit = this.MESSAGES_PER_PAGE) {
    try {
      const roomKey = `chat:room:${roomId}:messages`;
      
      // Redis 조회 시도
      let messages = await this.loadMessagesFromRedis(roomKey, before, limit);
      
      if (!messages || messages.length < limit) {
        // Redis 실패 시 DB 폴백
        messages = await this.loadMessagesFromDB(roomId, before, limit);
        
        // Redis 재구성 시도
        if (messages.length > 0) {
          this.cacheMessages(roomId, messages).catch(err => 
            logger.error('Cache rebuild failed:', err)
          );
        }
      }
  
      return {
        messages: messages.slice(0, limit),
        hasMore: messages.length > limit,
        oldestTimestamp: messages[messages.length - 1]?.timestamp
      };
    } catch (error) {
      // 모든 것이 실패하면 DB에서 직접 조회
      logger.error('Message loading error:', error);
      const fallbackMessages = await Message.findRoomMessages(roomId, before, limit);
      return {
        messages: fallbackMessages,
        hasMore: fallbackMessages.length > limit,
        oldestTimestamp: fallbackMessages[fallbackMessages.length - 1]?.timestamp
      };
    }
  }

  async loadMessagesFromRedis(roomKey, before, limit) {
    try {
      const max = before || '+inf';
      const min = '-inf';
      
      const messageIds = await redisManager.pubClient.zrevrangebyscore(
        roomKey,
        max,
        min,
        'LIMIT',
        0,
        limit + 1
      );

      if (!messageIds.length) return null;

      const pipeline = redisManager.pubClient.pipeline();
      messageIds.forEach(timestamp => {
        const messageCacheKey = `chat:message:${roomKey.split(':')[2]}:${timestamp}`;
        pipeline.get(messageCacheKey);
      });

      const results = await pipeline.exec();
      const messages = results
        .map(([err, result]) => {
          if (err || !result) return null;
          try {
            return JSON.parse(result);
          } catch (e) {
            return null;
          }
        })
        .filter(msg => msg !== null);

      // 캐시 미스된 sender나 file 정보가 있다면 다시 enrichment
      return await Promise.all(
        messages.map(async msg => {
          if (msg.sender && typeof msg.sender === 'string') {
            return this.enrichMessageData(msg);
          }
          return msg;
        })
      );
    } catch (error) {
      logger.error('Redis message loading error:', error);
      return null;
    }
  }

  async loadMessagesFromDB(roomId, before, limit) {
    try {
      const messages = await Message.findRoomMessages(roomId, before, limit);
      
      // 메시지 enrichment를 병렬로 처리
      return await Promise.all(
        messages.map(msg => this.enrichMessageData(msg))
      );
    } catch (error) {
      logger.error('DB message loading error:', error);
      throw error;
    }
  }

  async cacheMessages(roomId, messages) {
    const pipeline = redisManager.pubClient.pipeline();
    const roomKey = `chat:room:${roomId}:messages`;

    messages.forEach(message => {
      const timestamp = new Date(message.timestamp).getTime();
      const messageCacheKey = `chat:message:${roomId}:${timestamp}`;
      
      pipeline.zadd(roomKey, timestamp, timestamp.toString());
      pipeline.set(messageCacheKey, JSON.stringify(message), 'EX', this.CACHE_TTL);
    });

    pipeline.expire(roomKey, this.CACHE_TTL);

    try {
      await pipeline.exec();
    } catch (error) {
      logger.error('Message caching error:', error);
    }
  }

  async flushMessageBuffer() {
    if (this.messageBuffer.length === 0) return;
  
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];
  
    try {
      // 벌크 작업으로 변경
      const bulkOps = messages.map(msg => ({
        insertOne: { document: msg }
      }));
      
      await Message.bulkWrite(bulkOps, {
        ordered: false,
        w: 1,
        j: false
      });
      
      // Redis 캐싱 최적화
      const pipeline = redisManager.pubClient.pipeline();
      const messagesByRoom = {};
      
      messages.forEach(msg => {
        const roomId = msg.room;
        if (!messagesByRoom[roomId]) {
          messagesByRoom[roomId] = [];
        }
        messagesByRoom[roomId].push(msg);
        
        const roomKey = `chat:room:${roomId}:messages`;
        const timestamp = new Date(msg.timestamp).getTime();
        
        pipeline.zadd(roomKey, timestamp, timestamp.toString());
        pipeline.set(
          `chat:message:${roomId}:${timestamp}`, 
          JSON.stringify(msg), 
          'EX', 
          this.CACHE_TTL
        );
      });
      
      await pipeline.exec();
    } catch (error) {
      logger.error('Message buffer flush error:', error);
      this.messageBuffer.push(...messages);
    }
  }

  // 개발 환경에서 쿼리 성능 모니터링
  async analyzeRoomQueries(roomId) {
    if (process.env.NODE_ENV === 'development') {
      try {
        return await Message.analyzeQueryPlan(roomId);
      } catch (error) {
        logger.error('Query analysis error:', error);
        return null;
      }
    }
  }
}

module.exports = new ChatService();