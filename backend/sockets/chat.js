const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const SessionService = require('../services/sessionService');
const ChatService = require('../services/chatService');
const aiService = require('../services/aiService');
const User = require('../models/User');
const Room = require('../models/Room');
const logger = require('../utils/logger');

module.exports = function(io) {
  const connectedUsers = new Map();
  const streamingSessions = new Map();
  const userRooms = new Map();
  const messageLoadRetries = new Map();

  const BATCH_SIZE = 30;
  const LOAD_DELAY = 300;
  const MAX_RETRIES = 3;
  const MESSAGE_LOAD_TIMEOUT = 10000;
  const RETRY_DELAY = 2000;
  const DUPLICATE_LOGIN_TIMEOUT = 10000;

  const logDebug = (action, data) => {
    logger.debug(`[Socket.IO] ${action}: ${JSON.stringify({ ...data, timestamp: new Date().toISOString() })}`);
  };

  const handleDuplicateLogin = async (existingSocket, newSocket) => {
    try {
      existingSocket.emit('duplicate_login', {
        type: 'new_login_attempt',
        deviceInfo: newSocket.handshake.headers['user-agent'],
        ipAddress: newSocket.handshake.address,
        timestamp: Date.now()
      });
      return new Promise((resolve) => {
        setTimeout(async () => {
          try {
            existingSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });
            existingSocket.disconnect(true);
            resolve();
          } catch (error) {
            logger.error('Error during session termination:', error);
            resolve();
          }
        }, DUPLICATE_LOGIN_TIMEOUT);
      });
    } catch (error) {
      logger.error('Duplicate login handling error:', error);
      throw error;
    }
  };

  const loadMessagesWithRetry = async (socket, roomId, before, retryCount = 0) => {
    const retryKey = `${roomId}:${socket.user.id}`;
    try {
      if (messageLoadRetries.get(retryKey) >= MAX_RETRIES) {
        throw new Error('최대 재시도 횟수를 초과했습니다.');
      }

      const result = await ChatService.loadMessages(roomId, before, BATCH_SIZE);
      messageLoadRetries.delete(retryKey);
      return result;
    } catch (error) {
      const currentRetries = messageLoadRetries.get(retryKey) || 0;
      if (currentRetries < MAX_RETRIES) {
        messageLoadRetries.set(retryKey, currentRetries + 1);
        const delay = Math.min(RETRY_DELAY * Math.pow(2, currentRetries), 10000);
        logDebug('retrying message load', { roomId, retryCount: currentRetries + 1, delay });

        await new Promise(resolve => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, currentRetries + 1);
      }
      messageLoadRetries.delete(retryKey);
      throw error;
    }
  };

  // 인증 미들웨어
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const sessionId = socket.handshake.auth.sessionId;
      if (!token || !sessionId) return next(new Error('Authentication error'));

      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded?.user?.id) return next(new Error('Invalid token'));

      const existingSocketId = connectedUsers.get(decoded.user.id);
      if (existingSocketId) {
        const existingSocket = io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          await handleDuplicateLogin(existingSocket, socket);
        }
      }

      const validationResult = await SessionService.validateSession(decoded.user.id, sessionId);
      if (!validationResult.isValid) {
        logger.error('Session validation failed:', validationResult);
        return next(new Error(validationResult.message || 'Invalid session'));
      }

      const user = await User.findById(decoded.user.id);
      if (!user) return next(new Error('User not found'));

      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage
      };

      await SessionService.updateLastActivity(decoded.user.id);
      next();

    } catch (error) {
      logger.error('Socket authentication error:', error);
      if (error.name === 'TokenExpiredError') return next(new Error('Token expired'));
      if (error.name === 'JsonWebTokenError') return next(new Error('Invalid token'));
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    logDebug('socket connected', {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name
    });

    if (socket.user) {
      const previousSocketId = connectedUsers.get(socket.user.id);
      if (previousSocketId && previousSocketId !== socket.id) {
        const previousSocket = io.sockets.sockets.get(previousSocketId);
        if (previousSocket) {
          previousSocket.emit('duplicate_login', {
            type: 'new_login_attempt',
            deviceInfo: socket.handshake.headers['user-agent'],
            ipAddress: socket.handshake.address,
            timestamp: Date.now()
          });

          setTimeout(() => {
            previousSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });
            previousSocket.disconnect(true);
          }, DUPLICATE_LOGIN_TIMEOUT);
        }
      }
      connectedUsers.set(socket.user.id, socket.id);
    }

    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      try {
        if (!socket.user) throw new Error('Unauthorized');
        const room = await Room.findOne({ _id: roomId, participants: socket.user.id });
        if (!room) throw new Error('채팅방 접근 권한이 없습니다.');

        socket.emit('messageLoadStart');
        const result = await loadMessagesWithRetry(socket, roomId, before);
        socket.emit('previousMessagesLoaded', result);

      } catch (error) {
        logger.error('Fetch previous messages error:', error);
        socket.emit('error', {
          type: 'LOAD_ERROR',
          message: error.message || '이전 메시지를 불러오는 중 오류가 발생했습니다.'
        });
      }
    });

    socket.on('joinRoom', async (roomId) => {
      try {
        if (!socket.user) throw new Error('Unauthorized');

        // 이미 참여 중인 방에서 나가기
        const currentRoom = userRooms.get(socket.user.id);
        if (currentRoom && currentRoom !== roomId) {
          socket.leave(currentRoom);
          userRooms.delete(socket.user.id);
          io.to(currentRoom).emit('participantsUpdate', []);
        }

        const room = await Room.findByIdAndUpdate(
          roomId,
          { $addToSet: { participants: socket.user.id } },
          { new: true }
        ).populate('participants', 'name email profileImage');

        if (!room) throw new Error('채팅방을 찾을 수 없습니다.');

        socket.join(roomId);
        userRooms.set(socket.user.id, roomId);

        // 입장 시스템 메시지
        const joinMsg = {
          room: roomId,
          type: 'system',
          content: `${socket.user.name}님이 입장하였습니다.`,
          timestamp: Date.now()
        };
        await ChatService.handleBulkMessages([joinMsg]);

        const { messages, hasMore, oldestTimestamp } = await ChatService.loadMessages(roomId);

        // 참여자 업데이트 이벤트 보내기
        io.to(roomId).emit('participantsUpdate', room.participants);

        // 모든 클라이언트에게 방 정보 업데이트 이벤트
        io.emit('roomUpdated', {
          ...room.toObject(),
          participants: room.participants
        });

        socket.emit('joinRoomSuccess', {
          roomId,
          participants: room.participants,
          messages,
          hasMore,
          oldestTimestamp,
          activeStreams: []
        });
        
        const activeStreams = Array.from(streamingSessions.values())
          .filter(session => session.room === roomId)
          .map(session => ({
            _id: session.messageId,
            type: 'ai',
            aiType: session.aiType,
            content: session.content,
            timestamp: session.timestamp,
            isStreaming: true
          }));

        socket.emit('joinRoomSuccess', {
          roomId,
          participants: room.participants,
          messages,
          hasMore,
          oldestTimestamp,
          activeStreams
        });

        io.to(roomId).emit('participantsUpdate', room.participants);

        logDebug('user joined room', {
          userId: socket.user.id,
          roomId,
          messageCount: messages.length,
          hasMore
        });

      } catch (error) {
        logger.error('Join room error:', error);
        socket.emit('joinRoomError', {
          message: error.message || '채팅방 입장에 실패했습니다.'
        });
      }
    });

    socket.on('chatMessage', async (messageData) => {
      try {
        if (!socket.user) throw new Error('Unauthorized');
        if (!messageData) throw new Error('메시지 데이터가 없습니다.');

        const { room, type, content, fileData } = messageData;
        if (!room) throw new Error('채팅방 정보가 없습니다.');

        const chatRoom = await Room.findOne({ _id: room, participants: socket.user.id });
        if (!chatRoom) throw new Error('채팅방 접근 권한이 없습니다.');

        const sessionValidation = await SessionService.validateSession(socket.user.id, socket.user.sessionId);
        if (!sessionValidation.isValid) {
          throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
        }

        const processedContent = content?.trim();
        if (type === 'text' && !processedContent) return;

        const msgData = {
          room,
          type,
          content: processedContent,
          ...(fileData?._id && { fileData: fileData._id })
        };

        const result = await ChatService.handleMessage(msgData, socket.user.id);
        // 메시지를 보냈다는 클라이언트 응답(임시 ID 매핑)
        socket.emit('messageSent', {
          success: true,
          tempId: result.tempId,
          timestamp: result.timestamp
        });

        const aiMentions = extractAIMentions(processedContent);
        if (aiMentions.length > 0) {
          for (const aiName of aiMentions) {
            const query = processedContent.replace(new RegExp(`@${aiName}\\b`, 'g'), '').trim();
            await handleAIResponse(room, aiName, query);
          }
        }

        await SessionService.updateLastActivity(socket.user.id);

      } catch (error) {
        logger.error('Message handling error:', error);
        socket.emit('error', {
          code: error.code || 'MESSAGE_ERROR',
          message: error.message || '메시지 전송 중 오류가 발생했습니다.'
        });
      }
    });

    socket.on('leaveRoom', async (roomId) => {
      try {
        if (!socket.user) throw new Error('Unauthorized');
        const currentRoom = userRooms.get(socket.user.id);
        if (!currentRoom || currentRoom !== roomId) return;

        const room = await Room.findOne({ _id: roomId, participants: socket.user.id }).lean();
        if (!room) return;

        socket.leave(roomId);
        userRooms.delete(socket.user.id);

        const leaveMsg = {
          room: roomId,
          type: 'system',
          content: `${socket.user.name}님이 퇴장하였습니다.`,
          timestamp: Date.now()
        };
        await ChatService.handleBulkMessages([leaveMsg]);

        const updatedRoom = await Room.findByIdAndUpdate(
          roomId,
          { $pull: { participants: socket.user.id } },
          { new: true }
        ).populate('participants', 'name email profileImage');

        for (const [messageId, session] of streamingSessions.entries()) {
          if (session.room === roomId && session.userId === socket.user.id) {
            streamingSessions.delete(messageId);
          }
        }

        if (updatedRoom) {
          io.to(roomId).emit('participantsUpdate', updatedRoom.participants);
          // 모든 클라이언트에 방 업데이트 이벤트 emit
          io.emit('roomUpdated', {
            ...updatedRoom.toObject(),
            participants: updatedRoom.participants
          });
        }

      } catch (error) {
        logger.error('Leave room error:', error);
        socket.emit('error', {
          message: error.message || '채팅방 퇴장 중 오류가 발생했습니다.'
        });
      }
    });

    socket.on('markMessagesAsRead', async ({ roomId, messageIds }) => {
      try {
        if (!socket.user) throw new Error('Unauthorized');
        if (!Array.isArray(messageIds) || messageIds.length === 0) return;

        await ChatService.markMessagesAsRead(roomId, socket.user.id, messageIds);
        socket.to(roomId).emit('messagesRead', {
          userId: socket.user.id,
          messageIds
        });

      } catch (error) {
        logger.error('Mark messages as read error:', error);
        socket.emit('error', {
          message: '읽음 상태 업데이트 중 오류가 발생했습니다.'
        });
      }
    });

    socket.on('messageReaction', async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) throw new Error('Unauthorized');

        const updatedReactions = await ChatService.handleReaction(messageId, reaction, type, socket.user.id);
        const msg = await ChatService.getMessageById(messageId);
        if (msg) {
          io.to(msg.room).emit('messageReactionUpdate', {
            messageId,
            reactions: msg.reactions
          });
        }
      } catch (error) {
        logger.error('Message reaction error:', error);
        socket.emit('error', {
          message: error.message || '리액션 처리 중 오류가 발생했습니다.'
        });
      }
    });

    socket.on('disconnect', async (reason) => {
      if (!socket.user) return;

      try {
        if (connectedUsers.get(socket.user.id) === socket.id) {
          connectedUsers.delete(socket.user.id);
        }

        const roomId = userRooms.get(socket.user.id);
        userRooms.delete(socket.user.id);

        for (const [messageId, session] of streamingSessions.entries()) {
          if (session.userId === socket.user.id) {
            streamingSessions.delete(messageId);
          }
        }

        if (roomId && reason !== 'client namespace disconnect' && reason !== 'duplicate_login') {
          const leaveMsg = {
            room: roomId,
            type: 'system',
            content: `${socket.user.name}님이 연결이 끊어졌습니다.`,
            timestamp: Date.now()
          };
          await ChatService.handleBulkMessages([leaveMsg]);

          const updatedRoom = await Room.findByIdAndUpdate(
            roomId,
            { $pull: { participants: socket.user.id } },
            { new: true }
          ).populate('participants', 'name email profileImage');

          if (updatedRoom) {
            io.to(roomId).emit('participantsUpdate', updatedRoom.participants);
            // 모든 클라이언트에 방 업데이트 이벤트 emit
            io.emit('roomUpdated', {
              ...updatedRoom.toObject(),
              participants: updatedRoom.participants
            });
          }
        }

        logDebug('user disconnected', {
          reason,
          userId: socket.user.id,
          socketId: socket.id,
          lastRoom: roomId
        });

      } catch (error) {
        logger.error('Disconnect handling error:', error);
      }
    });

    socket.on('force_login', async ({ token }) => {
      try {
        if (!socket.user) return;
        const decoded = jwt.verify(token, jwtSecret);
        if (!decoded?.user?.id || decoded.user.id !== socket.user.id) {
          throw new Error('Invalid token');
        }

        socket.emit('session_ended', {
          reason: 'force_logout',
          message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
        });
        socket.disconnect(true);

      } catch (error) {
        logger.error('Force login error:', error);
        socket.emit('error', {
          message: '세션 종료 중 오류가 발생했습니다.'
        });
      }
    });

    function extractAIMentions(content) {
      if (!content) return [];
      const aiTypes = ['wayneAI', 'consultingAI'];
      const mentions = new Set();
      const mentionRegex = /@(wayneAI|consultingAI)\b/g;
      let match;
      while ((match = mentionRegex.exec(content)) !== null) {
        if (aiTypes.includes(match[1])) {
          mentions.add(match[1]);
        }
      }
      return Array.from(mentions);
    }

    async function handleAIResponse(room, aiName, query) {
      const messageId = `${aiName}-${Date.now()}`;
      let accumulatedContent = '';
      const timestamp = Date.now();

      streamingSessions.set(messageId, {
        room,
        aiType: aiName,
        content: '',
        messageId,
        timestamp,
        lastUpdate: Date.now(),
        reactions: {}
      });

      io.to(room).emit('aiMessageStart', {
        messageId,
        aiType: aiName,
        timestamp
      });

      try {
        await aiService.generateResponse(query, aiName, {
          onStart: () => {
            logDebug('AI generation started', { messageId, aiType: aiName });
          },
          onChunk: async (chunk) => {
            accumulatedContent += chunk.currentChunk || '';
            const session = streamingSessions.get(messageId);
            if (session) {
              session.content = accumulatedContent;
              session.lastUpdate = Date.now();
            }

            io.to(room).emit('aiMessageChunk', {
              messageId,
              currentChunk: chunk.currentChunk,
              fullContent: accumulatedContent,
              isCodeBlock: chunk.isCodeBlock,
              timestamp: Date.now(),
              aiType: aiName,
              isComplete: false
            });
          },
          onComplete: async (finalContent) => {
            streamingSessions.delete(messageId);
            const aiMsg = {
              room,
              content: finalContent.content,
              type: 'ai',
              aiType: aiName,
              timestamp: Date.now(),
              reactions: {},
              metadata: {
                query,
                generationTime: Date.now() - timestamp,
                completionTokens: finalContent.completionTokens,
                totalTokens: finalContent.totalTokens
              }
            };
            await ChatService.handleBulkMessages([aiMsg]);

            io.to(room).emit('aiMessageComplete', {
              messageId,
              content: finalContent.content,
              aiType: aiName,
              timestamp: Date.now(),
              isComplete: true,
              query,
              reactions: {}
            });

            logDebug('AI response completed', {
              messageId,
              aiType: aiName,
              contentLength: finalContent.content.length,
              generationTime: Date.now() - timestamp
            });
          },
          onError: (error) => {
            streamingSessions.delete(messageId);
            logger.error('AI response error:', error);

            io.to(room).emit('aiMessageError', {
              messageId,
              error: error.message || 'AI 응답 생성 중 오류가 발생했습니다.',
              aiType: aiName
            });

            logDebug('AI response error', {
              messageId,
              aiType: aiName,
              error: error.message
            });
          }
        });
      } catch (error) {
        streamingSessions.delete(messageId);
        logger.error('AI service error:', error);
        io.to(room).emit('aiMessageError', {
          messageId,
          error: error.message || 'AI 서비스 오류가 발생했습니다.',
          aiType: aiName
        });
        logDebug('AI service error', {
          messageId,
          aiType: aiName,
          error: error.message
        });
      }
    }
  });

  return io;
};
