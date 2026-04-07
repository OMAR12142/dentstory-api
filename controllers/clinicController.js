const asyncHandler = require('express-async-handler');
const Clinic = require('../models/Clinic');

// ── Create Clinic ─────────────────────────────
// POST /api/clinics
const createClinic = asyncHandler(async (req, res) => {
  const { name, address, default_commission_percentage, working_days } = req.body;

  if (!name) {
    res.status(400);
    throw new Error('Clinic name is required');
  }

  if (default_commission_percentage === undefined || default_commission_percentage === null) {
    res.status(400);
    throw new Error('Commission percentage is required');
  }

  const clinic = await Clinic.create({
    dentist_id: req.dentist._id,
    name,
    address,
    default_commission_percentage,
    working_days: working_days || [],
  });

  res.status(201).json(clinic);
});

// ── Get All Clinics ───────────────────────────
// GET /api/clinics
const getClinics = asyncHandler(async (req, res) => {
  const clinics = await Clinic.find({ dentist_id: req.dentist._id }).sort({ createdAt: -1 });
  res.json({ clinics });
});

// ── Update Clinic ──────────────────────────────
// PUT /api/clinics/:id
const updateClinic = asyncHandler(async (req, res) => {
  const clinic = await Clinic.findById(req.params.id);

  if (!clinic) {
    res.status(404);
    throw new Error('Clinic not found');
  }

  // Verify ownership
  if (clinic.dentist_id.toString() !== req.dentist._id.toString()) {
    res.status(403);
    throw new Error('You do not have access to this clinic');
  }

  const { name, address, default_commission_percentage, working_days } = req.body;

  // Update allowed fields
  if (name !== undefined) clinic.name = name;
  if (address !== undefined) clinic.address = address;
  if (default_commission_percentage !== undefined)
    clinic.default_commission_percentage = default_commission_percentage;
  if (working_days !== undefined) clinic.working_days = working_days;

  await clinic.save();

  res.json(clinic);
});

// ── Delete Clinic ──────────────────────────────
// DELETE /api/clinics/:id
const deleteClinic = asyncHandler(async (req, res) => {
  const clinic = await Clinic.findOneAndDelete({ _id: req.params.id, dentist_id: req.dentist._id });

  if (!clinic) {
    res.status(404);
    throw new Error('Clinic not found or access denied');
  }

  res.json({ message: 'Clinic removed successfully' });
});

module.exports = { createClinic, getClinics, updateClinic, deleteClinic };
