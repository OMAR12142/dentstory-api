const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    dentist_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dentist',
      required: true,
    },
    patient_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
    },
    clinic_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    treatment_details: {
      type: String,
      trim: true,
    },
    media_urls: {
      type: [String],
      default: [],
    },
    total_cost: {
      type: Number,
      default: 0,
      min: 0,
    },
    amount_paid: {
      type: Number,
      default: 0,
      min: 0,
    },
    remaining_balance: {
      type: Number,
      default: 0,
      min: 0,
    },
    dentist_cut: {
      type: Number,
      default: 0,
      min: 0,
    },
    next_appointment: {
      type: Date,
    },
    treatment_category: {
      type: [String],
      default: [],
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

// ── Auto-calculate remaining_balance on save ──
sessionSchema.pre('save', function (next) {
  this.remaining_balance = this.total_cost - this.amount_paid;
  next();
});

// ── Performance Indexes ───────────────────────
// Optimizes dashboard analytics and trend charts
sessionSchema.index({ dentist_id: 1, date: -1 });

// Optimizes patient treatment timeline
sessionSchema.index({ patient_id: 1, date: -1 });

// Optimizes clinic-specific stats
sessionSchema.index({ clinic_id: 1 });

module.exports = mongoose.model('Session', sessionSchema);
