const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Dentist = require('../models/Dentist');
const Patient = require('../models/Patient');
const Session = require('../models/Session');
const Clinic = require('../models/Clinic');

// ─────────────────────────────────────────────────────────────
// @desc    Get high-level platform statistics for the Super Admin
// @route   GET /api/admin/stats
// @access  Private / Admin
// ─────────────────────────────────────────────────────────────
const getPlatformStats = asyncHandler(async (_req, res) => {
  const [totalDentists, totalSessions, insuranceDistribution] =
    await Promise.all([
      Dentist.countDocuments({ role: 'dentist' }),
      Session.countDocuments(),
      Patient.aggregate([
        { $group: { _id: '$insuranceCompany', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $project: { _id: 0, insuranceCompany: '$_id', patientCount: '$count' } },
      ]),
    ]);

  res.json({ totalDentists, totalSessions, insuranceDistribution });
});

// ─────────────────────────────────────────────────────────────
// @desc    List all dentists with optional search + enriched counts
// @route   GET /api/admin/dentists?search=keyword
// @access  Private / Admin
// ─────────────────────────────────────────────────────────────
const getAllDentists = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const matchStage = { role: 'dentist' };

  if (search) {
    const regex = new RegExp(search, 'i');
    matchStage.$or = [{ name: regex }, { email: regex }];
  }

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
  ]);

  res.json({ count: dentists.length, dentists });
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

  // Run all queries in parallel
  const [patients, clinics, recentSessions, earningsByClinic, treatmentBreakdown, totals] =
    await Promise.all([
      // 1️⃣  All patients belonging to this dentist
      Patient.find({ dentist_id: id })
        .select('name age phone status insuranceCompany createdAt')
        .sort({ createdAt: -1 }),

      // 2️⃣  All clinics belonging to this dentist
      Clinic.find({ dentist_id: id })
        .select('name address default_commission_percentage')
        .sort({ name: 1 }),

      // 3️⃣  Last 10 sessions
      Session.find({ dentist_id: id })
        .populate('patient_id', 'name')
        .populate('clinic_id', 'name')
        .select('date treatment_category total_cost amount_paid dentist_cut remaining_balance')
        .sort({ date: -1 })
        .limit(10),

      // 4️⃣  Earnings breakdown by clinic
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

      // 5️⃣  Treatment category breakdown
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

      // 6️⃣  Overall totals for this dentist
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
    patientCount: patients.length,
    patients,
    clinics,
    recentSessions,
    earningsByClinic,
    treatmentBreakdown,
  });
});

module.exports = {
  getPlatformStats,
  getAllDentists,
  toggleDentistStatus,
  getRevenueStats,
  getDentistProfile,
};
