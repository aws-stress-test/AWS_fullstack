const { createAdapter } = require('@socket.io/redis-adapter');

class OptimizedRedisAdapter {
  constructor(pubClient, subClient) {
    this.pubClient = pubClient;
    this.subClient = subClient;
    this.subscribedRooms = new Set();
    this.socketRooms = new Map();
    this.connectionPromises = new Map();
    this.roomSubscriptionCache = new Map();
    this.SUBSCRIPTION_TIMEOUT = 3000;

    // Sentinel 이벤트 핸들링
    this.pubClient.on('+failover-end', this.handleFailover.bind(this));
    this.subClient.on('+failover-end', this.handleFailover.bind(this));
  }

  async handleFailover() {
    console.log('Redis Adapter Failover 처리 시작');
    try {
      // 기존 구독 정보 백업
      const roomsToResubscribe = new Set(this.subscribedRooms);
      
      // 구독 상태 초기화
      this.subscribedRooms.clear();
      this.roomSubscriptionCache.clear();

      // 재구독
      for (const room of roomsToResubscribe) {
        if (this.shouldSubscribe(room)) {
          await this.subscribeToRoom(room, new Set([room]));
        }
      }

      console.log('Redis Adapter Failover 처리 완료');
    } catch (error) {
      console.error('Redis Adapter Failover 처리 실패:', error);
    }
  }

  createAdapter(io) {
    try {
      const adapter = createAdapter(this.pubClient, this.subClient, {
        publishOnSpecificResponseChannel: true,
        requestsTimeout: 5000
      });
      
      io.adapter(adapter);

      io.on('connection', this.handleConnection.bind(this));

      console.log('Redis Adapter 생성 완료');
      return adapter;

    } catch (error) {
      console.error('Redis Adapter 생성 실패:', error);
      throw error;
    }
  }

  async handleConnection(socket) {
    const initPromise = this.initializeSocket(socket);
    this.connectionPromises.set(socket.id, initPromise);

    try {
      await Promise.race([
        initPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 5000)
        )
      ]);
      
      console.log(`Socket ${socket.id} initialized successfully`);
      
      this.setupSocketListeners(socket);
      
    } catch (error) {
      console.error(`Socket ${socket.id} initialization failed:`, error);
      socket.disconnect(true);
    }
  }

  setupSocketListeners(socket) {
    const cleanup = () => {
      this.connectionPromises.delete(socket.id);
      this.handleDisconnect(socket.id);
      console.log(`Client disconnected: ${socket.id}`);
    };

    socket.on('disconnect', cleanup);
    socket.on('error', (error) => {
      console.error(`Socket ${socket.id} error:`, error);
      cleanup();
    });
  }

  async initializeSocket(socket) {
    this.socketRooms.set(socket.id, new Set());
    
    return new Promise((resolve) => {
      socket.emit('init');
      socket.once('ready', resolve);
    });
  }

  async handleRoomJoin(socketId, rooms) {
    const roomArray = Array.isArray(rooms) ? rooms : [rooms];
    const socketRooms = this.socketRooms.get(socketId) || new Set();
    
    await Promise.all([
      this.connectionPromises.get(socketId),
      ...roomArray.map(room => this.subscribeToRoom(room, socketRooms))
    ]);

    this.socketRooms.set(socketId, socketRooms);
  }

  async subscribeToRoom(room, socketRooms) {
    socketRooms.add(room);
    
    if (this.roomSubscriptionCache.get(room)) {
      return;
    }

    if (!this.subscribedRooms.has(room)) {
      try {
        await Promise.race([
          this.subClient.subscribe(room),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Subscription timeout')), this.SUBSCRIPTION_TIMEOUT)
          )
        ]);
        
        this.subscribedRooms.add(room);
        this.roomSubscriptionCache.set(room, true);
        console.log(`Subscribed to room ${room}`);
        
      } catch (err) {
        console.error(`Failed to subscribe to room ${room}:`, err);
        throw err;
      }
    }
  }

  async handleRoomLeave(socketId, rooms) {
    const roomArray = Array.isArray(rooms) ? rooms : [rooms];
    const socketRooms = this.socketRooms.get(socketId);

    if (socketRooms) {
      await Promise.all(
        roomArray.map(room => this.unsubscribeFromRoom(room, socketRooms))
      );
    }
  }

  async unsubscribeFromRoom(room, socketRooms) {
    socketRooms.delete(room);
    
    const isRoomInUse = Array.from(this.socketRooms.values())
      .some(rooms => rooms.has(room));

    if (!isRoomInUse && this.subscribedRooms.has(room)) {
      try {
        await this.subClient.unsubscribe(room);
        this.subscribedRooms.delete(room);
        this.roomSubscriptionCache.delete(room);
        console.log(`Unsubscribed from room ${room}`);
      } catch (err) {
        console.error(`Failed to unsubscribe from room ${room}:`, err);
      }
    }
  }

  handleDisconnect(socketId) {
    const rooms = this.socketRooms.get(socketId);
    if (rooms) {
      rooms.forEach(room => this.checkRoomUnsubscription(room));
    }
    this.socketRooms.delete(socketId);
    this.connectionPromises.delete(socketId);
  }

  checkRoomSubscription(room) {
    if (!this.shouldSubscribe(room)) {
      this.subClient.unsubscribe(room)
        .then(() => {
          this.subscribedRooms.delete(room);
          console.log(`Unsubscribed from room ${room} after check`);
        })
        .catch(err => {
          console.error(`Failed to unsubscribe from room ${room}:`, err);
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
          console.log(`Unsubscribed from room ${room}`);
        })
        .catch(err => {
          console.error(`Failed to unsubscribe from room ${room}:`, err);
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