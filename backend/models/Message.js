const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  room: { 
    type: String, 
    required: [true, '채팅방 ID는 필수입니다.']
  },
  content: { 
    type: String,
    required: function() {
      return this.type !== 'file';
    },
    trim: true,
    maxlength: [10000, '메시지는 10000자를 초과할 수 없습니다.']
  },
  sender: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User'
  },
  type: { 
    type: String, 
    enum: ['text', 'system', 'ai', 'file'], 
    default: 'text'
  },
  file: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File',
    required: function() {
      return this.type === 'file';
    }
  },
  aiType: {
    type: String,
    enum: ['wayneAI', 'consultingAI'],
    required: function() { 
      return this.type === 'ai'; 
    }
  },
  mentions: [{ 
    type: String,
    trim: true
  }],
  timestamp: { 
    type: Date, 
    default: Date.now
  },
  readers: [{
    userId: { 
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    readAt: { 
      type: Date,
      default: Date.now,
      required: true
    }
  }],
  reactions: {
    type: Map,
    of: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    default: new Map()
  },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  isDeleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true,
  toJSON: { 
    virtuals: true,
    getters: true 
  },
  toObject: { 
    virtuals: true,
    getters: true 
  }
});

// 최적화된 복합 인덱스
MessageSchema.index({ room: 1, timestamp: -1, isDeleted: 1 }, { 
  name: 'optimal_room_messages',
  background: true
});

MessageSchema.index({ room: 1, type: 1, timestamp: -1 }, { 
  name: 'room_type_messages',
  background: true
});

MessageSchema.index({ sender: 1, room: 1, timestamp: -1 }, { 
  name: 'user_room_messages',
  background: true
});

MessageSchema.index({ room: 1, 'readers.userId': 1, timestamp: -1 }, { 
  name: 'room_readers',
  background: true,
  sparse: true
});

MessageSchema.index({ 'mentions': 1, room: 1, timestamp: -1 }, { 
  name: 'mentions_room',
  background: true,
  sparse: true
});

// 쿼리 플랜 분석 메서드
MessageSchema.statics.analyzeQueryPlan = async function(roomId, options = {}) {
  const queries = {
    basicRoomQuery: this.find({
      room: roomId,
      isDeleted: false
    }).explain('executionStats'),

    timeRangeQuery: this.find({
      room: roomId,
      isDeleted: false,
      timestamp: { $lt: new Date() }
    }).explain('executionStats'),

    fullQuery: this.find({
      room: roomId,
      isDeleted: false,
      timestamp: { $lt: new Date() }
    })
    .select('content type sender timestamp file aiType')
    .sort({ timestamp: -1 })
    .limit(30)
    .explain('executionStats'),

    readerQuery: this.find({
      room: roomId,
      'readers.userId': options.userId
    }).explain('executionStats')
  };

  const plans = {};
  for (const [name, query] of Object.entries(queries)) {
    plans[name] = await query;
  }

  return {
    plans,
    analysis: this.analyzePlans(plans)
  };
};

MessageSchema.statics.analyzePlans = function(plans) {
  const analysis = {
    recommendations: [],
    indexSuggestions: []
  };

  for (const [queryName, plan] of Object.entries(plans)) {
    const stats = plan.executionStats;
    
    const scanRatio = stats.totalDocsExamined / stats.nReturned;
    if (scanRatio > 2) {
      analysis.recommendations.push({
        query: queryName,
        issue: 'High scan ratio',
        ratio: scanRatio,
        suggestion: 'Consider adding or reviewing indexes for this query pattern'
      });
    }

    if (stats.executionTimeMillis > 100) {
      analysis.recommendations.push({
        query: queryName,
        issue: 'Slow execution',
        time: stats.executionTimeMillis,
        suggestion: 'Query optimization needed'
      });
    }

    const stage = plan.queryPlanner.winningPlan.inputStage;
    if (stage.stage === 'COLLSCAN') {
      analysis.indexSuggestions.push({
        query: queryName,
        suggestion: 'Create index for frequently used fields'
      });
    }
  }

  return analysis;
};

