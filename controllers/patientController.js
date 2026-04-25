const asyncHandler = require('express-async-handler');
const Patient = require('../models/Patient');
const Clinic = require('../models/Clinic');

// ── Create Patient ────────────────────────────
// POST /api/patients
const createPatient = asyncHandler(async (req, res) => {
  const { clinic_id, commission_percentage, ...rest } = req.body;

  if (!clinic_id) {
    res.status(400);
    throw new Error('Clinic is required when creating a patient');
  }

  // Verify clinic belongs to this dentist
  const clinic = await Clinic.findOne({ _id: clinic_id, dentist_id: req.dentist._id });
  if (!clinic) {
    res.status(403);
    throw new Error('Clinic not found or access denied');
  }

  // Use body value if provided (dentist override), otherwise copy from clinic default
  const resolvedCommission =
    commission_percentage !== undefined && commission_percentage !== ''
      ? parseFloat(commission_percentage)
      : clinic.default_commission_percentage;

  const patient = await Patient.create({
    ...rest,
    dentist_id: req.dentist._id,
    clinic_id: clinic._id,
    commission_percentage: resolvedCommission,
  });

  res.status(201).json(patient);
});


// ── Get All Patients (paginated) ──────────────
// GET /api/patients?page=1&limit=10&search=&status=&clinic_id=&sortBy=
const getPatients = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  const skip = (page - 1) * limit;

  const { search, status, clinic_id, sortBy, dateFrom, dateTo } = req.query;

  // ── Build Filter ──────────────────────────────
  const filter = { dentist_id: req.dentist._id, isDeleted: { $ne: true } };

  if (clinic_id) {
    filter.clinic_id = clinic_id;
  }

  if (status && status !== 'All Patients') {
    filter.status = status;
  }

  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom && dateTo) {
      // Range: from dateFrom 00:00 to dateTo 23:59
      const from = new Date(dateFrom);
      from.setHours(0, 0, 0, 0);
      filter.createdAt.$gte = from;

      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = to;
    } else if (dateFrom) {
      // Single day: from dateFrom 00:00 to dateFrom 23:59
      const from = new Date(dateFrom);
      from.setHours(0, 0, 0, 0);
      filter.createdAt.$gte = from;

      const to = new Date(dateFrom);
      to.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = to;
    } else if (dateTo) {
      // Until day: from beginning of time to dateTo 23:59
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = to;
    }
  }

  if (search) {
    const searchRegex = new RegExp(search, 'i');
    filter.$or = [
      { name: searchRegex },
      { phone: searchRegex },
      { phone2: searchRegex },
      { address: searchRegex },
      { job: searchRegex },
      { insuranceCompany: searchRegex },
      { medical_history: { $elemMatch: { $regex: searchRegex } } }
    ];
  }

  // ── Build Sort ──────────────────────────────
  let sort = { createdAt: -1 }; // Default
  if (sortBy === 'name') sort = { name: 1 };
  else if (sortBy === 'age_low') sort = { age: 1, dateOfBirth: -1 };
  else if (sortBy === 'age_high') sort = { age: -1, dateOfBirth: 1 };

  const [patients, total] = await Promise.all([
    Patient.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('clinic_id', 'name default_commission_percentage')
      .lean(),
    Patient.countDocuments(filter),
  ]);

  res.json({
    patients,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    totalPatients: total,
  });
});

// ── Get Patient by ID ─────────────────────────
// GET /api/patients/:id
const getPatientById = asyncHandler(async (req, res) => {
  const patient = await Patient.findOne({
    _id: req.params.id,
    dentist_id: req.dentist._id,
    isDeleted: { $ne: true },
  }).populate('clinic_id', 'name default_commission_percentage');

  if (!patient) {
    res.status(404);
    throw new Error('Patient not found or access denied');
  }

  res.json(patient);
});

// ── Update Patient ────────────────────────────
// PUT /api/patients/:id
const updatePatient = asyncHandler(async (req, res) => {
  const { clinic_id, commission_percentage, ...rest } = req.body;

  const updatePayload = { ...rest };

  if (clinic_id !== undefined) {
    if (clinic_id === null || clinic_id === '') {
      // Allow clearing the clinic
      updatePayload.clinic_id = null;
      updatePayload.commission_percentage = null;
    } else {
      // Verify clinic belongs to this dentist
      const clinic = await Clinic.findOne({ _id: clinic_id, dentist_id: req.dentist._id });
      if (!clinic) {
        res.status(403);
        throw new Error('Clinic not found or access denied');
      }
      updatePayload.clinic_id = clinic._id;
      // Use the body value if provided, otherwise copy from clinic default
      updatePayload.commission_percentage =
        commission_percentage !== undefined && commission_percentage !== ''
          ? parseFloat(commission_percentage)
          : clinic.default_commission_percentage;
    }
  } else if (commission_percentage !== undefined && commission_percentage !== '') {
    // Allow updating commission independently (without changing clinic)
    updatePayload.commission_percentage = parseFloat(commission_percentage);
  }

  // ── Special handling for treatment_plan & notes arrays ──
  // Mongoose subdocument arrays with auto _id need explicit $set to properly replace/shrink
  let treatmentPlanOverride = null;
  let notesOverride = null;

  if (updatePayload.treatment_plan !== undefined) {
    treatmentPlanOverride = updatePayload.treatment_plan;
    delete updatePayload.treatment_plan;
  }
  if (updatePayload.notes !== undefined) {
    notesOverride = updatePayload.notes;
    delete updatePayload.notes;
  }

  // Build the final update operation
  const updateOp = { ...updatePayload };
  if (treatmentPlanOverride !== null) {
    updateOp.treatment_plan = treatmentPlanOverride;
  }
  if (notesOverride !== null) {
    updateOp.notes = notesOverride;
  }

  const patient = await Patient.findOneAndUpdate(
    { _id: req.params.id, dentist_id: req.dentist._id },
    { $set: updateOp },
    { new: true, runValidators: true }
  ).populate('clinic_id', 'name default_commission_percentage');

  if (!patient) {
    res.status(404);
    throw new Error('Patient not found or access denied');
  }

  res.json(patient);
});

// ── Delete Patient ────────────────────────────
// DELETE /api/patients/:id
const deletePatient = asyncHandler(async (req, res) => {
  const patient = await Patient.findOneAndUpdate(
    {
      _id: req.params.id,
      dentist_id: req.dentist._id,
      isDeleted: { $ne: true },
    },
    {
      $set: { isDeleted: true, deletedAt: new Date() },
    },
    { new: true }
  );

  if (!patient) {
    res.status(404);
    throw new Error('Patient not found or access denied');
  }

  res.json({ message: 'Patient removed successfully' });
});

module.exports = { createPatient, getPatients, getPatientById, updatePatient, deletePatient };
