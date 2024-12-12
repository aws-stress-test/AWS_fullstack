const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const RoomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  hasPassword: {
    type: Boolean,
    default: false
  },
  password: {
    type: String,
    select: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }]
});

// 비밀번호 해싱 미들웨어
RoomSchema.pre('save', async function(next) {
  if (this.isModified('password') && this.password) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    this.hasPassword = true;
  }
  if (!this.password) {
    this.hasPassword = false;
  }
  next();
});

// 비밀번호 확인 메서드
RoomSchema.methods.checkPassword = async function(password) {
  if (!this.hasPassword) return true;
  const room = await this.constructor.findById(this._id).select('+password');
  return await bcrypt.compare(password, room.password);
};

RoomSchema.index({ name: 1, createdAt: -1 });  // 방 검색 최적화
RoomSchema.index({ creator: 1 });              // 생성자 기준 검색 최적화
RoomSchema.index({ participants: 1 });         // 참여자 검색 최적화
RoomSchema.index({ 'messages.sender': 1 });    // 메시지 발신자 검색 최적화
RoomSchema.index({ updatedAt: -1 });          // 최근 업데이트 순 정렬 최적화

module.exports = mongoose.model('Room', RoomSchema);