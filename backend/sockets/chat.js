const ChatService = require('../services/chatService');
const SessionService = require('../services/sessionService');
const aiService = require('../services/aiService');
const logger = require('../utils/logger');

module.exports = function(io) {
  const connectedUsers = new Map();
  const streamingSessions = new Map();
  const userRooms = new Map();
  
  // 메시지 버퍼 관리
  const messageBuffers = new Map(); // roomId별 메시지 버퍼
  const BUFFER_SIZE = 100;          // 버퍼 최대 크기
  const FLUSH_INTERVAL = 1000;      // 버퍼 플러시 간격 (1초)
  
  // 주기적인 버퍼 플러시
  const flushBuffers = async () => {
    for (const [roomId, buffer] of messageBuffers.entries()) {
      if (buffer.messages.length > 0) {
        try {
          // 버퍼의 메시지들을 일괄 처리
          const messages = buffer.messages;
          buffer.messages = [];
          
          // DB 저장 및 브로드캐스트
          await ChatService.handleBulkMessages(messages);
          io.to(roomId).emit('messages', messages);
          
        } catch (error) {
          logger.error('Buffer flush error:', error);
          // 실패한 메시지들을 다시 버퍼에 넣기
          buffer.messages.push(...messages);
        }
      }
    }
  };

  // 버퍼 플러시 스케줄러 시작
  const flushInterval = setInterval(flushBuffers, FLUSH_INTERVAL);

  io.on('connection', async (socket) => {
    try {
      const user = await SessionService.authenticateSocket(socket);
      if (!user) {
        socket.disconnect();
        return;
      }

      connectedUsers.set(socket.id, user);
      userRooms.set(socket.id, new Set());

      // 메시지 수신 처리 (버퍼링 적용)
      socket.on('message', async (data) => {
        try {
          const roomId = data.roomId;
          
          // 룸별 버퍼 초기화
          if (!messageBuffers.has(roomId)) {
            messageBuffers.set(roomId, {
              messages: [],
              lastFlush: Date.now()
            });
          }
          
          const buffer = messageBuffers.get(roomId);
          const message = {
            ...data,
            userId: user.id,
            timestamp: Date.now(),
            tempId: data.tempId
          };

          buffer.messages.push(message);

          // 임시 ID로 클라이언트에게 즉시 응답
          socket.emit('messageSent', {
            success: true,
            tempId: message.tempId,
            timestamp: message.timestamp
          });

          // 버퍼가 가득 차면 즉시 플러시
          if (buffer.messages.length >= BUFFER_SIZE) {
            const messages = buffer.messages;
            buffer.messages = [];
            
            try {
              await ChatService.handleBulkMessages(messages);
              io.to(roomId).emit('messages', messages);
            } catch (error) {
              logger.error('Immediate flush error:', error);
              buffer.messages.push(...messages);
            }
          }
        } catch (error) {
          logger.error('Message handling error:', error);
          socket.emit('messageError', {
            error: error.message
          });
        }
      });

      // 기존 코드...
      socket.on('loadMessages', async ({ roomId, before, limit }) => {
        try {
          const messages = await ChatService.loadMessages(roomId, before, limit);
          socket.emit('messagesLoaded', messages);
        } catch (error) {
          logger.error('Message loading error:', error);
          socket.emit('loadError', {
            error: error.message
          });
        }
      });

      socket.on('aiMessage', async ({ messageId, aiName, content }) => {
        try {
          const response = await aiService.processMessage(messageId, aiName, content);
          io.to(socket.rooms).emit('aiMessageResponse', response);
        } catch (error) {
          logger.error('AI message error:', error);
          socket.emit('aiMessageError', {
            messageId,
            error: error.message
          });
        }
      });

      // 연결 해제 시 정리 작업
      socket.on('disconnect', () => {
        connectedUsers.delete(socket.id);
        userRooms.delete(socket.id);
        streamingSessions.delete(socket.id);
      });

    } catch (error) {
      logger.error('Socket connection error:', error);
      socket.disconnect();
    }
  });

  // 서버 종료 시 정리
  process.on('SIGTERM', async () => {
    clearInterval(flushInterval);
    await flushBuffers(); // 남은 메시지 처리
    messageBuffers.clear();
  });

  return io;
};