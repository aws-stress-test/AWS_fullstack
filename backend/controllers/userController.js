const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { upload, s3Client } = require('../middleware/upload');
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs').promises;

// 회원가입
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 입력값 검증
    const validationErrors = [];
    
    if (!name || name.trim().length === 0) {
      validationErrors.push({
        field: 'name',
        message: '이름을 입력해주세요.'
      });
    } else if (name.length < 2) {
      validationErrors.push({
        field: 'name',
        message: '이름은 2자 이상이어야 합니다.'
      });
    }

    if (!email) {
      validationErrors.push({
        field: 'email',
        message: '이메일을 입력해주세요.'
      });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      validationErrors.push({
        field: 'email',
        message: '올바른 이메일 형식이 아닙니다.'
      });
    }

    if (!password) {
      validationErrors.push({
        field: 'password',
        message: '비밀번호를 입력해주세요.'
      });
    } else if (password.length < 6) {
      validationErrors.push({
        field: 'password',
        message: '비밀번호는 6자 이상이어야 합니다.'
      });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: validationErrors
      });
    }

    // 사용자 중복 확인
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: '이미 가입된 이메일입니다.'
      });
    }

    // 비밀번호 암호화 및 사용자 생성
    const newUser = new User({ 
      name, 
      email, 
      password,
      profileImage: '' // 기본 프로필 이미지 없음
    });

    const salt = await bcrypt.genSalt(10);
    newUser.password = await bcrypt.hash(password, salt);
    await newUser.save();

    res.status(201).json({
      success: true,
      message: '회원가입이 완료되었습니다.',
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        profileImage: newUser.profileImage
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: '회원가입 처리 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 조회
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 조회 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 업데이트
exports.updateProfile = async (req, res) => {
  try {
    const { name, currentPassword, newPassword } = req.body;
    
    // 비밀번호 변경 요청인 경우
    if (currentPassword && newPassword) {
      const user = await User.findById(req.user.id).select('+password');
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: '사용자를 찾을 수 없습니다.'
        });
      }

      try {
        // User 모델의 changePassword 메서드 사용
        await user.changePassword(currentPassword, newPassword);
        
        if (name) {
          user.name = name;
          await user.save();
        }

        return res.json({
          success: true,
          message: '비밀번호가 변경되었습니다.'
        });
      } catch (error) {
        return res.status(401).json({
          success: false,
          message: error.message
        });
      }
    }

    // 이름 변경 요청인 경우 (기존 코드 유지)
    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: '이름을 입력해주세요.'
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    user.name = name.trim();
    await user.save();

    res.json({
      success: true,
      message: '프로필이 업데이트되었습니다.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 업데이트 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 이미지 업로드
exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '이미지가 제공되지 않았습니다.'
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 기존 프로필 이미지 삭제 (S3에서 삭제)
    if (user.profileImage) {
      const oldImageKey = user.profileImage.split('/').slice(-1)[0];
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: 'bw-files',
          Key: oldImageKey
        }));
      } catch (error) {
        console.error('Failed to delete old profile image from S3:', error);
      }
    }

    // 새 이미지 URL 저장
    user.profileImage = req.file.location; // S3 URL
    await user.save();

    res.json({
      success: true,
      message: '프로필 이미지가 업데이트되었습니다.',
      imageUrl: user.profileImage
    });
  } catch (error) {
    console.error('Profile image upload error:', error);
    res.status(500).json({
      success: false,
      message: '이미지 업로드 중 오류가 발생했습니다.'
    });
  }
};


// 프로필 이미지 삭제
exports.deleteProfileImage = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    if (user.profileImage) {
      const imagePath = path.join(__dirname, '..', user.profileImage);
      try {
        await fs.access(imagePath);
        await fs.unlink(imagePath);
      } catch (error) {
        console.error('Profile image delete error:', error);
      }

      user.profileImage = '';
      await user.save();
    }

    res.json({
      success: true,
      message: '프로필 이미지가 삭제되었습니다.'
    });

  } catch (error) {
    console.error('Delete profile image error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 이미지 삭제 중 오류가 발생했습니다.'
    });
  }
};

// 회원 탈퇴
exports.deleteAccount = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 프로필 이미지가 있다면 삭제
    if (user.profileImage) {
      const imagePath = path.join(__dirname, '..', user.profileImage);
      try {
        await fs.access(imagePath);
        await fs.unlink(imagePath);
      } catch (error) {
        console.error('Profile image delete error:', error);
      }
    }

    await user.deleteOne();

    res.json({
      success: true,
      message: '회원 탈퇴가 완료되었습니다.'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: '회원 탈퇴 처리 중 오류가 발생했습니다.'
    });
  }
};

module.exports = exports;