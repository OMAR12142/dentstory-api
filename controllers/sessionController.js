const mongoose = require('mongoose');
const asyncHandler = require('express-async-handler');
const Session = require('../models/Session');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');

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
    linked_appointment_id,
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
    if (!mongoose.Types.ObjectId.isValid(req.body.clinic_id)) {
      res.status(400);
      throw new Error('Invalid clinic ID provided');
    }
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

  // Auto-complete the linked appointment
  if (linked_appointment_id) {
    await Appointment.findOneAndUpdate(
      { _id: linked_appointment_id, dentist_id: req.dentist._id },
      { $set: { status: 'completed' } }
    );
  }

  // Sync with new Appointment calendar system
  let conflictWarning = false;
  if (next_appointment) {
    const aptDate = new Date(next_appointment);
    if (!isNaN(aptDate.getTime())) {
      const dateStr = aptDate.toISOString().split('T')[0];
      const hours = aptDate.getHours().toString().padStart(2, '0');
      const minutes = aptDate.getMinutes().toString().padStart(2, '0');
      const startTime = `${hours}:${minutes}`;

      const endAptDate = new Date(aptDate.getTime() + 30 * 60000); // 30 min default
      const endHours = endAptDate.getHours().toString().padStart(2, '0');
      const endMinutes = endAptDate.getMinutes().toString().padStart(2, '0');
      const endTime = `${endHours}:${endMinutes}`;

      // Check for conflicts
      const conflict = await Appointment.findOne({
        dentist_id: req.dentist._id,
        date: new Date(dateStr),
        isDeleted: { $ne: true },
        status: { $nin: ['cancelled', 'no-show'] },
        $or: [
          { startTime: { $lt: endTime }, endTime: { $gt: startTime } }
        ]
      });

      if (conflict) {
        conflictWarning = true;
      } else {
        const generatedApt = await Appointment.findOneAndUpdate(
          {
            dentist_id: req.dentist._id,
            patient_id,
            date: new Date(dateStr),
            startTime,
          },
          {
            $setOnInsert: {
              clinic_id: clinic._id,
              endTime,
              type: 'follow-up',
              status: 'scheduled',
            }
          },
          { upsert: true, new: true }
        );
        
        session.generated_appointment_id = generatedApt._id;
        await session.save();
      }
    }
  }

  res.status(201).json({ session, conflictWarning });
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
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const query = {
    patient_id,
    dentist_id: req.dentist._id,
    isDeleted: { $ne: true }
  };

  const [sessions, total, stats] = await Promise.all([
    Session.find(query)
      .populate('clinic_id', 'name')
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit),
    Session.countDocuments(query),
    Session.aggregate([
      {
        $match: {
          patient_id: new mongoose.Types.ObjectId(patient_id),
          dentist_id: req.dentist._id,
          isDeleted: { $ne: true }
        }
      },
      {
        $group: {
          _id: null,
          total_cost: { $sum: "$total_cost" },
          total_paid: { $sum: "$amount_paid" },
          total_cut: { $sum: "$dentist_cut" }
        }
      }
    ])
  ]);

  const financialSummary = stats[0] || { total_cost: 0, total_paid: 0, total_cut: 0 };

  res.json({
    sessions,
    page,
    pages: Math.ceil(total / limit),
    total,
    financialSummary
  });
});

