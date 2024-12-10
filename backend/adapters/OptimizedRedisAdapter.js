const { createAdapter } = require('@socket.io/redis-adapter');
const logger = require('../utils/logger');

class OptimizedRedisAdapter {
  constructor(pubClient, subClient) {
    this.pubClient = pubClient;
    this.subClient = subClient;
    this.subscribedRooms = new Set();
    this.socketRooms = new Map();
  }

  createAdapter(io) {
    try {
      const adapter = createAdapter(this.pubClient, this.subClient);
      io.adapter(adapter);

      const originalJoin = adapter.join;
      const originalLeave = adapter.leave;

      adapter.join = async (socketId, rooms) => {
        await originalJoin.call(adapter, socketId, rooms);
        
        this.handleRoomJoin(socketId, rooms);
      };

      adapter.leave = async (socketId, rooms) => {
        await originalLeave.call(adapter, socketId, rooms);
        
        this.handleRoomLeave(socketId, rooms);
      };

      io.on('connection', (socket) => {
        logger.info(`Client connected: ${socket.id}`);
        this.socketRooms.set(socket.id, new Set());

        socket.on('disconnect', () => {
          logger.info(`Client disconnected: ${socket.id}`);
          this.handleDisconnect(socket.id);
        });
      });

      logger.info('Redis Adapter 생성 완료');
      return adapter;

    } catch (error) {
      logger.error('Redis Adapter 생성 실패:', error);
      throw error;
    }
  }

  handleRoomJoin(socketId, rooms) {
    const roomArray = Array.isArray(rooms) ? rooms : [rooms];
    const socketRooms = this.socketRooms.get(socketId) || new Set();

    roomArray.forEach(room => {
      socketRooms.add(room);
      if (!this.subscribedRooms.has(room)) {
        this.subClient.subscribe(room)
          .then(() => {
            this.subscribedRooms.add(room);
            logger.info(`Subscribed to room ${room}`);
          })
          .catch(err => {
            logger.error(`Failed to subscribe to room ${room}:`, err);
          })
          .finally(() => this.checkRoomSubscription(room));
      }
    });

    this.socketRooms.set(socketId, socketRooms);
  }

  handleRoomLeave(socketId, rooms) {
    const roomArray = Array.isArray(rooms) ? rooms : [rooms];
    const socketRooms = this.socketRooms.get(socketId);

    if (socketRooms) {
      roomArray.forEach(room => {
        socketRooms.delete(room);
        this.checkRoomUnsubscription(room);
      });
    }
  }

  handleDisconnect(socketId) {
    const rooms = this.socketRooms.get(socketId);
    if (rooms) {
      rooms.forEach(room => {
        this.checkRoomUnsubscription(room);
      });
    }
    this.socketRooms.delete(socketId);
  }

  checkRoomSubscription(room) {
    if (!this.shouldSubscribe(room)) {
      this.subClient.unsubscribe(room)
        .then(() => {
          this.subscribedRooms.delete(room);
          logger.info(`Unsubscribed from room ${room} after check`);
        })
        .catch(err => {
          logger.error(`Failed to unsubscribe from room ${room}:`, err);
        });
    }
  }

  checkRoomUnsubscription(room) {
    let hasSubscribers = false;
    for (const [, rooms] of this.socketRooms) {
      if (rooms.has(room)) {
        hasSubscribers = true;
        break;
      }
    }

    if (!hasSubscribers && this.subscribedRooms.has(room)) {
      this.subClient.unsubscribe(room)
        .then(() => {
          this.subscribedRooms.delete(room);
          logger.info(`Unsubscribed from room ${room}`);
        })
        .catch(err => {
          logger.error(`Failed to unsubscribe from room ${room}:`, err);
        });
    }
  }

  shouldSubscribe(room) {
    for (const [, rooms] of this.socketRooms) {
      if (rooms.has(room)) {
        return true;
      }
    }
    return false;
  }
}

module.exports = OptimizedRedisAdapter; 