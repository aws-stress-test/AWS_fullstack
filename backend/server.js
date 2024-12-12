require('dotenv').config();
const cluster = require('cluster');
const os = require('os');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const http = require('http');
const socketIO = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const path = require('path');
const { router: roomsRouter, initializeSocket } = require('./routes/api/rooms');
const routes = require('./routes');
const redisManager = require('./config/redis');
const RateLimit = require('express-rate-limit');

if (cluster.isPrimary) {
  const numCPUs = os.cpus().length;

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });
} else {
  const app = express();
  const server = http.createServer(app);
  const PORT = process.env.PORT || 5000;

  // trust proxy 설정 추가
  app.set('trust proxy', 1);

  // CORS 설정
  const corsOptions = {
    origin: [
      'https://bootcampchat-fe.run.goorm.site',
      'http://localhost:3000',
      'https://localhost:3000',
      'http://0.0.0.0:3000',
      'https://0.0.0.0:3000',
      'https://goorm-ktb-018.goorm.team',
      'http://goorm-ktb-018.goorm.team',
      'http://10.0.5.112' 
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 
      'Authorization', 
      'x-auth-token', 
      'x-session-id',
      'Cache-Control',
      'Pragma'
    ],
    exposedHeaders: ['x-auth-token', 'x-session-id']
  };

  // 기본 미들웨어
  app.use(cors(corsOptions));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // OPTIONS 요청에 대한 처리
  app.options('*', cors(corsOptions));

  // 정적 파일 제공
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  // 요청 로깅
  if (process.env.NODE_ENV === 'development') {
    app.use((req, res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
      next();
    });
  }

  // 기본 상태 체크
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      env: process.env.NODE_ENV
    });
  });

  // API 라우트 마운트
  app.use('/api', routes);

  // Socket.IO 설정 최적화
  const io = socketIO(server, {
    cors: corsOptions,
    pingTimeout: 120000,        // 2분으로 증가하여 연결 안정성 향상
    pingInterval: 50000,        // 50초로 증가하여 불필요한 핑 감소
    transports: ['websocket'],  // 웹소켓만 사용하여 성능 최적화
    allowUpgrades: true,
    
    perMessageDeflate: {
      threshold: 1024,          // 1KB로 설정하여 작은 메시지 압축
      zlibInflateFilter: () => true,
      memLevel: 3,              // 메모리 사용량 최적화
      level: 2                  // 압축 레벨 조정
    },
    
    maxHttpBufferSize: 1e6,     // 1MB로 설정하여 대용량 메시지 처리
    connectTimeout: 10000,      // 10초로 설정하여 연결 안정성 향상
    
    adapter: createAdapter(
      redisManager.pubClient,
      redisManager.subClient,
      {
        publishOnSpecificResponseOnly: true,
        requestsTimeout: 5000,   // 5초로 설정하여 안정성 향상
        publishRetries: 3,       // 3회로 증가하여 안정성 향상
        key: 'socket.io',
        publishTimeout: 3000     // 3초로 설정하여 안정성 향상
      }
    ),

    upgradeTimeout: 10000,      // 업그레이드 타임아웃 10초로 설정
    serveClient: false,
    allowEIO3: false,
    cors: {
      ...corsOptions,
      preflightContinue: false,
      optionsSuccessStatus: 204
    }
  });

  // 연결 제한 설정
  const connectionLimiter = new RateLimit({
    windowMs: 60 * 1000,     
    max: 3000,               // 3000명으로 증가
    message: 'Too many connections',
    skipFailedRequests: true
  });

  // Socket.IO 미들웨어 최적화
  io.use(async (socket, next) => {
    try {
      const limited = await connectionLimiter.check(socket.handshake.address);
      if (limited) {
        return next(new Error('Too many connections'));
      }

      const memoryUsage = process.memoryUsage();
      if (memoryUsage.heapUsed > 0.8 * memoryUsage.heapTotal) {
        return next(new Error('Server is busy'));
      }

      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication required'));
      }

      const session = await redisManager.getSession(token);
      if (!session) {
        return next(new Error('Invalid session'));
      }

      socket.user = session.user;
      next();
    } catch (error) {
      next(new Error('Socket authentication failed'));
    }
  });

  // 소켓 이벤트 핸들러 연결
  require('./sockets/chat')(io);

  // Socket.IO 객체 전달
  initializeSocket(io);

  // Express 앱에서 Socket.IO 접근 가능하도록 설정
  app.set('io', io);

  // 404 에러 핸들러
  app.use((req, res) => {
    console.log('404 Error:', req.originalUrl);
    res.status(404).json({
      success: false,
      message: '요청하신 리소스를 찾을 수 없습니다.',
      path: req.originalUrl
    });
  });

  // 글로벌 에러 핸들러
  app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(err.status || 500).json({
      success: false,
      message: err.message || '서버 에러가 발생했습니다.',
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
  });

  // 서버 시작
  mongoose.connect(process.env.MONGO_URI)
    .then(() => {
      console.log('MongoDB Connected');
      server.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
        console.log('Environment:', process.env.NODE_ENV);
        console.log('API Base URL:', `http://0.0.0.0:${PORT}/api`);
      });
    })
    .catch(err => {
      console.error('Server startup error:', err);
      process.exit(1);
    });
}

module.exports = { app, server };
