const winston = require('winston');
const path = require('path');
const DailyRotateFile = require('winston-daily-rotate-file');

class Logger {
  constructor() {
    // 로그 레벨 정의
    this.levels = {
      error: 0,   // 심각한 에러
      warn: 1,    // 경고
      info: 2,    // 일반 정보
      debug: 3    // 디버그 정보
    };

    // 로그 색상 정의
    this.colors = {
      error: 'red',
      warn: 'yellow',
      info: 'green',
      debug: 'blue'
    };

    // 로그 포맷 정의
    const logFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json(),
      winston.format.printf(({ level, message, timestamp, ...metadata }) => {
        let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
        
        if (Object.keys(metadata).length > 0 && metadata.stack !== undefined) {
          msg += `\n${metadata.stack}`;
        } else if (Object.keys(metadata).length > 0) {
          msg += `\n${JSON.stringify(metadata, null, 2)}`;
        }
        
        return msg;
      })
    );

    // 로거 생성
    this.logger = winston.createLogger({
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      levels: this.levels,
      format: logFormat,
      transports: [
        // 콘솔 출력
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        }),
        
        // 에러 로그 파일
        new DailyRotateFile({
          filename: path.join('logs', 'error-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          level: 'error',
          maxSize: '20m',
          maxFiles: '14d',
          zippedArchive: true
        }),
        
        // 전체 로그 파일
        new DailyRotateFile({
          filename: path.join('logs', 'combined-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '14d',
          zippedArchive: true
        })
      ],
      exitOnError: false
    });

    // 개발 환경에서만 추가되는 디버그 로그 파일
    if (process.env.NODE_ENV !== 'production') {
      this.logger.add(
        new DailyRotateFile({
          filename: path.join('logs', 'debug-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          level: 'debug',
          maxSize: '20m',
          maxFiles: '7d',
          zippedArchive: true
        })
      );
    }

    winston.addColors(this.colors);
  }

  // 로깅 메서드들
  error(message, meta = {}) {
    this.logger.error(message, meta);
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  // Socket.IO 전용 로깅
  socketLog(action, data = {}) {
    const logMessage = {
      action,
      ...data,
      timestamp: new Date().toISOString()
    };
    this.debug(`[Socket.IO] ${action}`, logMessage);
  }

  // HTTP 요청 로깅
  httpLog(req, res, responseTime) {
    const logMessage = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      responseTime: `${responseTime}ms`,
      userAgent: req.get('user-agent'),
      ip: req.ip
    };
    this.info(`HTTP ${req.method} ${req.originalUrl}`, logMessage);
  }

  // 채팅 메시지 로깅
  chatLog(roomId, userId, messageType, content = '') {
    const logMessage = {
      roomId,
      userId,
      type: messageType,
      timestamp: new Date().toISOString(),
      contentLength: content.length
    };
    this.debug('Chat Message', logMessage);
  }

  // 성능 로깅
  performanceLog(operation, duration, meta = {}) {
    const logMessage = {
      operation,
      duration: `${duration}ms`,
      ...meta
    };
    this.debug('Performance', logMessage);
  }

  // 에러 로깅 헬퍼
  logError(error, context = {}) {
    const logMessage = {
      message: error.message,
      stack: error.stack,
      ...context,
      timestamp: new Date().toISOString()
    };
    this.error(error.message, logMessage);
  }
}

module.exports = new Logger();