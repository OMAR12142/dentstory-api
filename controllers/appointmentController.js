const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');

// ── Helpers ──────────────────────────────────────

/**
 * Check if two time ranges overlap.
 * Times are "HH:mm" strings. Overlap when newStart < existingEnd AND newEnd > existingStart.
 */
function timesOverlap(newStart, newEnd, existingStart, existingEnd) {
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  return toMin(newStart) < toMin(existingEnd) && toMin(newEnd) > toMin(existingStart);
}

/**
 * Detect scheduling conflicts for a dentist at a specific clinic on a given date.
 * Excludes cancelled/no-show appointments from conflict checks.
 * Returns the conflicting appointment if found, or null.
 */
async function findConflict(dentistId, clinicId, date, startTime, endTime, excludeId = null) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const query = {
    dentist_id: dentistId,
    clinic_id: clinicId,
    date: { $gte: dayStart, $lte: dayEnd },
    status: { $nin: ['cancelled', 'no-show'] },
  };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const existing = await Appointment.find(query)
    .populate('patient_id', 'name')
    .lean();

  return existing.find((apt) => timesOverlap(startTime, endTime, apt.startTime, apt.endTime)) || null;
}

// ════════════════════════════════════════════════
// ENDPOINTS
// ════════════════════════════════════════════════

/**
 * GET /api/appointments
 * Get appointments for a date range (calendar view).
 * Query params: start, end, clinic_id (optional)
 */
const getAppointments = asyncHandler(async (req, res) => {
  const { start, end, clinic_id } = req.query;

  if (!start || !end) {
    res.status(400);
    throw new Error('Start and end date are required');
  }

  const query = {
    dentist_id: req.dentist._id,
    date: {
      $gte: new Date(start),
      $lte: new Date(end),
    },
  };

  if (clinic_id) {
    query.clinic_id = clinic_id;
  }

  const appointments = await Appointment.find(query)
    .populate('patient_id', 'name phone')
    .populate('clinic_id', 'name')
    .sort({ date: 1, startTime: 1 })
    .lean();

  res.json(appointments);
});

/**
 * GET /api/appointments/today
 * Get today's schedule for the Dashboard widget.
 */
const getTodaysAppointments = asyncHandler(async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const appointments = await Appointment.find({
    dentist_id: req.dentist._id,
    date: { $gte: today, $lt: tomorrow },
    status: { $nin: ['cancelled', 'no-show'] },
  })
    .populate('patient_id', 'name phone')
    .populate('clinic_id', 'name')
    .sort({ startTime: 1 })
    .lean();

  res.json(appointments);
});

/**
 * GET /api/appointments/patient/:patientId
 * Get upcoming appointments for a specific patient.
 */
const getPatientAppointments = asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const appointments = await Appointment.find({
    dentist_id: req.dentist._id,
    patient_id: patientId,
    date: { $gte: today },
    status: { $nin: ['cancelled', 'no-show'] },
  })
    .populate('clinic_id', 'name')
    .sort({ date: 1, startTime: 1 })
    .lean();

  res.json(appointments);
});

/**
 * POST /api/appointments
 * Create a new appointment with conflict detection.
 */
const createAppointment = asyncHandler(async (req, res) => {
  const { patient_id, clinic_id, date, startTime, endTime, type, notes } = req.body;

  if (!patient_id || !clinic_id || !date || !startTime || !endTime) {
    res.status(400);
    throw new Error('Patient, clinic, date, start time, and end time are required');
  }

  // Validate time order
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  if (toMin(startTime) >= toMin(endTime)) {
    res.status(400);
    throw new Error('End time must be after start time');
  }

  // Conflict check
  const conflict = await findConflict(req.dentist._id, clinic_id, date, startTime, endTime);
  if (conflict) {
    return res.status(409).json({
      message: `Time conflict: You already have an appointment with ${conflict.patient_id?.name || 'a patient'} from ${conflict.startTime} to ${conflict.endTime}`,
      conflict,
    });
  }

  const appointment = await Appointment.create({
    dentist_id: req.dentist._id,
    patient_id,
    clinic_id,
    date: new Date(date),
    startTime,
    endTime,
    type: type || 'consultation',
    notes: notes || '',
  });

  const populated = await Appointment.findById(appointment._id)
    .populate('patient_id', 'name phone')
    .populate('clinic_id', 'name');

  res.status(201).json(populated);
});

/**
 * PUT /api/appointments/:id
 * Update an appointment (reschedule, edit details).
 */
const updateAppointment = asyncHandler(async (req, res) => {
  const appointment = await Appointment.findOne({
    _id: req.params.id,
    dentist_id: req.dentist._id,
  });

  if (!appointment) {
    res.status(404);
    throw new Error('Appointment not found');
  }

  const { patient_id, clinic_id, date, startTime, endTime, type, notes, status } = req.body;

  // If rescheduling, check for conflicts
  const newDate = date || appointment.date;
  const newStart = startTime || appointment.startTime;
  const newEnd = endTime || appointment.endTime;
  const newClinic = clinic_id || appointment.clinic_id;

  if (date || startTime || endTime || clinic_id) {
    const toMin = (t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    if (toMin(newStart) >= toMin(newEnd)) {
      res.status(400);
      throw new Error('End time must be after start time');
    }

    const conflict = await findConflict(
      req.dentist._id, newClinic, newDate, newStart, newEnd, appointment._id
    );
    if (conflict) {
      return res.status(409).json({
        message: `Time conflict: You already have an appointment with ${conflict.patient_id?.name || 'a patient'} from ${conflict.startTime} to ${conflict.endTime}`,
        conflict,
      });
    }
  }

  // Apply updates
  if (patient_id) appointment.patient_id = patient_id;
  if (clinic_id) appointment.clinic_id = clinic_id;
  if (date) appointment.date = new Date(date);
  if (startTime) appointment.startTime = startTime;
  if (endTime) appointment.endTime = endTime;
  if (type) appointment.type = type;
  if (notes !== undefined) appointment.notes = notes;
  if (status) appointment.status = status;

  await appointment.save();

  const populated = await Appointment.findById(appointment._id)
    .populate('patient_id', 'name phone')
    .populate('clinic_id', 'name');

  res.json(populated);
});

/**
 * PATCH /api/appointments/:id/status
 * Quick status toggle (e.g., scheduled → completed).
 */
const updateAppointmentStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;

  if (!status) {
    res.status(400);
    throw new Error('Status is required');
  }

  const appointment = await Appointment.findOneAndUpdate(
    { _id: req.params.id, dentist_id: req.dentist._id },
    { status },
    { new: true }
  )
    .populate('patient_id', 'name phone')
    .populate('clinic_id', 'name');

  if (!appointment) {
    res.status(404);
    throw new Error('Appointment not found');
  }

  res.json(appointment);
});

/**
 * DELETE /api/appointments/:id
 * Delete an appointment.
 */
const deleteAppointment = asyncHandler(async (req, res) => {
  const appointment = await Appointment.findOneAndDelete({
    _id: req.params.id,
    dentist_id: req.dentist._id,
  });

  if (!appointment) {
    res.status(404);
    throw new Error('Appointment not found');
  }

  res.json({ message: 'Appointment deleted successfully' });
});

module.exports = {
  getAppointments,
  getTodaysAppointments,
  getPatientAppointments,
  createAppointment,
  updateAppointment,
  updateAppointmentStatus,
  deleteAppointment,
};
