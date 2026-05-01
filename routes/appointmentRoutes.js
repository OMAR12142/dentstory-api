const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getAppointments,
  getTodaysAppointments,
  getPatientAppointments,
  createAppointment,
  updateAppointment,
  updateAppointmentStatus,
  deleteAppointment,
} = require('../controllers/appointmentController');

// All routes require authentication
router.use(protect);

// ── Appointment endpoints ─────────────────────
router.get('/', getAppointments);
router.get('/today', getTodaysAppointments);
router.get('/patient/:patientId', getPatientAppointments);
router.post('/', createAppointment);
router.put('/:id', updateAppointment);
router.patch('/:id/status', updateAppointmentStatus);
router.delete('/:id', deleteAppointment);

module.exports = router;
