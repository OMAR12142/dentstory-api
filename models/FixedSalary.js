const mongoose = require('mongoose');

const fixedSalarySchema = new mongoose.Schema(
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
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    salary_day: {
      type: Number,
      required: true,
      min: 1,
      max: 28,
    },
  },
  {
    timestamps: true,
  }
);

// Ensure one clinic can only have one fixed salary record per dentist
fixedSalarySchema.index({ dentist_id: 1, clinic_id: 1 }, { unique: true });

const FixedSalary = mongoose.model('FixedSalary', fixedSalarySchema);

module.exports = FixedSalary;
