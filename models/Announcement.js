const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  content: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['banner', 'modal'],
    default: 'banner'
  },
  displayFrequency: {
    type: String,
    enum: ['once', 'session', 'always'],
    default: 'session' // Default is per login session
  },
  severity: {
    type: String,
    enum: ['info', 'success', 'warning', 'error'],
    default: 'info'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Dentist', // Assuming Admin is a Dentist with isAdmin: true
    required: true
  },
  expiresAt: {
    type: Date
  }
}, { timestamps: true });

module.exports = mongoose.model('Announcement', announcementSchema);