// 최적화된 쿼리 메서드
MessageSchema.statics.findRoomMessages = function(roomId, before, limit = 30) {
  const query = {
    room: roomId,
    isDeleted: false,
    ...(before && { timestamp: { $lt: new Date(Number(before)) } })
  };

  return this.find(query)
    .select('content type sender timestamp file aiType reactions readers')
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean()
    .hint('optimal_room_messages');
};

// 읽음 처리 최적화
MessageSchema.statics.markAsRead = async function(messageIds, userId) {
  if (!messageIds?.length || !userId) return;

  const bulkOps = messageIds.map(messageId => ({
    updateOne: {
      filter: {
        _id: messageId,
        isDeleted: false,
        'readers.userId': { $ne: userId }
      },
      update: {
        $push: {
          readers: {
            userId: new mongoose.Types.ObjectId(userId),
            readAt: new Date()
          }
        }
      }
    }
  }));

  try {
    const result = await this.bulkWrite(bulkOps, { 
      ordered: false,
      w: 1
    });
    return result.modifiedCount;
  } catch (error) {
    console.error('Mark as read error:', error);
    throw error;
  }
};

// 리액션 처리 최적화
MessageSchema.methods.addReaction = async function(emoji, userId) {
  try {
    const result = await this.constructor.findOneAndUpdate(
      { 
        _id: this._id,
        [`reactions.${emoji}`]: { $ne: userId }
      },
      { 
        $push: { [`reactions.${emoji}`]: userId }
      },
      { new: true, select: 'reactions' }
    );
    
    return result?.reactions?.get(emoji) || [];
  } catch (error) {
    console.error('Add reaction error:', error);
    throw error;
  }
};

MessageSchema.methods.removeReaction = async function(emoji, userId) {
  try {
    const result = await this.constructor.findOneAndUpdate(
      { _id: this._id },
      { 
        $pull: { [`reactions.${emoji}`]: userId }
      },
      { new: true, select: 'reactions' }
    );

    if (result?.reactions?.get(emoji)?.length === 0) {
      await this.constructor.updateOne(
        { _id: this._id },
        { $unset: { [`reactions.${emoji}`]: "" } }
      );
    }

    return result?.reactions?.get(emoji) || [];
  } catch (error) {
    console.error('Remove reaction error:', error);
    throw error;
  }
};

// 소프트 삭제 최적화
MessageSchema.methods.softDelete = async function() {
  return this.constructor.updateOne(
    { _id: this._id },
    { $set: { isDeleted: true } }
  );
};

// 훅 최적화
MessageSchema.pre('save', function(next) {
  if (this.content && this.type !== 'file') {
    this.content = this.content.trim();
  }
  if (this.mentions?.length) {
    this.mentions = [...new Set(this.mentions)];
  }
  next();
});

MessageSchema.pre('remove', async function(next) {
  try {
    if (this.type === 'file' && this.file) {
      await mongoose.model('File').findByIdAndDelete(this.file);
    }
    next();
  } catch (error) {
    next(error);
  }
});

// JSON 변환 최적화
MessageSchema.methods.toJSON = function() {
  const obj = this.toObject();
  
  delete obj.__v;
  delete obj.updatedAt;
  delete obj.isDeleted;
  
  if (obj.reactions) {
    obj.reactions = Object.fromEntries(obj.reactions);
  }

  return obj;
};

// 개발 환경에서 쿼리 플랜 모니터링
if (process.env.NODE_ENV === 'development') {
  MessageSchema.post('find', function(docs, next) {
    if (this._explain) {
      console.log('Query Plan:', JSON.stringify(this.explain('executionStats')));
    }
    next();
  });
}

const Message = mongoose.model('Message', MessageSchema);

// 인덱스 생성 모니터링
Message.on('index', error => {
  if (error) {
    console.error('Message 인덱스 생성 실패:', error);
  } else {
    console.log('Message 인덱스 생성 완료');
  }
});

module.exports = Message;