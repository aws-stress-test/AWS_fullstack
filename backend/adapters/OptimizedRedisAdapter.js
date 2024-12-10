const { createAdapter } = require('@socket.io/redis-adapter');
const logger = require('../utils/logger');

class OptimizedRedisAdapter {
  constructor(pubClient, subClient) {
    this.pubClient = pubClient;
    this.subClient = subClient;
    this.subscribedRooms = new Set();
    this.adapter = null;
  }

  createAdapter(io) {
    try {
      // 기본 Redis Adapter 생성
      this.adapter = createAdapter(this.pubClient, this.subClient);

      // Adapter 이벤트 처리
      this.adapter.on('error', (error) => {
        logger.error('Redis Adapter 에러:', error);
      });

      // 기존 Adapter의 메서드를 확장하여 최적화
      const originalJoin = io.adapter.join;
      const originalLeave = io.adapter.leave;

      // Join 메서드 최적화
      io.adapter.join = async (socket, room) => {
        try {
          // 기존 join 로직 실행
          await originalJoin.call(io.adapter, socket, room);

          // 해당 room의 첫 구독자인 경우에만 Redis subscribe
          if (!this.subscribedRooms.has(room)) {
            await this.subscribeToRoom(room);
          }
        } catch (error) {
          logger.error(`Room ${room} join 실패:`, error);
          throw error;
        }
      };

      // Leave 메서드 최적화
      io.adapter.leave = async (socket, room) => {
        try {
          // 기존 leave 로직 실행
          await originalLeave.call(io.adapter, socket, room);

          // room에 더 이상 접속자가 없는 경우 구독 해제
          const sockets = await io.adapter.sockets(new Set([room]));
          if (sockets.size === 0) {
            await this.unsubscribeFromRoom(room);
          }
        } catch (error) {
          logger.error(`Room ${room} leave 실패:`, error);
          throw error;
        }
      };

      return this.adapter;
    } catch (error) {
      logger.error('Redis Adapter 생성 실패:', error);
      throw error;
    }
  }

  async subscribeToRoom(room) {
    try {
      await this.subClient.subscribe(room);
      this.subscribedRooms.add(room);
      logger.info(`Room ${room} 구독 완료`);

      // 구독 상태 체크 예약
      setTimeout(() => this.checkSubscriptionState(room), 1000);
    } catch (error) {
      logger.error(`Room ${room} 구독 실패:`, error);
      throw error;
    }
  }

  async unsubscribeFromRoom(room) {
    try {
      await this.subClient.unsubscribe(room);
      this.subscribedRooms.delete(room);
      logger.info(`Room ${room} 구독 해제 완료`);
    } catch (error) {
      logger.error(`Room ${room} 구독 해제 실패:`, error);
      throw error;
    }
  }

  async checkSubscriptionState(room) {
    try {
      const sockets = await this.adapter.sockets(new Set([room]));
      if (sockets.size === 0 && this.subscribedRooms.has(room)) {
        await this.unsubscribeFromRoom(room);
        logger.info(`Room ${room} 불필요한 구독 제거`);
      }
    } catch (error) {
      logger.error(`Room ${room} 구독 상태 확인 실패:`, error);
    }
  }

  // 구독 상태 모니터링
  getSubscriptionStatus() {
    return {
      subscribedRooms: Array.from(this.subscribedRooms),
      totalSubscriptions: this.subscribedRooms.size
    };
  }
}

module.exports = OptimizedRedisAdapter; 