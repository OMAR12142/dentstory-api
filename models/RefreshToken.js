const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema({
  dentistId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Dentist',
    required: true,
  },
  token: {
    type: String,
    required: true,
    index: true,
    unique: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  userAgent: {
    type: String,
  },
  ip: {
    type: String,
  },
}, { timestamps: true });

// TTL index to automatically remove expired tokens
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
