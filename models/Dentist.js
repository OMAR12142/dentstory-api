const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const dentistSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: function () {
        return this.authProvider === 'local';
      },
      minlength: 6,
      select: false,
    },
    authProvider: {
      type: String,
      enum: ['local', 'google'],
      default: 'local',
    },
    phone: {
      type: String,
      trim: true,
    },
    // ── Role-Based Access Control ────────────────
    role: {
      type: String,
      enum: ['dentist', 'admin'],
      default: 'dentist',
    },
    // ── Saved Insurance Providers ────────────────
    insuranceProviders: {
      type: [String],
      default: ['Private'],
    },
    // ── Profile Photo (Cloudinary) ──────────────
    profilePhoto: {
      url: { type: String, default: '' },
      publicId: { type: String, default: '' },
    },
    // ── Account Status (Kill Switch) ────────────
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
    },
  },
  { timestamps: true }
);

// ── Hash password before saving ───────────────
dentistSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ── Compare plain-text against hashed password ─
dentistSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('Dentist', dentistSchema);
