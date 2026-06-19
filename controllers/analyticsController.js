const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Session = require('../models/Session');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const FixedSalary = require('../models/FixedSalary');
const { analyticsCache } = require('../utils/cache');

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

  // ── CACHE CHECK ───────────────────────────
  const cacheKey = `dash_${dentistId}_${timeframe}`;
  const cachedData = analyticsCache.get(cacheKey);
  if (cachedData) return res.json(cachedData);

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
        isDeleted: { $ne: true },
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

  // Sort again after adding fixed salaries
  earningsData.sort((a, b) => b.totalDentistCut - a.totalDentistCut);

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

  const currentDay = new Date().getDate();
  const currentMonth = new Date().getMonth(); // 0-indexed
  const currentFullYear = new Date().getFullYear();
  const fixedSalariesList = await FixedSalary.find({ dentist_id: dentistId }).lean();

  let monthly_fixed_salary = 0;

  if (timeframe === 'monthly') {
    // Only count salaries where salary_day has passed this month
    monthly_fixed_salary = fixedSalariesList.reduce((sum, fs) => {
      const created = new Date(fs.createdAt);
      if (created.getFullYear() > currentFullYear || 
         (created.getFullYear() === currentFullYear && created.getMonth() > currentMonth)) return sum;
      if (fs.salary_day <= currentDay) return sum + fs.amount;
      return sum;
    }, 0);
  } else if (timeframe === 'yearly') {
    // Sum for each past month of the year + check current month
    for (const fs of fixedSalariesList) {
      const created = new Date(fs.createdAt);
      const createdYear = created.getFullYear();
      const createdMonth = created.getMonth(); // 0-indexed
      
      for (let m = 0; m <= currentMonth; m++) {
        // Skip months before the salary was created
        if (currentFullYear < createdYear) continue;
        if (currentFullYear === createdYear && m < createdMonth) continue;
        
        if (m < currentMonth) {
          // Past month — full salary
          monthly_fixed_salary += fs.amount;
        } else if (m === currentMonth) {
          // Current month — only if salary_day has passed
          if (currentDay >= fs.salary_day) {
            monthly_fixed_salary += fs.amount;
          }
        }
      }
    }
  } else {
    // 'all' — sum all months from createdAt to now
    for (const fs of fixedSalariesList) {
      const created = new Date(fs.createdAt);
      const createdYear = created.getFullYear();
      const createdMonth = created.getMonth();
      
      // Count full months from creation to last month
      let monthsCounted = 0;
      let y = createdYear;
      let m = createdMonth;
      while (y < currentFullYear || (y === currentFullYear && m < currentMonth)) {
        monthsCounted++;
        m++;
        if (m > 11) { m = 0; y++; }
      }
      monthly_fixed_salary += monthsCounted * fs.amount;
      
      // Check current month
      if (currentDay >= fs.salary_day) {
        monthly_fixed_salary += fs.amount;
      }
    }
  }

  const responseData = {
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
      monthly_fixed_salary,
    },
    earnings: earningsData,
  };

  // Cache for 300 seconds (5 minutes)
  analyticsCache.set(cacheKey, responseData, 300);

  res.json(responseData);
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
        isDeleted: { $ne: true },
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

  // ── CACHE CHECK ───────────────────────────
  const cacheKey = `treat_${dentistId}_${filterType}_${year}_${customStart}_${customEnd}`;
  const cachedData = analyticsCache.get(cacheKey);
  if (cachedData) return res.json(cachedData);

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
        isDeleted: { $ne: true },
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

  const responseData = {
    filterType,
    treatmentDistribution,
  };

  // Cache for 300 seconds
  analyticsCache.set(cacheKey, responseData, 300);

  res.json(responseData);
});

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

  // ── CACHE CHECK ───────────────────────────
  const cacheKey = `hist_${dentistId}_${filterType}_${year}_${month}_${customStart}_${customEnd}`;
  const cachedData = analyticsCache.get(cacheKey);
  if (cachedData) return res.json(cachedData);

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
        isDeleted: { $ne: true },
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
    monthNum: point.month, // preserve the numeric month (1-12) before overwriting
    monthLabel: filterType === 'yearly' ? monthNames[point.month - 1] : `${monthNames[point.month - 1]} ${String(point.year).slice(-2)}`,
    // For recharts dataKey
    month: filterType === 'yearly' ? monthNames[point.month - 1] : `${monthNames[point.month - 1]} ${String(point.year).slice(-2)}`
  }));

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
  } else if (filterType === 'custom' && customStart && customEnd) {
    const startObj = new Date(customStart);
    const endObj = new Date(customEnd);
    const completeCustomTrend = [];
    
    let y = startObj.getFullYear();
    let m = startObj.getMonth() + 1; // 1-indexed
    const endY = endObj.getFullYear();
    const endM = endObj.getMonth() + 1;

    while (y < endY || (y === endY && m <= endM)) {
      const label = `${monthNames[m - 1]} ${String(y).slice(-2)}`;
      const monthData = formattedTrend.find((data) => data.month === label);
      completeCustomTrend.push(monthData || {
        month: label,
        monthNum: m,
        year: y,
        earnings: 0,
        sessions: 0,
      });
      m++;
      if (m > 12) { m = 1; y++; }
    }
    formattedTrend = completeCustomTrend;
  }

  // 3. Get monthly breakdown (if specific month OR if range is small)
  let breakdownMatch = { ...dateMatch };
  if (filterType === 'yearly' && selectedMonth) {
    breakdownMatch = {
      $gte: new Date(selectedYear, selectedMonth - 1, 1),
      $lte: new Date(selectedYear, selectedMonth, 0, 23, 59, 59, 999),
    };
  }

  // Get commission earnings per clinic from sessions
  const commissionBreakdown = await Session.aggregate([
    {
      $match: {
        dentist_id: mongoose.Types.ObjectId.isValid(dentistId)
          ? new mongoose.Types.ObjectId(dentistId)
          : dentistId,
        clinic_id: { $in: clinicIds },
        date: breakdownMatch,
        isDeleted: { $ne: true },
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
        commission: { $round: ['$totalEarnings', 2] },
        sessions: '$totalSessions',
      },
    },
    { $sort: { commission: -1 } },
  ]);

  // Combine session cuts with prorated fixed salaries
  const fullDentistClinics = await Clinic.find({ dentist_id: dentistId }).lean();
  const dentistFixedSalaries = await FixedSalary.find({ dentist_id: dentistId }).lean();

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const currentDay = new Date().getDate();

  // 1. Add fixed salaries to the Yearly Trend
  for (const point of formattedTrend) {
    const pointStart = new Date(point.year, point.monthNum ? point.monthNum - 1 : monthNames.indexOf(point.month.split(' ')[0]), 1);
    const pointEnd = new Date(point.year, pointStart.getMonth() + 1, 0, 23, 59, 59, 999);



    let pointFixedSalary = 0;
    const pointMonthIndex = point.monthNum ? point.monthNum : (monthNames.indexOf(point.month.split(' ')[0]) + 1);
    
    for (const fs of dentistFixedSalaries) {
      const createdDate = new Date(fs.createdAt);
      const createdYear = createdDate.getFullYear();
      const createdMonth = createdDate.getMonth() + 1;

      // Do not apply the fixed salary to months BEFORE it was created in the system
      if (point.year < createdYear) continue;
      if (point.year === createdYear && pointMonthIndex < createdMonth) continue;

      if (point.year < currentYear) {
        pointFixedSalary += fs.amount;
      } else if (point.year === currentYear) {
        if (pointMonthIndex < currentMonth) {
          pointFixedSalary += fs.amount;
        } else if (pointMonthIndex === currentMonth) {
          if (currentDay >= fs.salary_day) {
            pointFixedSalary += fs.amount;
          }
        }
      }
    }
    
    point.fixed_salary = pointFixedSalary;
  }

  // 2. Build per-clinic breakdown with separate commission and fixed_salary fields
  const clinicBreakdownMap = new Map();

  // Add commission data
  for (const entry of commissionBreakdown) {
    clinicBreakdownMap.set(entry.clinicId.toString(), {
      clinicId: entry.clinicId,
      clinicName: entry.clinicName,
      commission: entry.commission,
      fixed_salary: 0,
      sessions: entry.sessions,
    });
  }



  // Add fixed salaries per clinic (respecting createdAt and salary_day)
  for (const fs of dentistFixedSalaries) {
    const clinicId = (fs.clinic_id._id || fs.clinic_id).toString();
    const created = new Date(fs.createdAt);
    const createdYear = created.getFullYear();
    const createdMonth0 = created.getMonth(); // 0-indexed

    let fsTotal = 0;

    if (filterType === 'yearly') {
      // Sum for each applicable month of the selected year
      const maxMonth = selectedYear < currentYear ? 11 : (currentMonth - 1); // 0-indexed
      for (let m = 0; m <= maxMonth; m++) {
        if (selectedYear < createdYear) continue;
        if (selectedYear === createdYear && m < createdMonth0) continue;

        if (selectedYear < currentYear) {
          fsTotal += fs.amount;
        } else if (m < currentMonth - 1) {
          fsTotal += fs.amount;
        } else if (m === currentMonth - 1) {
          if (currentDay >= fs.salary_day) fsTotal += fs.amount;
        }
      }
    } else if (filterType === 'all') {
      let y = createdYear, m = createdMonth0;
      while (y < currentYear || (y === currentYear && m < currentMonth - 1)) {
        fsTotal += fs.amount;
        m++;
        if (m > 11) { m = 0; y++; }
      }
      if (currentDay >= fs.salary_day) fsTotal += fs.amount;
    } else {
      // custom or single month
      let customStartObj = new Date(createdYear, createdMonth0, 1);
      let customEndObj = new Date();
      
      if (filterType === 'custom') {
        if (customStart) {
          const parsedStart = new Date(customStart);
          if (parsedStart > customStartObj) customStartObj = parsedStart;
        }
        if (customEnd) {
          customEndObj = new Date(customEnd);
          customEndObj.setHours(23, 59, 59, 999);
        }
      }
      
      let y = customStartObj.getFullYear();
      let m = customStartObj.getMonth();
      let endY = customEndObj.getFullYear();
      let endM = customEndObj.getMonth();

      while (y < endY || (y === endY && m <= endM)) {
        if (y > currentYear || (y === currentYear && m > currentMonth - 1)) break;
        if (y === currentYear && m === currentMonth - 1) {
          if (currentDay >= fs.salary_day) fsTotal += fs.amount;
        } else {
          fsTotal += fs.amount;
        }
        m++;
        if (m > 11) { m = 0; y++; }
      }
    }

    if (fsTotal > 0) {
      const clinicEntry = clinicBreakdownMap.get(clinicId);
      if (clinicEntry) {
        clinicEntry.fixed_salary += fsTotal;
      } else {
        // Find clinic name
        const clinicDoc = fullDentistClinics.find(c => c._id.toString() === clinicId);
        clinicBreakdownMap.set(clinicId, {
          clinicId: fs.clinic_id._id || fs.clinic_id,
          clinicName: clinicDoc ? clinicDoc.name : 'Unknown Clinic',
          commission: 0,
          fixed_salary: fsTotal,
          sessions: 0,
        });
      }
    }
  }

  // Convert map to array and add total earnings
  const monthlyBreakdown = Array.from(clinicBreakdownMap.values()).map(entry => ({
    ...entry,
    commission: Math.round(entry.commission * 100) / 100,
    fixed_salary: Math.round(entry.fixed_salary * 100) / 100,
    earnings: Math.round((entry.commission + entry.fixed_salary) * 100) / 100,
  }));

  monthlyBreakdown.sort((a, b) => b.earnings - a.earnings);

  const totalEarnings = formattedTrend.reduce((sum, m) => sum + m.earnings + (m.fixed_salary || 0), 0);
  const totalSessions = formattedTrend.reduce((sum, m) => sum + m.sessions, 0);
  const periodEarnings = monthlyBreakdown.reduce((sum, m) => sum + m.earnings, 0);

  const responseData = {
    filterType,
    summary: {
      totalYearlyEarnings: Math.round(totalEarnings * 100) / 100,
      totalYearlySessions: totalSessions,
      totalMonthlyEarnings: Math.round(periodEarnings * 100) / 100,
    },
    yearlyTrend: formattedTrend,
    monthlyBreakdown,
  };

  // Cache for 300 seconds
  analyticsCache.set(cacheKey, responseData, 300);

  res.json(responseData);
});

module.exports = { getDashboardStats, getMonthlyEarnings, getTreatmentDistribution, getEarningsHistory };
