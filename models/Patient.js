const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema(
  {
    dentist_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dentist',
      required: true,
    },
    name: {
      type: String,
      required: [true, 'Patient name is required'],
      trim: true,
    },
    age: {
      type: Number,
      min: 0,
    },
    dateOfBirth: {
      type: Date,
    },
    phone: {
      type: String,
      trim: true,
    },
    phone2: {
      type: String,
      trim: true,
      default: '',
    },
    medical_history: {
      type: [String],
      default: [],
    },
    // ── Treatment Plan ────────────────────────
    treatment_plan: [
      {
        text: { type: String, required: true },
        isCompleted: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now },
      }
    ],
    address: {
      type: String,
      trim: true,
    },
    job: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['Active', 'On-Hold', 'Completed', 'Dropped'],
      default: 'Active',
    },
    // ── Insurance classification ─────────────────
    insuranceCompany: {
      type: String,
      trim: true,
      default: 'Private', // 'Private' = self-pay, otherwise the insurer name
    },
    // ── Clinic assignment & commission override ──
    clinic_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      default: null, // optional — legacy patients without a clinic are OK
    },
    commission_percentage: {
      type: Number,
      min: 0,
      max: 100,
      default: null, // null until a clinic is chosen; then copied from clinic default
    },
    // ── Clinical Notes ────────────────────────
    notes: [
      {
        text: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
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
// Optimizes newest-patient-first list retrieval
patientSchema.index({ dentist_id: 1, createdAt: -1 });

// Optimizes filtering by status (Active, On-Hold, etc.)
patientSchema.index({ dentist_id: 1, status: 1 });

// Optimizes clinic-based patient grouping
patientSchema.index({ dentist_id: 1, clinic_id: 1 });

module.exports = mongoose.model('Patient', patientSchema);

