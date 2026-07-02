const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const Clinic = require('../models/Clinic');
const { analyticsCache } = require('../utils/cache');

// ── Get Expenses (paginated + filtered) ───────
// GET /api/expenses?clinic_id=...&category=...&startDate=...&endDate=...&page=1&limit=20
const getExpenses = asyncHandler(async (req, res) => {
  const dentistId = req.dentist._id;
  const {
    clinic_id,
    category,
    startDate,
    endDate,
    page = 1,
    limit = 20,
  } = req.query;

  const filter = { dentist_id: dentistId, isDeleted: { $ne: true } };

  if (clinic_id) {
    filter.clinic_id = clinic_id;
  }

  if (category) {
    filter.category = category;
  }

  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.date.$lte = end;
    }
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const [expenses, totalItems] = await Promise.all([
    Expense.find(filter)
      .populate('clinic_id', 'name')
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Expense.countDocuments(filter),
  ]);

  res.json({
    expenses,
    pagination: {
      page: pageNum,
      limit: limitNum,
      totalItems,
      totalPages: Math.ceil(totalItems / limitNum),
    },
  });
});

// ── Create Expense ────────────────────────────
// POST /api/expenses
const createExpense = asyncHandler(async (req, res) => {
  const dentistId = req.dentist._id;
  const { clinic_id, category, amount, description, date } = req.body;

  // Validate required fields
  if (!clinic_id || !category || amount === undefined) {
    res.status(400);
    throw new Error('Please provide clinic, category, and amount');
  }

  // Validate category
  const validCategories = ['Material', 'Salaries', 'Lab', 'Other'];
  if (!validCategories.includes(category)) {
    res.status(400);
    throw new Error('Category must be Material, Salaries, Lab, or Other');
  }

  // Validate amount
  const parsedAmount = Number(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400);
    throw new Error('Amount must be a number greater than zero');
  }

  // Verify clinic belongs to dentist
  const clinic = await Clinic.findOne({ _id: clinic_id, dentist_id: dentistId });
  if (!clinic) {
    res.status(404);
    throw new Error('Clinic not found or you do not have access to it');
  }

  // Validate date if provided
  let expenseDate = new Date();
  if (date) {
    expenseDate = new Date(date);
    if (isNaN(expenseDate.getTime())) {
      res.status(400);
      throw new Error('Invalid date provided');
    }
  }

  const expense = await Expense.create({
    dentist_id: dentistId,
    clinic_id,
    category,
    amount: parsedAmount,
    description: description || '',
    date: expenseDate,
  });

  // Populate clinic name for immediate UI usage
  await expense.populate('clinic_id', 'name');

  analyticsCache.clear();
  res.status(201).json(expense);
});

// ── Update Expense ────────────────────────────
// PUT /api/expenses/:id
const updateExpense = asyncHandler(async (req, res) => {
  const dentistId = req.dentist._id;
  const { amount, description, category, date, clinic_id } = req.body;

  const expense = await Expense.findOne({
    _id: req.params.id,
    dentist_id: dentistId,
    isDeleted: { $ne: true },
  });

  if (!expense) {
    res.status(404);
    throw new Error('Expense not found');
  }

  if (amount !== undefined) {
    const parsedAmount = Number(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      res.status(400);
      throw new Error('Amount must be a number greater than zero');
    }
    expense.amount = parsedAmount;
  }

  if (description !== undefined) {
    expense.description = description;
  }

  if (category !== undefined) {
    const validCategories = ['Material', 'Salaries', 'Lab', 'Other'];
    if (!validCategories.includes(category)) {
      res.status(400);
      throw new Error('Category must be Material, Salaries, Lab, or Other');
    }
    expense.category = category;
  }

  if (date !== undefined) {
    const newDate = date ? new Date(date) : new Date();
    if (isNaN(newDate.getTime())) {
      res.status(400);
      throw new Error('Invalid date provided');
    }
    expense.date = newDate;
  }

  if (clinic_id !== undefined) {
    const clinic = await Clinic.findOne({ _id: clinic_id, dentist_id: dentistId });
    if (!clinic) {
      res.status(404);
      throw new Error('Clinic not found or you do not have access to it');
    }
    expense.clinic_id = clinic_id;
  }

  await expense.save();
  await expense.populate('clinic_id', 'name');

  analyticsCache.clear();
  res.json(expense);
});

// ── Delete Expense (soft) ─────────────────────
// DELETE /api/expenses/:id
const deleteExpense = asyncHandler(async (req, res) => {
  const dentistId = req.dentist._id;

  const expense = await Expense.findOne({
    _id: req.params.id,
    dentist_id: dentistId,
    isDeleted: { $ne: true },
  });

  if (!expense) {
    res.status(404);
    throw new Error('Expense not found');
  }

  expense.isDeleted = true;
  expense.deletedAt = new Date();
  await expense.save();

  analyticsCache.clear();
  res.json({ message: 'Expense removed', id: req.params.id });
});

// ── Get Expense Summary (aggregated) ──────────
// GET /api/expenses/summary?timeframe=monthly|yearly|all&clinic_id=...
const getExpenseSummary = asyncHandler(async (req, res) => {
  const dentistId = req.dentist._id;
  const { timeframe = 'monthly', clinic_id } = req.query;

  const now = new Date();
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

  const matchStage = {
    dentist_id: mongoose.Types.ObjectId.isValid(dentistId)
      ? new mongoose.Types.ObjectId(dentistId)
      : dentistId,
    date: { $gte: startDate, $lte: endDate },
    isDeleted: { $ne: true },
  };

  if (clinic_id) {
    matchStage.clinic_id = mongoose.Types.ObjectId.isValid(clinic_id)
      ? new mongoose.Types.ObjectId(clinic_id)
      : clinic_id;
  }

  const [byCategory, byClinic] = await Promise.all([
    Expense.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$category',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          category: '$_id',
          total: { $round: ['$total', 2] },
          count: 1,
        },
      },
      { $sort: { total: -1 } },
    ]),
    Expense.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$clinic_id',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
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
          total: { $round: ['$total', 2] },
          count: 1,
        },
      },
      { $sort: { total: -1 } },
    ]),
  ]);

  const totalExpenses = byCategory.reduce((sum, c) => sum + c.total, 0);

  res.json({
    timeframe,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    byCategory,
    byClinic,
  });
});

module.exports = {
  getExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseSummary,
};
