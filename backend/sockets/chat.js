const ChatService = require('../services/chatService');
const SessionService = require('../services/sessionService');
const aiService = require('../services/aiService');
const logger = require('../utils/logger');

module.exports = function(io) {
  const connectedUsers = new Map();
  const streamingSessions = new Map();
  const userRooms = new Map();
  
  io.on('connection', async (socket) => {
    try {
      // 사용자 인증 처리
      const user = await SessionService.authenticateSocket(socket);
      if (!user) {
        socket.disconnect();
        return;
      }

      // 연결된 사용자 관리
      connectedUsers.set(socket.id, user);
      userRooms.set(socket.id, new Set());

      // 메시지 수신 처리
      socket.on('message', async (data) => {
        try {
          const result = await ChatService.handleMessage(data, user.id);
          socket.emit('messageSent', {
            success: true,
            tempId: result.tempId,
            timestamp: result.timestamp
          });
        } catch (error) {
          logger.error('Message handling error:', error);
          socket.emit('messageError', {
            error: error.message
          });
        }
      });

      // 메시지 로드 요청 처리
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

      // AI 메시지 처리
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

      // 연결 해제 처리
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

  return io;
};