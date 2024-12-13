// backend/middleware/upload.js
const multer = require("multer");
const { S3Client } = require("@aws-sdk/client-s3");
const multerS3 = require("multer-s3");

// AWS S3 설정
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// 허용할 파일 형식 (필요시 수정)
const ALLOWED_TYPES = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "video/mp4": [".mp4"],
  "video/webm": [".webm"],
  "video/quicktime": [".mov"],
  "audio/mpeg": [".mp3"],
  "audio/wav": [".wav"],
  "audio/ogg": [".ogg"],
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
};

// 파일명 sanitize 함수
function sanitizeFilename(filename) {
  // 알파벳, 숫자, ., _, -, 공백, 괄호 허용. 나머지는 언더바로 대체
  return filename.replace(/[^\w.\-\(\)\s]+/g, "_");
}

// S3 저장소 설정
const uploadMiddleware = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: "bw-files",
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: function (req, file, cb) {
      const originalFilename = file.originalname;
      const sanitizedFilename = sanitizeFilename(originalFilename);
      const uniqueSuffix = Date.now() + "_" + Math.round(Math.random() * 1e16);
      cb(null, uniqueSuffix + "_" + sanitizedFilename);
    },
  }),
  limits: {
    fileSize: 50 * 1024 * 1024, // 최대 50MB
  },
});

// 에러 핸들러 미들웨어
const errorHandler = (error, req, res, next) => {
  console.error("File upload error:", {
    error: error.message,
    stack: error.stack,
    file: req.file,
  });

  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case "LIMIT_FILE_SIZE":
        return res.status(413).json({
          success: false,
          message: "파일 크기는 50MB를 초과할 수 없습니다.",
        });
      case "LIMIT_FILE_COUNT":
        return res.status(400).json({
          success: false,
          message: "한 번에 하나의 파일만 업로드할 수 있습니다.",
        });
      case "LIMIT_UNEXPECTED_FILE":
        return res.status(400).json({
          success: false,
          message: "잘못된 형식의 파일입니다.",
        });
      default:
        return res.status(400).json({
          success: false,
          message: `파일 업로드 오류: ${error.message}`,
        });
    }
  }

  if (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "파일 업로드 중 오류가 발생했습니다.",
    });
  }

  next();
};

module.exports = {
  upload: uploadMiddleware,
  s3Client,
  errorHandler,
  ALLOWED_TYPES,
};
