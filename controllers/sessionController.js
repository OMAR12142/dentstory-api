const asyncHandler = require('express-async-handler');
const Session = require('../models/Session');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');

// ── Create Session ────────────────────────────
// POST /api/sessions  (multipart/form-data)
const createSession = asyncHandler(async (req, res) => {
  const {
    patient_id,
    date,
    treatment_category,
    treatment_details,
    total_cost,
    amount_paid,
    next_appointment,
  } = req.body;

  // 1. Fetch patient and verify ownership
  const patient = await Patient.findById(patient_id).populate('clinic_id');
  if (!patient || patient.dentist_id.toString() !== req.dentist._id.toString()) {
    res.status(403);
    throw new Error('Patient not found or access denied');
  }

  // 2. Resolve clinic from patient record
  //    If the patient has no clinic yet, fall back to accepting clinic_id from body
  //    (for backward compatibility and patients without a clinic assigned)
  let clinic = patient.clinic_id; // populated doc or null

  if (!clinic && req.body.clinic_id) {
    clinic = await Clinic.findById(req.body.clinic_id);
    if (!clinic || clinic.dentist_id.toString() !== req.dentist._id.toString()) {
      res.status(403);
      throw new Error('Clinic not found or access denied');
    }
  }

  if (!clinic) {
    res.status(400);
    throw new Error('No clinic assigned to this patient. Please edit the patient and assign a clinic first.');
  }

  // 3. Collect Cloudinary secure_urls from uploaded files (limit total to 5)
  let media_urls = req.files ? req.files.map((f) => f.path) : [];
  if (media_urls.length > 5) {
    media_urls = media_urls.slice(0, 5);
  }

  // 4. Auto-calculate dentist_cut using patient's commission (with clinic default as fallback)
  const cost = parseFloat(total_cost) || 0;
  const paid = parseFloat(amount_paid) || 0;
  const commissionRate =
    patient.commission_percentage !== null && patient.commission_percentage !== undefined
      ? patient.commission_percentage
      : clinic.default_commission_percentage;

  const dentist_cut = cost * (commissionRate / 100);

  // Parse treatment_category from JSON string (sent via FormData)
  let parsedCategories = treatment_category;
  if (typeof treatment_category === 'string') {
    try {
      parsedCategories = JSON.parse(treatment_category);
    } catch {
      // Legacy single string - wrap in array
      parsedCategories = treatment_category ? [treatment_category] : [];
    }
  }

  const session = await Session.create({
    dentist_id: req.dentist._id,
    patient_id,
    clinic_id: clinic._id,   // sessions still store clinic_id → analytics unchanged
    date,
    treatment_category: parsedCategories,
    treatment_details,
    media_urls,
    total_cost: cost,
    amount_paid: paid,
    remaining_balance: cost - paid,
    dentist_cut,
    next_appointment,
  });

  res.status(201).json(session);
});


// ── Get Sessions for Patient ──────────────────
// GET /api/sessions?patient_id=...
const getSessionsByPatient = asyncHandler(async (req, res) => {
  const { patient_id } = req.query;

  if (!patient_id) {
    res.status(400);
    throw new Error('patient_id is required');
  }

  // 1. Verify patient exists and belongs to the authenticated dentist
  const patient = await Patient.findById(patient_id);
  if (!patient || patient.dentist_id.toString() !== req.dentist._id.toString()) {
    res.status(403);
    throw new Error('Patient not found or access denied');
  }

  // 2. Query sessions by both patient_id AND dentist_id for strict ownership.
  // Patient ownership is already verified above, but we also enforce dentist_id
  // to ensure legacy sessions without dentist_id are properly migrated.
  const sessions = await Session.find({ patient_id, dentist_id: req.dentist._id })
  .populate('clinic_id', 'name') // helpful for the frontend to show clinic name
  .sort({ date: -1 });

  res.json({ sessions });
});

