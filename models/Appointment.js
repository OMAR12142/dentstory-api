const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema(
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

    // ── Scheduling ────────────────────────────────
    date: {
      type: Date,
      required: [true, 'Appointment date is required'],
    },
    startTime: {
      type: String,
      required: [true, 'Start time is required'],
      trim: true,
    },
    endTime: {
      type: String,
      required: [true, 'End time is required'],
      trim: true,
    },

    // ── Classification ────────────────────────────
    type: {
      type: String,
      enum: ['consultation', 'follow-up', 'procedure', 'emergency', 'other'],
      default: 'consultation',
    },
    status: {
      type: String,
      enum: ['scheduled', 'confirmed', 'completed', 'cancelled', 'no-show'],
      default: 'scheduled',
    },

    // ── Metadata ──────────────────────────────────
    notes: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { timestamps: true }
);

// ── Performance Indexes ───────────────────────
// Calendar range queries (get all appointments for a month/week)
appointmentSchema.index({ dentist_id: 1, date: 1 });

// Conflict detection (same dentist + clinic + day)
appointmentSchema.index({ dentist_id: 1, clinic_id: 1, date: 1 });

// Patient upcoming appointments
appointmentSchema.index({ patient_id: 1, date: -1 });

// Status-based filtering
appointmentSchema.index({ dentist_id: 1, status: 1 });

module.exports = mongoose.model('Appointment', appointmentSchema);
