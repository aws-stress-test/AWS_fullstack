const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { S3Client } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');

// S3 클라이언트 설정 캐싱
let s3ClientInstance = null;

// AWS S3 초기화 (성능 최적화를 위한 싱글톤 패턴)
const initializeS3Client = () => {
  if (s3ClientInstance) {
    return s3ClientInstance;
  }

  const config = {
    region: process.env.AWS_REGION || 'ap-northeast-2',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    maxAttempts: 3,
    retryMode: 'adaptive'
  };

  s3ClientInstance = new S3Client(config);
  return s3ClientInstance;
};

// MIME 타입과 확장자 매핑
const ALLOWED_TYPES = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
  'video/quicktime': ['.mov'],
  'audio/mpeg': ['.mp3'],
  'audio/wav': ['.wav'],
  'audio/ogg': ['.ogg'],
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
};

// 파일 타입별 크기 제한 설정
const FILE_SIZE_LIMITS = {
  image: 10 * 1024 * 1024,  // 10MB
  video: 50 * 1024 * 1024,  // 50MB
  audio: 20 * 1024 * 1024,  // 20MB
  document: 20 * 1024 * 1024 // 20MB
};

// 타입 매핑 캐싱 (성능 최적화)
const TYPE_MAP = {
  'image': '이미지',
  'video': '동영상',
  'audio': '오디오',
  'application': '문서'
};

const getFileType = (mimetype) => {
  const type = mimetype.split('/')[0];
  return TYPE_MAP[type] || '파일';
};

// 최대 파일 크기 캐싱 (성능 최적화)
const MAX_FILE_SIZE = Math.max(...Object.values(FILE_SIZE_LIMITS));

// 정규식 패턴 캐싱 (성능 최적화)
const FILENAME_SANITIZE_PATTERN = /[^a-zA-Z0-9_-]/g;
const CONSECUTIVE_UNDERSCORE_PATTERN = /_+/g;
const TRIM_SPECIAL_CHARS_PATTERN = /^[._-]+|[._-]+$/g;

const sanitizeFilename = (filename) => {
  try {
    const ext = path.extname(filename);
    const name = path.basename(filename, ext);

    const sanitized = name
      .replace(FILENAME_SANITIZE_PATTERN, '_')
      .replace(CONSECUTIVE_UNDERSCORE_PATTERN, '_')
      .replace(TRIM_SPECIAL_CHARS_PATTERN, '')
      .substring(0, 200);

    return `${sanitized}${ext.toLowerCase()}`;
  } catch (error) {
    console.error('Filename sanitization error:', error);
    return `${Date.now()}_file${path.extname(filename).toLowerCase()}`;
  }
};

// 스토리지 설정
const storage = multerS3({
  s3: initializeS3Client(),
  bucket: process.env.AWS_BUCKET_NAME || 'bw-files',
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: (req, file, cb) => {
    // 성능 최적화: Buffer 크기 축소 및 암호화 알고리즘 최적화
    const uniqueSuffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const sanitizedName = sanitizeFilename(file.originalname);
    cb(null, `uploads/${uniqueSuffix}_${sanitizedName}`);
  },
  metadata: (req, file, cb) => {
    cb(null, { 
      fieldName: file.fieldname,
      originalName: sanitizeFilename(file.originalname)
    });
  }
});

// 파일 필터 최적화 (early return 패턴 적용)
const fileFilter = (req, file, cb) => {
  // MIME 타입 검증
  if (!ALLOWED_TYPES.hasOwnProperty(file.mimetype)) {
    const error = new Error('지원하지 않는 파일 형식입니다.');
    error.code = 'UNSUPPORTED_FILE_TYPE';
    return cb(error, false);
  }

  // 파일 크기 검증
  const contentLength = parseInt(req.headers['content-length']);
  const fileType = file.mimetype.split('/')[0];
  const sizeLimit = FILE_SIZE_LIMITS[fileType] || FILE_SIZE_LIMITS.document;
  
  if (contentLength > sizeLimit) {
    const error = new Error(`파일 크기는 ${sizeLimit / (1024 * 1024)}MB를 초과할 수 없습니다.`);
    error.code = 'LIMIT_FILE_SIZE';
    return cb(error, false);
  }

  cb(null, true);
};

// 에러 메시지 캐싱 (성능 최적화)
const ERROR_MESSAGES = {
  LIMIT_FILE_SIZE: '파일 크기가 제한을 초과했습니다.',
  LIMIT_FILE_COUNT: '한 번에 하나의 파일만 업로드할 수 있습니다.',
  LIMIT_UNEXPECTED_FILE: '잘못된 형식의 파일입니다.'
};

// Multer 설정 최적화
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  }
});

// 에러 핸들러 최적화
const errorHandler = (error, req, res, next) => {
  console.error('File upload error:', {
    message: error.message,
    code: error.code,
    filename: req.file?.originalname
  });

  // S3 업로드와 로컬 파일 모두 고려한 파일 정리
  if (req.file) {
    try {
      // 로컬 파일인 경우
      if (req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      // S3에 업로드된 파일인 경우는 자동으로 정리됨
    } catch (unlinkError) {
      console.error('Failed to delete uploaded file:', unlinkError);
    }
  }

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: ERROR_MESSAGES[error.code] || `파일 업로드 오류: ${error.message}`
    });
  }

  if (error.code === 'UNSUPPORTED_FILE_TYPE') {
    return res.status(400).json({
      success: false,
      message: error.message,
      allowedTypes: Object.keys(ALLOWED_TYPES)
    });
  }
  
  return res.status(500).json({
    success: false,
    message: '파일 업로드 중 오류가 발생했습니다.'
  });
};

module.exports = {
  upload,
  errorHandler,
  ALLOWED_TYPES,
  getFileType,
  sanitizeFilename
};