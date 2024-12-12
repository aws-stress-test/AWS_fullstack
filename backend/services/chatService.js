const Message = require('../models/Message');
const messageQueue = require('../utils/queue');
const redisManager = require('../config/redis');
const logger = require('../utils/logger');
const User = require('../models/User');
const File = require('../models/File');

class ChatService {
  constructor() {
    this.messageBuffer = [];
    this.BATCH_SIZE = redisManager.BATCH_SIZE;
    this.FLUSH_INTERVAL = 100;
    this.CACHE_TTL = redisManager.defaultTTL;
    this.MESSAGES_PER_PAGE = 30;
    this.USER_CACHE_TTL = 3600;
    this.FILE_CACHE_TTL = 3600;
    
    setInterval(() => this.flushMessageBuffer(), this.FLUSH_INTERVAL);
  }

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

      await this.getUserFromCache(userId);
      if (message.file) {
        await this.getFileFromCache(message.file);
      }

      const roomKey = `chat:room:${message.room}:messages`;
      const messageCacheKey = `chat:message:${message.room}:${message.timestamp}`;
      
      const pipeline = redisManager.pubClient.pipeline();
      
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

  async handleBulkMessages(messages) {
    try {
      if (!Array.isArray(messages)) {
        throw new Error('handleBulkMessages: messages should be an array');
      }
      this.messageBuffer.push(...messages);

      if (this.messageBuffer.length >= this.BATCH_SIZE) {
        await this.flushMessageBuffer();
      }
    } catch (error) {
      logger.error('handleBulkMessages error:', error);
      throw error;
    }
  }

  async markMessagesAsRead(roomId, userId, messageIds) {
    try {
      if (!messageIds || !messageIds.length) return;
      const modifiedCount = await Message.markAsRead(messageIds, userId);
      return modifiedCount;
    } catch (error) {
      logger.error('markMessagesAsRead error:', error);
      throw error;
    }
  }

  async handleReaction(messageId, reaction, type, userId) {
    try {
      const msg = await Message.findById(messageId);
      if (!msg) throw new Error('Message not found');

      if (type === 'add') {
        await msg.addReaction(reaction, userId);
      } else if (type === 'remove') {
        await msg.removeReaction(reaction, userId);
      } else {
        throw new Error('Invalid reaction type');
      }

      // 캐시 갱신 필요 시 여기서 처리

    } catch (error) {
      logger.error('handleReaction error:', error);
      throw error;
    }
  }

  async getMessageById(messageId) {
    try {
      if (!messageId) throw new Error('messageId is required');

      const cacheKey = `chat:message:id:${messageId}`;
      let cached = await redisManager.pubClient.get(cacheKey);
      if (cached) return JSON.parse(cached);

      const msg = await Message.findById(messageId).lean();
      if (!msg) return null;

      const enrichedMsg = await this.enrichMessageData(msg);
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
      let messages = await this.loadMessagesFromRedis(roomKey, before, limit);
      
      if (!messages || messages.length < limit) {
        messages = await this.loadMessagesFromDB(roomId, before, limit);
        if (messages.length > 0) {
          this.cacheMessages(roomId, messages).catch(err => logger.error('Cache rebuild failed:', err));
        }
      }
  
      return {
        messages: messages.slice(0, limit),
        hasMore: messages.length > limit,
        oldestTimestamp: messages[messages.length - 1]?.timestamp
      };
    } catch (error) {
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
        roomKey, max, min, 'LIMIT', 0, limit + 1
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
      return await Promise.all(messages.map(msg => this.enrichMessageData(msg)));
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
      const bulkOps = messages.map(msg => ({ insertOne: { document: msg } }));
      
      await Message.bulkWrite(bulkOps, { ordered: false, w: 1, j: false });

      const pipeline = redisManager.pubClient.pipeline();
      messages.forEach(msg => {
        const roomId = msg.room;
        const roomKey = `chat:room:${roomId}:messages`;
        const timestamp = new Date(msg.timestamp).getTime();
        
        pipeline.zadd(roomKey, timestamp, timestamp.toString());
        pipeline.set(`chat:message:${roomId}:${timestamp}`, JSON.stringify(msg), 'EX', this.CACHE_TTL);
      });
      
      await pipeline.exec();
    } catch (error) {
      logger.error('Message buffer flush error:', error);
      this.messageBuffer.push(...messages);
    }
  }

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
