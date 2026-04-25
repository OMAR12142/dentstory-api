const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema(
  {
    dentist_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dentist',
      required: [true, 'Dentist ID is required'],
    },
    clinic_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      default: null,
    },
    patient_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      default: null,
    },
    text: {
      type: String,
      required: [true, 'Task text is required'],
      trim: true,
    },
    type: {
      type: String,
      enum: ['General', 'Lab_Work', 'Follow_Up', 'Financial'],
      default: 'General',
    },
    isCompleted: {
      type: Boolean,
      default: false,
    },
    dueDate: {
      type: Date,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// ── Performance Indexes ───────────────────────
// Optimizes filtering of active vs completed tasks
taskSchema.index({ dentist_id: 1, isCompleted: 1 });

module.exports = mongoose.model('Task', taskSchema);
