const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Session = require('../models/Session');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');

// ── Helper: Calculate Date Range ──────────────
const getDateRange = (timeframe) => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let startDate, endDate;

  switch (timeframe) {
    case 'monthly':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      break;
    case 'yearly':
      startDate = new Date(now.getFullYear(), 0, 1);
      endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      break;
    case 'all':
    default:
      startDate = new Date('1970-01-01');
      endDate = new Date(now.getFullYear() + 100, 11, 31, 23, 59, 59, 999);
  }

  return { startDate, endDate };
};

// ── Get Dashboard Stats with Dynamic Timeframe ─
// GET /api/analytics/dashboard-stats?timeframe=monthly|yearly|all
const getDashboardStats = asyncHandler(async (req, res) => {
  const { timeframe = 'monthly' } = req.query;
  const dentistId = req.dentist._id;
  
  if (!dentistId) {
    return res.status(401).json({ error: 'Dentist ID required' });
  }

  const { startDate, endDate } = getDateRange(timeframe);

  // SECURITY: Filter by dentist_id in every query
  const dentistClinics = await Clinic.find({ dentist_id: dentistId })
    .select('_id')
    .lean();
  const clinicIds = dentistClinics.map((c) => c._id);

  // Total Earnings (Sessions)
  const earningsData = await Session.aggregate([
    {
      $match: {
        dentist_id: mongoose.Types.ObjectId.isValid(dentistId) 
          ? new mongoose.Types.ObjectId(dentistId)
          : dentistId,
        clinic_id: { $in: clinicIds },
        date: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: '$clinic_id',
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
    { $unwind: '$clinic' },
    {
      $project: {
        _id: 0,
        clinic_id: '$_id',
        clinicName: '$clinic.name',
        totalDentistCut: 1,
        sessionCount: 1,
      },
    },
    { $sort: { totalDentistCut: -1 } },
  ]);

  const totalEarnings = earningsData.reduce((sum, e) => sum + e.totalDentistCut, 0);
  const totalSessions = earningsData.reduce((sum, e) => sum + e.sessionCount, 0);

  // Total Patients (based on createdAt) - SECURITY: Filter by dentist_id
  const totalPatientsCount = await Patient.countDocuments({
    dentist_id: dentistId,
    createdAt: { $gte: startDate, $lte: endDate },
  });

  // All time active patients (not filtered by timeframe)
  const activePatients = await Patient.countDocuments({
    dentist_id: dentistId,
    status: 'Active',
  });

  res.json({
    timeframe,
    period: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
    stats: {
      totalEarnings,
      totalSessions,
      patientsAdded: totalPatientsCount,
      activePatients,
    },
    earnings: earningsData,
  });
});

// ── Get Monthly Earnings (deprecated - use getDashboardStats) ──────────────────────
// GET /api/analytics/monthly-earnings
const getMonthlyEarnings = asyncHandler(async (req, res) => {
  // Determine the first and last moment of the current month
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const dentistId = req.dentist._id;

  // Only consider clinics owned by the logged-in dentist
  const dentistClinics = await Clinic.find({ dentist_id: dentistId }).select('_id').lean();
  const clinicIds = dentistClinics.map((c) => c._id);

  const earnings = await Session.aggregate([
    {
      $match: {
        dentist_id: mongoose.Types.ObjectId.isValid(dentistId)
          ? new mongoose.Types.ObjectId(dentistId)
          : dentistId,
        clinic_id: { $in: clinicIds },
        date: { $gte: startOfMonth, $lte: endOfMonth },
      },
    },
    {
      $group: {
        _id: '$clinic_id',
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
    { $unwind: '$clinic' },
    {
      $project: {
        _id: 0,
        clinic_id: '$_id',
        clinicName: '$clinic.name',
        totalDentistCut: 1,
        sessionCount: 1,
      },
    },
    { $sort: { totalDentistCut: -1 } },
  ]);

  res.json({
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    earnings,
  });
});

// ── Get Treatment Distribution ────────────────
// GET /api/analytics/treatments
const getTreatmentDistribution = asyncHandler(async (req, res) => {
  const dentistId = req.dentist._id;

  // SECURITY: Always filter by dentist_id to prevent data leakage
  // Only consider clinics AND sessions owned by the logged-in dentist
  const dentistClinics = await Clinic.find({ dentist_id: dentistId }).select('_id').lean();
  const clinicIds = dentistClinics.map((c) => c._id);

  const treatmentDistribution = await Session.aggregate([
    {
      // CRITICAL: Filter by BOTH dentist_id AND clinic_id
      $match: {
        dentist_id: mongoose.Types.ObjectId.isValid(dentistId)
          ? new mongoose.Types.ObjectId(dentistId)
          : dentistId,
        clinic_id: { $in: clinicIds },
      },
    },
    // Group by treatment_category (no $unwind needed - it's a String field, not array)
    {
      $group: {
        _id: '$treatment_category',
        count: { $sum: 1 },
      },
    },
    // Normalize categories: trim and standardize casing
    {
      $project: {
        _id: 0,
        category: { $trim: { input: '$_id' } },
        count: 1,
      },
    },
    // Sort by count descending (most common treatments first)
    { $sort: { count: -1 } },
  ]);

  res.json({
    treatmentDistribution,
  });
});

// ── Get Historical Earnings Analytics ─────────────────────
// GET /api/analytics/earnings-history?year=2026&month=3
const getEarningsHistory = asyncHandler(async (req, res) => {
  const { year = new Date().getFullYear(), month } = req.query;
  const dentistId = req.dentist._id;

  if (!dentistId) {
    return res.status(401).json({ error: 'Dentist ID required' });
  }

  const selectedYear = parseInt(year, 10);
  const selectedMonth = month ? parseInt(month, 10) : null;

  // SECURITY: Always filter by dentist_id
  const dentistClinics = await Clinic.find({ dentist_id: dentistId })
    .select('_id')
    .lean();
  const clinicIds = dentistClinics.map((c) => c._id);

  // Get yearly trend: earnings for each month of the selected year
  const yearlyTrend = await Session.aggregate([
    {
      $match: {
        dentist_id: mongoose.Types.ObjectId.isValid(dentistId)
          ? new mongoose.Types.ObjectId(dentistId)
          : dentistId,
        clinic_id: { $in: clinicIds },
        date: {
          $gte: new Date(selectedYear, 0, 1),
          $lte: new Date(selectedYear, 11, 31, 23, 59, 59, 999),
        },
      },
    },
    {
      $group: {
        _id: { $month: '$date' }, // Group by month (1-12)
        totalEarnings: { $sum: '$dentist_cut' },
        totalSessions: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        month: '$_id',
        earnings: { $round: ['$totalEarnings', 2] },
        sessions: '$totalSessions',
      },
    },
    { $sort: { month: 1 } },
  ]);

  // Fill in missing months with 0 earnings
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  
  const completeYearlyTrend = monthNames.map((name, idx) => {
    const monthNum = idx + 1;
    const monthData = yearlyTrend.find((m) => m.month === monthNum);
    return {
      month: name,
      monthNum,
      earnings: monthData?.earnings || 0,
      sessions: monthData?.sessions || 0,
    };
  });

  // Get monthly breakdown if a specific month is requested
  let monthlyBreakdown = [];
  if (selectedMonth && selectedMonth >= 1 && selectedMonth <= 12) {
    monthlyBreakdown = await Session.aggregate([
      {
        $match: {
          dentist_id: mongoose.Types.ObjectId.isValid(dentistId)
            ? new mongoose.Types.ObjectId(dentistId)
            : dentistId,
          clinic_id: { $in: clinicIds },
          date: {
            $gte: new Date(selectedYear, selectedMonth - 1, 1),
            $lte: new Date(selectedYear, selectedMonth, 0, 23, 59, 59, 999),
          },
        },
      },
      {
        $lookup: {
          from: 'clinics',
          localField: 'clinic_id',
          foreignField: '_id',
          as: 'clinic',
        },
      },
      { $unwind: '$clinic' },
      {
        $group: {
          _id: {
            clinic_id: '$clinic_id',
            clinicName: '$clinic.name',
          },
          totalEarnings: { $sum: '$dentist_cut' },
          totalSessions: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          clinicId: '$_id.clinic_id',
          clinicName: '$_id.clinicName',
          earnings: { $round: ['$totalEarnings', 2] },
          sessions: '$totalSessions',
        },
      },
      { $sort: { earnings: -1 } },
    ]);
  }

  const totalYearlyEarnings = completeYearlyTrend.reduce((sum, m) => sum + m.earnings, 0);
  const totalYearlySessions = completeYearlyTrend.reduce((sum, m) => sum + m.sessions, 0);
  const totalMonthlyEarnings = monthlyBreakdown.reduce((sum, m) => sum + m.earnings, 0);

  res.json({
    year: selectedYear,
    month: selectedMonth,
    summary: {
      totalYearlyEarnings: Math.round(totalYearlyEarnings * 100) / 100,
      totalYearlySessions,
      totalMonthlyEarnings: selectedMonth ? Math.round(totalMonthlyEarnings * 100) / 100 : 0,
    },
    yearlyTrend: completeYearlyTrend,
    monthlyBreakdown,
  });
});

module.exports = { getDashboardStats, getMonthlyEarnings, getTreatmentDistribution, getEarningsHistory };