// ── Update Session ────────────────────────────
// PUT /api/sessions/:id
const updateSession = asyncHandler(async (req, res) => {
  const session = await Session.findOne({ _id: req.params.id, dentist_id: req.dentist._id });

  if (!session) {
    res.status(404);
    throw new Error('Session not found or access denied');
  }

  // Verify patient ownership if patient_id is being updated
  if (req.body.patient_id && req.body.patient_id !== session.patient_id.toString()) {
    const patient = await Patient.findById(req.body.patient_id);
    if (!patient || patient.dentist_id.toString() !== req.dentist._id.toString()) {
      res.status(403);
      throw new Error('Patient not found or access denied');
    }
  }

  // Re-calculate dentist_cut if total_cost or clinic_id changed
  const clinic_id = req.body.clinic_id || session.clinic_id;
  const total_cost =
    req.body.total_cost !== undefined
      ? parseFloat(req.body.total_cost)
      : session.total_cost;
  const amount_paid =
    req.body.amount_paid !== undefined
      ? parseFloat(req.body.amount_paid)
      : session.amount_paid;

  if (
    req.body.total_cost !== undefined ||
    req.body.clinic_id !== undefined ||
    req.body.patient_id !== undefined
  ) {
    const clinic = await Clinic.findById(clinic_id);
    if (!clinic || clinic.dentist_id.toString() !== req.dentist._id.toString()) {
      res.status(403);
      throw new Error('Clinic not found or access denied');
    }

    // Refetch patient to get their specific commission
    const patient = await Patient.findById(req.body.patient_id || session.patient_id);
    const commissionRate =
      patient?.commission_percentage !== null && patient?.commission_percentage !== undefined
        ? patient.commission_percentage
        : clinic.default_commission_percentage;

    req.body.dentist_cut = total_cost * (commissionRate / 100);
  }

  req.body.remaining_balance = total_cost - amount_paid;

  // Handle media updates (existing + new)
  if (req.body.existing_media !== undefined || (req.files && req.files.length > 0)) {
    let baseMedia = [];
    
    // If existing_media is provided (even if empty string or empty array), we use it.
    // If it's NOT provided in the request body at all, we fall back to current session state.
    if (req.body.existing_media !== undefined) {
      try {
        if (typeof req.body.existing_media === 'string') {
          baseMedia = JSON.parse(req.body.existing_media);
        } else {
          baseMedia = Array.isArray(req.body.existing_media) ? req.body.existing_media : [req.body.existing_media];
        }
      } catch (e) {
        // Fallback for non-JSON strings
        baseMedia = req.body.existing_media ? [req.body.existing_media] : [];
      }
    } else {
      baseMedia = session.media_urls || [];
    }

    const newMediaUrls = req.files ? req.files.map((f) => f.path) : [];
    let combinedMedia = [...baseMedia, ...newMediaUrls];
    
    // Enforce 5 image limit
    if (combinedMedia.length > 5) {
      combinedMedia = combinedMedia.slice(0, 5);
    }
    
    req.body.media_urls = combinedMedia;
  }

  // Parse treatment_category from JSON string if present
  if (req.body.treatment_category && typeof req.body.treatment_category === 'string') {
    try {
      req.body.treatment_category = JSON.parse(req.body.treatment_category);
    } catch {
      // Legacy single string - wrap in array
      req.body.treatment_category = req.body.treatment_category ? [req.body.treatment_category] : [];
    }
  }

  const updatedSession = await Session.findOneAndUpdate(
    { _id: req.params.id, dentist_id: req.dentist._id },
    req.body,
    { new: true, runValidators: true }
  );

  res.json(updatedSession);
});

// ── Delete Session ────────────────────────────
// DELETE /api/sessions/:id
const deleteSession = asyncHandler(async (req, res) => {
  const session = await Session.findOneAndDelete({ _id: req.params.id, dentist_id: req.dentist._id });

  if (!session) {
    res.status(404);
    throw new Error('Session not found or access denied');
  }

  res.json({ message: 'Session removed successfully' });
});

// ── Get Upcoming Appointments ─────────────────
// GET /api/sessions/upcoming
const getUpcomingAppointments = asyncHandler(async (req, res) => {
  // Get all clinics belonging to the logged-in dentist
  const dentistClinics = await Clinic.find({ dentist_id: req.dentist._id })
    .select('_id')
    .lean();
  const clinicIds = dentistClinics.map((c) => c._id);

  // Query sessions with next_appointment >= today
  const now = new Date();
  const appointments = await Session.find({
    clinic_id: { $in: clinicIds },
    next_appointment: { $gte: now },
  })
    .populate('patient_id', 'name phone') // Get patient name and phone
    .sort({ next_appointment: 1 }) // Ascending: closest dates first
    .limit(10); // Limit to next 10 appointments

  res.json({ appointments });
});

module.exports = { createSession, getSessionsByPatient, updateSession, deleteSession, getUpcomingAppointments };
