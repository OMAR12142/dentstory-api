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
  },
  { timestamps: true }
);

module.exports = mongoose.model('Patient', patientSchema);

