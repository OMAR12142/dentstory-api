const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Dentist = require('../models/Dentist');
const Patient = require('../models/Patient');
const Session = require('../models/Session');
const Clinic = require('../models/Clinic');
const Portfolio = require('../models/Portfolio');
const RefreshToken = require('../models/RefreshToken');
const jwt = require('jsonwebtoken');

// ── Auth Helpers (Mirroring authController) ──────────
const generateAccessToken = (id, role) =>
  jwt.sign({ id, role }, process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '30d',
  });

const generateRefreshToken = (id, role) =>
  jwt.sign({ id, role }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
  });

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

// ─────────────────────────────────────────────────────────────
// @desc    Get high-level platform statistics for the Super Admin
// @route   GET /api/admin/stats
// @access  Private / Admin
// ─────────────────────────────────────────────────────────────
const getPlatformStats = asyncHandler(async (_req, res) => {
  const [totalDentists, totalPatients, totalSessions, insuranceDistribution] =
    await Promise.all([
      Dentist.countDocuments({ role: 'dentist' }),
      Patient.countDocuments(),
      Session.countDocuments(),
      Patient.aggregate([
        { $group: { _id: '$insuranceCompany', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $project: { _id: 0, insuranceCompany: '$_id', patientCount: '$count' } },
      ]),
    ]);

  res.json({ totalDentists, totalPatients, totalSessions, insuranceDistribution });
});

// ─────────────────────────────────────────────────────────────
// @desc    List all dentists with optional search + enriched counts
// @route   GET /api/admin/dentists?search=keyword
// @access  Private / Admin
// ─────────────────────────────────────────────────────────────
const getAllDentists = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  const skip = (page - 1) * limit;

  const matchStage = { role: 'dentist' };

  if (search) {
    const regex = new RegExp(search, 'i');
    matchStage.$or = [{ name: regex }, { email: regex }];
  }

  // Count total matching for pagination metadata
  const totalDentists = await Dentist.countDocuments(matchStage);

  const dentists = await Dentist.aggregate([
    { $match: matchStage },
    { $project: { password: 0, refreshToken: 0, __v: 0 } },
    {
      $lookup: {
        from: 'patients',
        localField: '_id',
        foreignField: 'dentist_id',
        as: '_patients',
      },
    },
    { $addFields: { patientCount: { $size: '$_patients' } } },
    {
      $lookup: {
        from: 'sessions',
        localField: '_id',
        foreignField: 'dentist_id',
        as: '_sessions',
      },
    },
    { $addFields: { sessionCount: { $size: '$_sessions' } } },
    { $project: { _patients: 0, _sessions: 0 } },
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
  ]);

  res.json({
    totalDentists,
    totalPages: Math.ceil(totalDentists / limit),
    currentPage: page,
    limit,
    dentists
  });
});

// ─────────────────────────────────────────────────────────────
// @desc    Toggle a dentist's status between 'active' and 'suspended'
// @route   PATCH /api/admin/dentists/:id/status
// @access  Private / Admin
// ─────────────────────────────────────────────────────────────
const toggleDentistStatus = asyncHandler(async (req, res) => {
  const dentist = await Dentist.findById(req.params.id);

  if (!dentist) {
    res.status(404);
    throw new Error('Dentist not found');
  }

  if (dentist._id.toString() === req.dentist._id.toString()) {
    res.status(400);
    throw new Error('You cannot suspend your own account');
  }

  dentist.status = dentist.status === 'active' ? 'suspended' : 'active';

  if (dentist.status === 'suspended') {
    dentist.refreshToken = null;
  }

  await dentist.save({ validateModifiedOnly: true });

  res.json({
    _id: dentist._id,
    name: dentist.name,
    email: dentist.email,
    status: dentist.status,
    message: `Dentist ${dentist.name} has been ${dentist.status}.`,
  });
});

