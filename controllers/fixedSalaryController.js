const asyncHandler = require('express-async-handler');
const FixedSalary = require('../models/FixedSalary');
const Clinic = require('../models/Clinic');
const { analyticsCache } = require('../utils/cache');

/**
 * @desc    Get all fixed salaries for current dentist
 * @route   GET /api/fixed-salaries
 * @access  Private
 */
const getFixedSalaries = asyncHandler(async (req, res) => {
  const salaries = await FixedSalary.find({ dentist_id: req.dentist._id })
    .populate('clinic_id', 'name')
    .sort('-createdAt');

  res.status(200).json(salaries);
});

/**
 * @desc    Create a fixed salary for a clinic
 * @route   POST /api/fixed-salaries
 * @access  Private
 */
const createFixedSalary = asyncHandler(async (req, res) => {
  const { clinic_id, amount, salary_day } = req.body;

  // Validate inputs
  if (!clinic_id || amount === undefined || !salary_day) {
    res.status(400);
    throw new Error('Please provide clinic_id, amount, and salary_day');
  }

  // Verify clinic belongs to dentist
  const clinic = await Clinic.findOne({ _id: clinic_id, dentist_id: req.dentist._id });
  if (!clinic) {
    res.status(404);
    throw new Error('Clinic not found or does not belong to you');
  }

  // Check if a fixed salary already exists for this clinic
  const exists = await FixedSalary.findOne({ dentist_id: req.dentist._id, clinic_id });
  if (exists) {
    res.status(400);
    throw new Error('A fixed salary already exists for this clinic');
  }

  const fixedSalary = await FixedSalary.create({
    dentist_id: req.dentist._id,
    clinic_id,
    amount: Number(amount),
    salary_day: Number(salary_day),
  });

  analyticsCache.clear();
  res.status(201).json(fixedSalary);
});

/**
 * @desc    Update a fixed salary
 * @route   PUT /api/fixed-salaries/:id
 * @access  Private
 */
const updateFixedSalary = asyncHandler(async (req, res) => {
  const { amount, salary_day } = req.body;

  let fixedSalary = await FixedSalary.findOne({ _id: req.params.id, dentist_id: req.dentist._id });

  if (!fixedSalary) {
    res.status(404);
    throw new Error('Fixed salary record not found');
  }

  if (amount !== undefined) {
    const amt = Number(amount);
    if (isNaN(amt) || amt < 0 || amount === '') {
      res.status(400);
      throw new Error('Valid amount >= 0 is required');
    }
    fixedSalary.amount = amt;
  }
  
  if (salary_day !== undefined) {
    const day = Number(salary_day);
    if (isNaN(day) || day < 1 || day > 28 || salary_day === '') {
      res.status(400);
      throw new Error('Valid salary day between 1 and 28 is required');
    }
    fixedSalary.salary_day = day;
  }

  await fixedSalary.save();

  analyticsCache.clear();
  res.status(200).json(fixedSalary);
});

/**
 * @desc    Delete a fixed salary
 * @route   DELETE /api/fixed-salaries/:id
 * @access  Private
 */
const deleteFixedSalary = asyncHandler(async (req, res) => {
  const fixedSalary = await FixedSalary.findOne({ _id: req.params.id, dentist_id: req.dentist._id });

  if (!fixedSalary) {
    res.status(404);
    throw new Error('Fixed salary record not found');
  }

  await fixedSalary.deleteOne();

  analyticsCache.clear();
  res.status(200).json({ message: 'Fixed salary record removed', id: req.params.id });
});

module.exports = {
  getFixedSalaries,
  createFixedSalary,
  updateFixedSalary,
  deleteFixedSalary,
};
