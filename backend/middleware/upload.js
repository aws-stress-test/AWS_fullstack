// backend/middleware/upload.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AWS = require('aws-sdk');
const multerS3 = require('multer-s3');
const { S3Client } = require('@aws-sdk/client-s3');

// AWS S3 설정
const s3Client = new S3Client({
  region: "ap-northeast-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
}); 

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
  image: 10 * 1024 * 1024,  // 10MB for images
  video: 50 * 1024 * 1024,  // 50MB for videos
  audio: 20 * 1024 * 1024,  // 20MB for audio
  document: 20 * 1024 * 1024 // 20MB for documents
};

const getFileType = (mimetype) => {
  const typeMap = {
    'image': '이미지',
    'video': '동영상',
    'audio': '오디오',
    'application': '문서'
  };
  const type = mimetype.split('/')[0];
  return typeMap[type] || '파일';
};

// S3 저장소 설정
const uploadMiddleware = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: 'bw-files',
    key: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '_' + Math.round(Math.random() * 1E16);
      cb(null, uniqueSuffix + '_' + file.originalname);
    }
  })
});

// 에러 핸들러 미들웨어
const errorHandler = (error, req, res, next) => {
  console.error('File upload error:', {
    error: error.message,
    stack: error.stack,
    file: req.file
  });

  // 업로드된 파일이 있다면 삭제
  if (req.file) {
    try {
      fs.unlinkSync(req.file.path);
    } catch (unlinkError) {
      console.error('Failed to delete uploaded file:', unlinkError);
    }
  }

  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return res.status(413).json({
          success: false,
          message: '파일 크기는 50MB를 초과할 수 없습니다.'
        });
      case 'LIMIT_FILE_COUNT':
        return res.status(400).json({
          success: false,
          message: '한 번에 하나의 파일만 업로드할 수 있습니다.'
        });
      case 'LIMIT_UNEXPECTED_FILE':
        return res.status(400).json({
          success: false,
          message: '잘못된 형식의 파일입니다.'
        });
      default:
        return res.status(400).json({
          success: false,
          message: `파일 업로드 오류: ${error.message}`
        });
    }
  }
  
  if (error) {
    return res.status(400).json({
      success: false,
      message: error.message || '파일 업로드 중 오류가 발생했습니다.'
    });
  }
  
  next();
};

module.exports = {
  upload: uploadMiddleware,
  s3Client,
  errorHandler,
  ALLOWED_TYPES,
  getFileType
};