// ─────────────────────────────────────────────────────────────
// @desc    Platform Revenue Dashboard stats
// @route   GET /api/admin/revenue
// @access  Private / Admin
// ─────────────────────────────────────────────────────────────
const getRevenueStats = asyncHandler(async (_req, res) => {
  // Get the start of 12 months ago
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const [totals, monthlyRevenue, topDentists] = await Promise.all([
    // 1️⃣  Global revenue totals
    Session.aggregate([
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$total_cost' },
          totalPaid: { $sum: '$amount_paid' },
          totalDentistCuts: { $sum: '$dentist_cut' },
          totalOutstanding: { $sum: '$remaining_balance' },
        },
      },
    ]),

    // 2️⃣  Monthly revenue for last 12 months (for bar chart)
    Session.aggregate([
      { $match: { date: { $gte: twelveMonthsAgo } } },
      {
        $group: {
          _id: {
            year: { $year: '$date' },
            month: { $month: '$date' },
          },
          revenue: { $sum: '$total_cost' },
          dentistCuts: { $sum: '$dentist_cut' },
          sessionCount: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      {
        $project: {
          _id: 0,
          year: '$_id.year',
          month: '$_id.month',
          revenue: 1,
          dentistCuts: 1,
          sessionCount: 1,
        },
      },
    ]),

    // 3️⃣  Top 5 earning dentists (leaderboard)
    Session.aggregate([
      {
        $group: {
          _id: '$dentist_id',
          totalRevenue: { $sum: '$total_cost' },
          totalDentistCut: { $sum: '$dentist_cut' },
          sessionCount: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'dentists',
          localField: '_id',
          foreignField: '_id',
          as: 'dentist',
        },
      },
      { $unwind: '$dentist' },
      {
        $project: {
          _id: 0,
          dentistId: '$dentist._id',
          name: '$dentist.name',
          email: '$dentist.email',
          totalRevenue: 1,
          totalDentistCut: 1,
          sessionCount: 1,
        },
      },
    ]),
  ]);

  const global = totals[0] || {
    totalRevenue: 0,
    totalPaid: 0,
    totalDentistCuts: 0,
    totalOutstanding: 0,
  };

  // Fill in missing months with zero values
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(twelveMonthsAgo);
    d.setMonth(d.getMonth() + i);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const existing = monthlyRevenue.find(
      (m) => m.year === year && m.month === month
    );
    months.push({
      year,
      month,
      label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      revenue: existing?.revenue || 0,
      dentistCuts: existing?.dentistCuts || 0,
      sessionCount: existing?.sessionCount || 0,
    });
  }

  res.json({
    global,
    monthlyRevenue: months,
    topDentists,
  });
});

// ─────────────────────────────────────────────────────────────
// @desc    Get detailed profile for a single dentist (admin drill-down)
// @route   GET /api/admin/dentists/:id
// @access  Private / Admin
// ─────────────────────────────────────────────────────────────
const getDentistProfile = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error('Invalid dentist ID');
  }

  const dentist = await Dentist.findById(id).select('-password -refreshToken');
  if (!dentist) {
    res.status(404);
    throw new Error('Dentist not found');
  }

  // Run optimized queries in parallel (Removing full Patients and Recent Sessions)
  const [patientCount, clinics, earningsByClinic, treatmentBreakdown, totals, portfolio] =
    await Promise.all([
      // 1️⃣  Count of patients belonging to this dentist (Optimized)
      Patient.countDocuments({ dentist_id: id, isDeleted: { $ne: true } }),

      // 2️⃣  All clinics belonging to this dentist
      Clinic.find({ dentist_id: id })
        .select('name address default_commission_percentage')
        .sort({ name: 1 }),

      // 3️⃣  Earnings breakdown by clinic
      Session.aggregate([
        { $match: { dentist_id: new mongoose.Types.ObjectId(id) } },
        {
          $group: {
            _id: '$clinic_id',
            totalRevenue: { $sum: '$total_cost' },
            totalDentistCut: { $sum: '$dentist_cut' },
            sessionCount: { $sum: 1 },
          },
        },
        {
          $lookup: {
            from: 'clinics',
            localField: '_id',
            foreignField: '_id',
            as: 'clinic',
          },
        },
        { $unwind: { path: '$clinic', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            clinicName: { $ifNull: ['$clinic.name', 'Unknown Clinic'] },
            totalRevenue: 1,
            totalDentistCut: 1,
            sessionCount: 1,
          },
        },
        { $sort: { totalRevenue: -1 } },
      ]),

      // 4️⃣  Treatment category breakdown
      Session.aggregate([
        { $match: { dentist_id: new mongoose.Types.ObjectId(id) } },
        { $unwind: '$treatment_category' },
        {
          $group: {
            _id: '$treatment_category',
            count: { $sum: 1 },
            revenue: { $sum: '$total_cost' },
          },
        },
        { $sort: { count: -1 } },
        {
          $project: {
            _id: 0,
            category: '$_id',
            count: 1,
            revenue: 1,
          },
        },
      ]),

      // 5️⃣  Overall totals for this dentist
      Session.aggregate([
        { $match: { dentist_id: new mongoose.Types.ObjectId(id) } },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$total_cost' },
            totalPaid: { $sum: '$amount_paid' },
            totalDentistCut: { $sum: '$dentist_cut' },
            totalOutstanding: { $sum: '$remaining_balance' },
            sessionCount: { $sum: 1 },
          },
        },
      ]),

      // 6️⃣  Portfolio Status
      Portfolio.findOne({ dentist_id: id }).select('slug isPublished isSuspended'),
    ]);

  res.json({
    dentist,
    stats: totals[0] || {
      totalRevenue: 0,
      totalPaid: 0,
      totalDentistCut: 0,
      totalOutstanding: 0,
      sessionCount: 0,
    },
    patientCount,
    clinics,
    earningsByClinic,
    treatmentBreakdown,
    portfolio,
  });
});