// ── Update Session ────────────────────────────
// PUT /api/sessions/:id
const updateSession = asyncHandler(async (req, res) => {
  const session = await Session.findOne({
    _id: req.params.id,
    dentist_id: req.dentist._id,
    isDeleted: { $ne: true }
  });

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

  // Sanitize numeric inputs from multipart/form-data strings
  let total_cost = session.total_cost;
  if (req.body.total_cost !== undefined) {
    const parsed = parseFloat(req.body.total_cost);
    total_cost = isNaN(parsed) ? 0 : parsed;
    req.body.total_cost = total_cost; // Ensure numeric value for DB
  }

  let amount_paid = session.amount_paid;
  if (req.body.amount_paid !== undefined) {
    const parsed = parseFloat(req.body.amount_paid);
    amount_paid = isNaN(parsed) ? 0 : parsed;
    req.body.amount_paid = amount_paid; // Ensure numeric value for DB
  }

  if (
    req.body.total_cost !== undefined ||
    req.body.clinic_id !== undefined ||
    req.body.patient_id !== undefined
  ) {
    // Basic ID validation to prevent 500 CastError
    if (!mongoose.Types.ObjectId.isValid(clinic_id)) {
      res.status(400);
      throw new Error('Invalid clinic ID provided');
    }

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

  let conflictWarning = false;

  // Sync with new Appointment calendar system if next_appointment is provided/updated
  if (req.body.next_appointment !== undefined) {
    if (!req.body.next_appointment && session.generated_appointment_id) {
      // next_appointment was cleared -> cancel the generated appointment
      await Appointment.findByIdAndUpdate(session.generated_appointment_id, { status: 'cancelled' });
    } else if (req.body.next_appointment) {
      const aptDate = new Date(req.body.next_appointment);
      if (!isNaN(aptDate.getTime())) {
        const dateStr = aptDate.toISOString().split('T')[0];
        const hours = aptDate.getHours().toString().padStart(2, '0');
        const minutes = aptDate.getMinutes().toString().padStart(2, '0');
        const startTime = `${hours}:${minutes}`;

        const endAptDate = new Date(aptDate.getTime() + 30 * 60000);
        const endHours = endAptDate.getHours().toString().padStart(2, '0');
        const endMinutes = endAptDate.getMinutes().toString().padStart(2, '0');
        const endTime = `${endHours}:${endMinutes}`;

        // Check conflict (ignoring the generated appointment itself if it exists)
        const conflictQuery = {
          dentist_id: req.dentist._id,
          date: new Date(dateStr),
          isDeleted: { $ne: true },
          status: { $nin: ['cancelled', 'no-show', 'completed'] },
          $or: [
            { startTime: { $lt: endTime }, endTime: { $gt: startTime } }
          ]
        };
        if (session.generated_appointment_id) {
          conflictQuery._id = { $ne: session.generated_appointment_id };
        }

        const conflict = await Appointment.findOne(conflictQuery);

        if (conflict) {
          conflictWarning = true;
        } else {
          let generatedApt;
          if (session.generated_appointment_id) {
            // Update existing
            generatedApt = await Appointment.findByIdAndUpdate(
              session.generated_appointment_id,
              { date: new Date(dateStr), startTime, endTime, status: 'scheduled' },
              { new: true }
            );
          } else {
            // Create new
            generatedApt = await Appointment.create({
              dentist_id: req.dentist._id,
              patient_id: updatedSession.patient_id,
              clinic_id: updatedSession.clinic_id,
              date: new Date(dateStr),
              startTime,
              endTime,
              type: 'follow-up',
              status: 'scheduled',
            });
            updatedSession.generated_appointment_id = generatedApt._id;
            await updatedSession.save();
          }
        }
      }
    }
  }

  res.json({ session: updatedSession, conflictWarning });
});

// ── Delete Session ────────────────────────────
// DELETE /api/sessions/:id
const deleteSession = asyncHandler(async (req, res) => {
  const session = await Session.findOne({
    _id: req.params.id,
    dentist_id: req.dentist._id,
    isDeleted: { $ne: true }
  });

  if (!session) {
    res.status(404);
    throw new Error('Session not found or access denied');
  }

  // Soft delete the session
  session.isDeleted = true;
  session.deletedAt = new Date();
  await session.save();

  // If there's an auto-generated appointment, cancel it
  if (session.generated_appointment_id) {
    await Appointment.findOneAndUpdate(
      { _id: session.generated_appointment_id, dentist_id: req.dentist._id },
      { 
        $set: { 
          status: 'cancelled', 
          notes: 'Auto-cancelled: Associated clinical session was deleted.' 
        } 
      }
    );
  }

  res.json({ message: 'Session removed and associated appointment cancelled' });
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
    isDeleted: { $ne: true },
  })
    .populate('patient_id', 'name phone') // Get patient name and phone
    .sort({ next_appointment: 1 }) // Ascending: closest dates first
    .limit(10); // Limit to next 10 appointments

  res.json({ appointments });
});

// ── Get Sessions By Date ──────────────────────
// GET /api/sessions/by-date?date=2026-04-30
const getSessionsByDate = asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (!date) {
    res.status(400);
    throw new Error('date query parameter is required');
  }

  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const sessions = await Session.find({
    dentist_id: req.dentist._id,
    date: { $gte: dayStart, $lte: dayEnd },
    isDeleted: { $ne: true },
  })
    .populate('patient_id', 'name phone')
    .populate('clinic_id', 'name')
    .sort({ date: 1 })
    .lean();

  res.json(sessions);
});

module.exports = { createSession, getSessionsByPatient, updateSession, deleteSession, getUpcomingAppointments, getSessionsByDate };
