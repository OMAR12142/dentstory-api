const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { uploadImages } = require('../middleware/uploadMiddleware');
const {
  createSession,
  getSessionsByPatient,
  updateSession,
  deleteSession,
  getUpcomingAppointments,
} = require('../controllers/sessionController');

const router = express.Router();

// ── Routes (all protected) ────────────────────
router.use(protect);

// ── Specific routes BEFORE /:id ────────────────
router.get('/upcoming', getUpcomingAppointments);

// ── Generic routes ────────────────────────────
router.route('/')
  .post(uploadImages, createSession)
  .get(getSessionsByPatient);
router.route('/:id')
  .put(uploadImages, updateSession)
  .delete(deleteSession);

module.exports = router;
