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
      required: [true, 'Total cost is required'],
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
      type: String,
      enum: [
        /* New Categories */
        'Surgery', 'Implant', 'Endo', 'Perio', 'Fixed', 'Removable', 'Restorative',
        /* Legacy Categories - Kept for backwards compatibility */
        'Endodontics', 'Prosthodontics', 'Orthodontics', 'Pedodontics', 'Cosmetic', 'General', 'Other'
      ],
      required: [true, 'Treatment category is required'],
      default: 'General',
    },
  },
  { timestamps: true }
);

// ── Auto-calculate remaining_balance on save ──
sessionSchema.pre('save', function (next) {
  this.remaining_balance = this.total_cost - this.amount_paid;
  next();
});

module.exports = mongoose.model('Session', sessionSchema);
