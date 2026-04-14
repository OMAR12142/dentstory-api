const asyncHandler = require('express-async-handler');
const Dentist = require('../models/Dentist');

// ── Get Insurance Providers ───────────────────
// GET /api/insurance
const getInsuranceProviders = asyncHandler(async (req, res) => {
  const dentist = await Dentist.findById(req.dentist._id).select('insuranceProviders');
  res.json(dentist?.insuranceProviders || ['Private']);
});

// ── Add Insurance Provider ────────────────────
// POST /api/insurance  { name: "InsuranceCo" }
const addInsuranceProvider = asyncHandler(async (req, res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    res.status(400);
    throw new Error('Insurance provider name is required');
  }

  const trimmed = name.trim();

  const dentist = await Dentist.findById(req.dentist._id);

  // Case-insensitive duplicate check
  const exists = dentist.insuranceProviders.some(
    (p) => p.toLowerCase() === trimmed.toLowerCase()
  );

  if (exists) {
    return res.json(dentist.insuranceProviders);
  }

  dentist.insuranceProviders.push(trimmed);
  await dentist.save();

  res.status(201).json(dentist.insuranceProviders);
});

// ── Delete Insurance Provider ─────────────────
// DELETE /api/insurance/:name
const deleteInsuranceProvider = asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name).trim();

  const dentist = await Dentist.findById(req.dentist._id);

  dentist.insuranceProviders = dentist.insuranceProviders.filter(
    (p) => p.toLowerCase() !== name.toLowerCase()
  );

  // Ensure at least 'Private' always remains
  if (dentist.insuranceProviders.length === 0) {
    dentist.insuranceProviders = ['Private'];
  }

  await dentist.save();

  res.json(dentist.insuranceProviders);
});

// ── Rename Insurance Provider ─────────────────
// PUT /api/insurance/:name  { newName: "NewInsuranceCo" }
const renameInsuranceProvider = asyncHandler(async (req, res) => {
  const oldName = decodeURIComponent(req.params.name).trim();
  const { newName } = req.body;

  if (!newName || !newName.trim()) {
    res.status(400);
    throw new Error('New name is required');
  }

  const trimmedNew = newName.trim();
  const dentist = await Dentist.findById(req.dentist._id);

  // Check if old name exists
  const idx = dentist.insuranceProviders.findIndex(
    (p) => p.toLowerCase() === oldName.toLowerCase()
  );

  if (idx === -1) {
    res.status(404);
    throw new Error('Insurance provider not found');
  }

  // Check for duplicate new name
  const dupIdx = dentist.insuranceProviders.findIndex(
    (p) => p.toLowerCase() === trimmedNew.toLowerCase()
  );

  if (dupIdx !== -1 && dupIdx !== idx) {
    res.status(409);
    throw new Error('An insurance provider with that name already exists');
  }

  dentist.insuranceProviders[idx] = trimmedNew;
  await dentist.save();

  res.json(dentist.insuranceProviders);
});

module.exports = {
  getInsuranceProviders,
  addInsuranceProvider,
  deleteInsuranceProvider,
  renameInsuranceProvider,
};
