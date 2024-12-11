require('dotenv').config();
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
    'https://0.0.0.0:3000'
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
  // 연결 최적화
  pingTimeout: 20000,        // 60s -> 30s로 감소
  pingInterval: 5000,       // 25s -> 10s로 감소
  transports: ['websocket'], // polling 제거
  allowUpgrades: false,
  
  // 성능 최적화
  perMessageDeflate: {
    threshold: 1024,         // 2KB -> 1KB로 감소
    zlibInflateFilter: () => true,
    memLevel: 4,            // 메모리 사용량 최적화
    level: 3                // 압축 레벨 조정
  },
  
  // 메모리 관리 최적화
  maxHttpBufferSize: 256e3,      // 512KB -> 256KB
  connectTimeout: 3000,          // 5000 -> 3000
  
  // 클러스터링 설정
  adapter: createAdapter(
    redisManager.pubClient,
    redisManager.subClient,
    {
      publishOnSpecificResponseOnly: true,
      requestsTimeout: 1500,        // 3000 -> 1500
      publishRetries: 1,           // 2 -> 1
      key: 'socket.io',           // 프로세스별 키 제거
      publishTimeout: 1000                  // Redis key prefix
    }
  ),

  // 추가 성능 설정
  upgradeTimeout: 5000,                // 업그레이드 타임아웃
  serveClient: false,                  // 클라이언트 서빙 비활성화
  allowEIO3: false,                    // EIO3 비활성화
  cors: {
    ...corsOptions,
    preflightContinue: false,
    optionsSuccessStatus: 204
  }
});

// 연결 제한 설정
const connectionLimiter = new RateLimit({
  windowMs: 60 * 1000,     
  max: 200,                // 100 -> 200으로 증가 (워커당 200명)
  message: 'Too many connections',
  skipFailedRequests: true // 실패한 요청은 카운트하지 않음
});

// Socket.IO 미들웨어 최적화
io.use(async (socket, next) => {
  try {
    // 연결 제한 체크
    const limited = await connectionLimiter.check(socket.handshake.address);
    if (limited) {
      return next(new Error('Too many connections'));
    }

    // 메모리 사용량 체크
    const memoryUsage = process.memoryUsage();
    if (memoryUsage.heapUsed > 0.7 * memoryUsage.heapTotal) {
      return next(new Error('Server is busy'));
    }

    // 토큰 검증 최적화
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    // 캐시된 세션 확인
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

// 메모리 모니터링 추가
// setInterval(() => {
//   const memoryUsage = process.memoryUsage();
//   const heapUsed = Math.round(memoryUsage.heapUsed / 1024 / 1024);
//   const heapTotal = Math.round(memoryUsage.heapTotal / 1024 / 1024);
  
//   console.log('메모리 사용량:', {
//     pid: process.pid,
//     heapUsed: `${heapUsed}MB`,
//     heapTotal: `${heapTotal}MB`,
//     percentage: `${Math.round((heapUsed / heapTotal) * 100)}%`,
//     connections: io.engine.clientsCount
//   });
// }, 30000);

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

module.exports = { app, server };