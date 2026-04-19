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
// GET /api/analytics/treatments?filterType=yearly|all|custom&year=2026&startDate=...&endDate=...
const getTreatmentDistribution = asyncHandler(async (req, res) => {
  const { 
    filterType = 'all', 
    year = new Date().getFullYear(),
    startDate: customStart,
    endDate: customEnd
  } = req.query;

  const dentistId = req.dentist._id;

  // SECURITY: Filter clinics owned by the dentist
  const dentistClinics = await Clinic.find({ dentist_id: dentistId }).select('_id').lean();
  const clinicIds = dentistClinics.map((c) => c._id);

  // Define Date Match Stage
  let dateMatch = {};
  if (filterType === 'yearly') {
    const selectedYear = parseInt(year, 10);
    dateMatch = {
      $gte: new Date(selectedYear, 0, 1),
      $lte: new Date(selectedYear, 11, 31, 23, 59, 59, 999),
    };
  } else if (filterType === 'custom' && customStart && customEnd) {
    dateMatch = {
      $gte: new Date(customStart),
      $lte: new Date(customEnd),
    };
    dateMatch.$lte.setHours(23, 59, 59, 999);
  } else if (filterType === 'all') {
    dateMatch = { $exists: true };
  }

  const treatmentDistribution = await Session.aggregate([
    {
      // Filter by dentist, clinics, AND the calculated date range
      $match: {
        dentist_id: mongoose.Types.ObjectId.isValid(dentistId)
          ? new mongoose.Types.ObjectId(dentistId)
          : dentistId,
        clinic_id: { $in: clinicIds },
        date: dateMatch,
      },
    },
    // Unwind the treatment_category array
    { $unwind: '$treatment_category' },
    {
      $group: {
        _id: '$treatment_category',
        count: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        category: { $trim: { input: '$_id' } },
        count: 1,
      },
    },
    { $sort: { count: -1 } },
  ]);

  res.json({
    filterType,
    treatmentDistribution,
  });
});

// ── Get Historical Earnings Analytics ─────────────────────
// GET /api/analytics/earnings-history?year=2026&month=3
// ── Get Historical Earnings Analytics ─────────────────────
// GET /api/analytics/earnings-history?filterType=yearly|all|custom&year=2026&month=3&startDate=2024-01-01&endDate=2024-12-31
const getEarningsHistory = asyncHandler(async (req, res) => {
  const { 
    filterType = 'yearly', 
    year = new Date().getFullYear(), 
    month,
    startDate: customStart,
    endDate: customEnd
  } = req.query;
  
  const dentistId = req.dentist._id;

  if (!dentistId) {
    return res.status(401).json({ error: 'Dentist ID required' });
  }

  // SECURITY: Always filter by dentist_id
  const dentistClinics = await Clinic.find({ dentist_id: dentistId })
    .select('_id')
    .lean();
  const clinicIds = dentistClinics.map((c) => c._id);

  // 1. Define the Date Match Stage
  let dateMatch = {};
  const selectedYear = parseInt(year, 10);
  const selectedMonth = month ? parseInt(month, 10) : null;

  if (filterType === 'yearly') {
    dateMatch = {
      $gte: new Date(selectedYear, 0, 1),
      $lte: new Date(selectedYear, 11, 31, 23, 59, 59, 999),
    };
  } else if (filterType === 'custom' && customStart && customEnd) {
    dateMatch = {
      $gte: new Date(customStart),
      $lte: new Date(customEnd),
    };
    // Ensure the end date covers the full day
    dateMatch.$lte.setHours(23, 59, 59, 999);
  } else if (filterType === 'all') {
    // No date restriction for "All-Time"
    dateMatch = { $exists: true };
  }

  // 2. Aggregate Yearly/Timeline Trend
  const trendAggregation = [
    {
      $match: {
        dentist_id: mongoose.Types.ObjectId.isValid(dentistId)
          ? new mongoose.Types.ObjectId(dentistId)
          : dentistId,
        clinic_id: { $in: clinicIds },
        date: dateMatch,
      },
    },
    {
      $group: {
        _id: {
          year: { $year: '$date' },
          month: { $month: '$date' },
        },
        totalEarnings: { $sum: '$dentist_cut' },
        totalSessions: { $sum: 1 },
      },
    },
    {
      $project: {
        _id: 0,
        year: '$_id.year',
        month: '$_id.month',
        earnings: { $round: ['$totalEarnings', 2] },
        sessions: '$totalSessions',
      },
    },
    { $sort: { year: 1, month: 1 } },
  ];

  const yearlyTrend = await Session.aggregate(trendAggregation);

  // Format labels based on range duration
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  let formattedTrend = yearlyTrend.map(point => ({
    ...point,
    monthLabel: filterType === 'yearly' ? monthNames[point.month - 1] : `${monthNames[point.month - 1]} ${String(point.year).slice(-2)}`,
    // For recharts dataKey
    month: filterType === 'yearly' ? monthNames[point.month - 1] : `${monthNames[point.month - 1]} ${String(point.year).slice(-2)}`
  }));

  // If "yearly" is selected and we have 0 data for some months, fill them in
  if (filterType === 'yearly') {
    const completeYearlyTrend = monthNames.map((name, idx) => {
      const monthNum = idx + 1;
      const monthData = formattedTrend.find((m) => m.month === name);
      return monthData || {
        month: name,
        monthNum,
        year: selectedYear,
        earnings: 0,
        sessions: 0,
      };
    });
    formattedTrend = completeYearlyTrend;
  }

  // 3. Get monthly breakdown (if specific month OR if range is small)
  // For 'yearly', we use selectedMonth. For other types, we might just use the whole range breakdown.
  let breakdownMatch = { ...dateMatch };
  if (filterType === 'yearly' && selectedMonth) {
    breakdownMatch = {
      $gte: new Date(selectedYear, selectedMonth - 1, 1),
      $lte: new Date(selectedYear, selectedMonth, 0, 23, 59, 59, 999),
    };
  }

  const monthlyBreakdown = await Session.aggregate([
    {
      $match: {
        dentist_id: mongoose.Types.ObjectId.isValid(dentistId)
          ? new mongoose.Types.ObjectId(dentistId)
          : dentistId,
        clinic_id: { $in: clinicIds },
        date: breakdownMatch,
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

  const totalEarnings = formattedTrend.reduce((sum, m) => sum + m.earnings, 0);
  const totalSessions = formattedTrend.reduce((sum, m) => sum + m.sessions, 0);
  const periodEarnings = monthlyBreakdown.reduce((sum, m) => sum + m.earnings, 0);

  res.json({
    filterType,
    summary: {
      totalYearlyEarnings: Math.round(totalEarnings * 100) / 100,
      totalYearlySessions: totalSessions,
      totalMonthlyEarnings: Math.round(periodEarnings * 100) / 100,
    },
    yearlyTrend: formattedTrend,
    monthlyBreakdown,
  });
});

module.exports = { getDashboardStats, getMonthlyEarnings, getTreatmentDistribution, getEarningsHistory };
