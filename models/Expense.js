const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema(
  {
    dentist_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dentist',
      required: true,
    },
    clinic_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
    },
    category: {
      type: String,
      required: true,
      enum: ['Material', 'Salaries', 'Lab', 'Other'],
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    date: {
      type: Date,
      default: Date.now,
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
expenseSchema.index({ dentist_id: 1, date: -1 });
expenseSchema.index({ dentist_id: 1, clinic_id: 1, date: -1 });

module.exports = mongoose.model('Expense', expenseSchema);
