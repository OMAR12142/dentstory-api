const mongoose = require('mongoose');

/**
 * Portfolio — Public‑facing dentist showcase page.
 *
 * Each dentist has at most one portfolio (1:1 via unique dentist_id).
 * The slug is auto‑generated from the dentist's name and must be globally unique.
 * Published cases reference existing Sessions but expose NO patient PII publicly.
 */

const publishedCaseSchema = new mongoose.Schema(
  {
    session_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Case title is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    category: {
      type: String,
      trim: true,
      default: '',
    },
    treatmentType: {
      type: String,
      trim: true,
      default: 'General',
    },
    // Which media_urls from the session to display (indexes or full URLs)
    selectedImages: {
      type: [String],
      default: [],
    },
    coverImage: {
      type: String,
      default: '',
    },
    publishedAt: {
      type: Date,
      default: Date.now,
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  { _id: true }
);

const portfolioSchema = new mongoose.Schema(
  {
    dentist_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dentist',
      required: true,
      unique: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // ── Profile Section ──────────────────────────
    bio: {
      type: String,
      trim: true,
      default: '',
    },
    yearsOfExperience: {
      type: Number,
      default: 0,
      min: 0,
    },
    services: {
      type: [String],
      default: [],
    },

    // ── Contact Section ──────────────────────────
    contactEmail: {
      type: String,
      trim: true,
      default: '',
    },
    contactPhone: {
      type: String,
      trim: true,
      default: '',
    },
    clinicName: {
      type: String,
      trim: true,
      default: '',
    },
    clinicAddress: {
      type: String,
      trim: true,
      default: '',
    },

    // ── Published Cases ──────────────────────────
    publishedCases: [publishedCaseSchema],

    // ── Master toggle ────────────────────────────
    isPublished: {
      type: Boolean,
      default: false,
    },
    // ── Admin toggle ──────────────────────────────
    isSuspended: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Portfolio', portfolioSchema);
