const mongoose = require('mongoose');

const clinicSchema = new mongoose.Schema(
  {
    dentist_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dentist',
      required: true,
    },
    name: {
      type: String,
      required: [true, 'Clinic name is required'],
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    default_commission_percentage: {
      type: Number,
      required: [true, 'Commission percentage is required'],
      min: 0,
      max: 100,
    },
    working_days: [
      {
        day: {
          type: String,
          enum: ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
          required: true,
        },
        start_time: {
          type: String,
          required: true,
        },
        end_time: {
          type: String,
          required: true,
        },
      },
    ],
  },
  { timestamps: true }
);

// ── Performance Indexes ───────────────────────
clinicSchema.index({ dentist_id: 1 });

module.exports = mongoose.model('Clinic', clinicSchema);
