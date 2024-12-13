require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const cors = require("cors");
const http = require("http");
const socketIO = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const path = require("path");
const { router: roomsRouter, initializeSocket } = require("./routes/api/rooms");
const routes = require("./routes");
const redisManager = require("./config/redis");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// trust proxy 설정 추가
app.set("trust proxy", 1);

// CORS 설정
const corsOptions = {
  origin: [
    "https://bootcampchat-fe.run.goorm.site",
    "http://localhost:3000",
    "https://localhost:3000",
    "http://0.0.0.0:3000",
    "https://0.0.0.0:3000",
    "https://goorm-ktb-018.goorm.team",
    "http://goorm-ktb-018.goorm.team",
    "http://10.0.5.112",
    "https://api.goorm-ktb-018.goorm.team",
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-auth-token",
    "x-session-id",
    "Cache-Control",
    "Pragma",
  ],
  exposedHeaders: ["x-auth-token", "x-session-id"],
};

// 기본 미들웨어
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OPTIONS 요청에 대한 처리
app.options("*", cors(corsOptions));

// 정적 파일 제공
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// API 라우트 마운트
app.use("/api", routes);

// 요청 로깅
if (process.env.NODE_ENV === "development") {
  app.use((req, res, next) => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
    );
    next();
  });
}

// 기본 상태 체크
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
  });
});

(async () => {
  await redisManager.connect();

  // Redis pub/sub 클라이언트 설정
  const redisPubClient = redisManager.pubClient;
  const redisSubClient = redisManager.subClient;

  // Socket.IO 설정 최적화
  const io = socketIO(server, {
    cors: corsOptions,
    pingTimeout: 300000,
    pingInterval: 15000,
    transports: ["websocket", "polling"],
    allowUpgrades: true,
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    perMessageDeflate: {
      threshold: 1024,
      zlibInflateFilter: () => true,
      memLevel: 3,
      level: 2,
      chunkSize: 8 * 1024,
      windowBits: 14,
    },
    maxHttpBufferSize: 3e6,
    connectTimeout: 45000,
    adapter: createAdapter(redisPubClient, redisSubClient, {
      publishOnSpecificResponseOnly: true,
      requestsTimeout: 60000,
      publishRetries: 10,
      key: `socket.io`,
      publishTimeout: 10000,
      heartbeatInterval: 15000,
      heartbeatTimeout: 60000,
    }),
    upgradeTimeout: 10000,
    serveClient: false,
    allowEIO3: true,
    rememberUpgrade: true,
    destroyUpgrade: true,
    destroyUpgradeTimeout: 5000,
    cors: {
      ...corsOptions,
      preflightContinue: false,
      optionsSuccessStatus: 204,
    },
  });

  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    socket.on("sendMessage", (data) => {
      const { roomId, messageContent, senderId } = data;

      const message = {
        roomId,
        type: "text",
        content: messageContent,
        sender: senderId,
        timestamp: Date.now(),
      };

      // 메시지를 방에 있는 모든 사용자에게 전송
      io.to(roomId).emit("message", message);
      console.log("Message broadcasted:", message);
    });
  });

  // Redis pub/sub 채널 설정
  const PARTICIPANT_UPDATE_CHANNEL = "participant:updates";

  redisSubClient.subscribe(PARTICIPANT_UPDATE_CHANNEL);
  redisSubClient.on("message", (channel, message) => {
    if (channel === PARTICIPANT_UPDATE_CHANNEL) {
      try {
        const { roomId, participants } = JSON.parse(message);
        io.to(roomId).emit("participantsUpdate", participants);
        io.emit("roomUpdated", { _id: roomId, participants });
      } catch (error) {
        console.error("Redis message parsing error:", error);
      }
    }
  });

  require("./sockets/chat")(io);

  // Socket.IO 객체 전달
  initializeSocket(io);

  // Express 앱에서 Socket.IO 접근 가능하도록 설정
  app.set("io", io);
})();

// 404 에러 핸들러
app.use((req, res) => {
  console.log("404 Error:", req.originalUrl);
  res.status(404).json({
    success: false,
    message: "요청하신 리소스를 찾을 수 없습니다.",
    path: req.originalUrl,
  });
});

// 글로벌 에러 핸들러
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "서버 에러가 발생했습니다.",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

console.log("MONGO_URI:", process.env.MONGO_URI);

// 서버 시작
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/bootcampchat")
  .then(() => {
    console.log("MongoDB Connected");
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
      console.log("Environment:", process.env.NODE_ENV);
      console.log("API Base URL:", `http://0.0.0.0:${PORT}/api`);
    });
  })
  .catch((err) => {
    console.error("Server startup error:", err);
    process.exit(1);
  });

module.exports = { app, server };