// ─────────────────────────────────────────────────────────────
// @desc    Force a password reset (generate temporary password)
// @route   POST /api/admin/dentists/:id/reset-password
// @access  Private / Admin
// ─────────────────────────────────────────────────────────────
const resetDentistPassword = asyncHandler(async (req, res) => {
  const dentist = await Dentist.findById(req.params.id);

  if (!dentist) {
    res.status(404);
    throw new Error('Dentist not found');
  }

  // Prevent an admin from resetting their own password this way (safety check)
  if (dentist._id.toString() === req.dentist._id.toString()) {
    res.status(400);
    throw new Error('You cannot reset your own password via admin panel');
  }

  // Generate a secure 12-character random string for the temporary password
  const newPassword = crypto.randomBytes(6).toString('hex');

  // Update password and clear sessions to force logout from all devices
  dentist.password = newPassword;
  
  // Atomic clear of all refresh tokens
  await RefreshToken.deleteMany({ dentistId: dentist._id });

  await dentist.save();

  res.json({
    _id: dentist._id,
    name: dentist.name,
    message: 'Password successfully reset.',
    temporaryPassword: newPassword, // Only returned this ONE time to the admin
  });
});

// ─────────────────────────────────────────────────────────────
// @desc    Impersonate a dentist (Shadow Access)
// @route   POST /api/admin/dentists/:id/impersonate
// @access  Private / Admin
// ─────────────────────────────────────────────────────────────
const impersonateDentist = asyncHandler(async (req, res) => {
  const dentist = await Dentist.findById(req.params.id);

  if (!dentist) {
    res.status(404);
    throw new Error('Dentist not found');
  }

  // Prevent admin from impersonating another admin for security
  if (dentist.role === 'admin') {
    res.status(403);
    throw new Error('Shadow access is only available for dentist accounts');
  }

  const accessToken = generateAccessToken(dentist._id, dentist.role);
  const refreshToken = generateRefreshToken(dentist._id, dentist.role);

  // Manage active sessions (limit to 5 devices)
  const sessionCount = await RefreshToken.countDocuments({ dentistId: dentist._id });
  if (sessionCount >= 5) {
    const oldestTokens = await RefreshToken.find({ dentistId: dentist._id })
      .sort({ createdAt: 1 })
      .limit(sessionCount - 4);
    await RefreshToken.deleteMany({ _id: { $in: oldestTokens.map(t => t._id) } });
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await RefreshToken.create({
    dentistId: dentist._id,
    token: refreshToken,
    expiresAt,
    userAgent: req.headers['user-agent'] + ' (Shadow Access)',
    ip: req.ip || req.connection.remoteAddress,
  });

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

  res.json({
    _id: dentist._id,
    name: dentist.name,
    email: dentist.email,
    role: dentist.role,
    profilePhoto: dentist.profilePhoto,
    accessToken,
    isShadowMode: true,
  });
});

// ─────────────────────────────────────────────────────────────
// @desc    Toggle a portfolio's suspension status
// @route   PATCH /api/admin/dentists/:id/portfolio-status
// @access  Private / Admin
// ─────────────────────────────────────────────────────────────
const togglePortfolioSuspension = asyncHandler(async (req, res) => {
  const portfolio = await Portfolio.findOne({ dentist_id: req.params.id });

  if (!portfolio) {
    res.status(404);
    throw new Error('No portfolio found for this dentist');
  }

  portfolio.isSuspended = !portfolio.isSuspended;
  await portfolio.save();

  res.json({
    _id: portfolio._id,
    dentist_id: portfolio.dentist_id,
    isSuspended: portfolio.isSuspended,
    message: `Portfolio has been ${portfolio.isSuspended ? 'suspended' : 'unsuspended'}.`,
  });
});

module.exports = {
  getPlatformStats,
  getAllDentists,
  toggleDentistStatus,
  getRevenueStats,
  getDentistProfile,
  resetDentistPassword,
  impersonateDentist,
  togglePortfolioSuspension,
};
