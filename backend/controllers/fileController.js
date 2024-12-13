const File = require("../models/File");
const Message = require("../models/Message");
const Room = require("../models/Room");
const {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { processFileForRAG } = require("../services/fileService");

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const getFileFromRequest = async (req) => {
  const filename = req.params.filename;
  const token = req.headers["x-auth-token"] || req.query.token;
  const sessionId = req.headers["x-session-id"] || req.query.sessionId;

  if (!filename) {
    throw new Error("Invalid filename");
  }

  if (!token || !sessionId) {
    throw new Error("Authentication required");
  }

  const file = await File.findOne({ filename: filename });
  if (!file) {
    throw new Error("File not found in database");
  }

  // 권한 확인을 위해 관련 메시지와 룸 조회
  const message = await Message.findOne({ file: file._id });
  if (!message) {
    throw new Error("File message not found");
  }

  const room = await Room.findOne({
    _id: message.room,
    participants: req.user.id,
  });

  if (!room) {
    throw new Error("Unauthorized access");
  }

  // S3 객체 존재 확인
  try {
    await s3Client.send(
      new HeadObjectCommand({ Bucket: "bw-files", Key: file.filename })
    );
  } catch (err) {
    if (err.name === "NotFound") {
      throw new Error("File not found in database");
    } else {
      throw err;
    }
  }

  return { file };
};

exports.uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "파일이 선택되지 않았습니다.",
      });
    }

    const file = new File({
      filename: req.file.key,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      user: req.user.id,
      path: req.file.location,
    });

    await file.save();

    res.status(200).json({
      success: true,
      message: "파일 업로드 성공",
      file: {
        _id: file._id,
        filename: file.filename,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        uploadDate: file.uploadDate,
        url: file.path,
      },
    });
  } catch (error) {
    console.error("File upload error:", error);
    res.status(500).json({
      success: false,
      message: "파일 업로드 중 오류가 발생했습니다.",
      error: error.message,
    });
  }
};

exports.downloadFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);
    const contentDisposition = file.getContentDisposition("attachment");

    const command = new GetObjectCommand({
      Bucket: "bw-files",
      Key: file.filename,
    });
    const s3Response = await s3Client.send(command);

    res.set({
      "Content-Type": file.mimetype,
      "Content-Length": file.size,
      "Content-Disposition": contentDisposition,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });

    s3Response.Body.on("error", (error) => {
      console.error("File streaming error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: "파일 스트리밍 중 오류가 발생했습니다.",
        });
      }
    });

    s3Response.Body.pipe(res);
  } catch (error) {
    handleFileError(error, res);
  }
};

exports.viewFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);

    if (!file.isPreviewable()) {
      return res.status(415).json({
        success: false,
        message: "미리보기를 지원하지 않는 파일 형식입니다.",
      });
    }

    const contentDisposition = file.getContentDisposition("inline");

    const command = new GetObjectCommand({
      Bucket: "bw-files",
      Key: file.filename,
    });
    const s3Response = await s3Client.send(command);

    res.set({
      "Content-Type": file.mimetype,
      "Content-Disposition": contentDisposition,
      "Content-Length": file.size,
      "Cache-Control": "public, max-age=31536000, immutable",
    });

    s3Response.Body.on("error", (error) => {
      console.error("File streaming error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: "파일 스트리밍 중 오류가 발생했습니다.",
        });
      }
    });

    s3Response.Body.pipe(res);
  } catch (error) {
    handleFileError(error, res);
  }
};

exports.deleteFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({
        success: false,
        message: "파일을 찾을 수 없습니다.",
      });
    }

    if (file.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "파일을 삭제할 권한이 없습니다.",
      });
    }

    const command = new DeleteObjectCommand({
      Bucket: "bw-files",
      Key: file.filename,
    });
    try {
      await s3Client.send(command);
    } catch (error) {
      console.error("File deletion (S3) error:", error);
    }

    await file.deleteOne();

    res.json({
      success: true,
      message: "파일이 삭제되었습니다.",
    });
  } catch (error) {
    console.error("File deletion error:", error);
    res.status(500).json({
      success: false,
      message: "파일 삭제 중 오류가 발생했습니다.",
      error: error.message,
    });
  }
};

const handleFileError = (error, res) => {
  console.error("File operation error:", {
    message: error.message,
    stack: error.stack,
  });

  const errorResponses = {
    "Invalid filename": { status: 400, message: "잘못된 파일명입니다." },
    "Authentication required": { status: 401, message: "인증이 필요합니다." },
    "File not found in database": {
      status: 404,
      message: "파일을 찾을 수 없습니다.",
    },
    "File message not found": {
      status: 404,
      message: "파일 메시지를 찾을 수 없습니다.",
    },
    "Unauthorized access": {
      status: 403,
      message: "파일에 접근할 권한이 없습니다.",
    },
    ENOENT: { status: 404, message: "파일을 찾을 수 없습니다." },
  };

  const errorResponse = errorResponses[error.message] || {
    status: 500,
    message: "파일 처리 중 오류가 발생했습니다.",
  };

  res.status(errorResponse.status).json({
    success: false,
    message: errorResponse.message,
  });
};
