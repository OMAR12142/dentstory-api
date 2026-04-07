const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/authMiddleware');
const {
  getPlatformStats,
  getAllDentists,
  toggleDentistStatus,
  getRevenueStats,
  getDentistProfile,
} = require('../controllers/adminController');

// ── Apply auth + admin guard to every route in this file ──
router.use(protect);
router.use(isAdmin);

// ── Admin endpoints ───────────────────────────────────────
// GET /api/admin/stats     → platform-wide statistics
router.get('/stats', getPlatformStats);

// GET /api/admin/revenue   → revenue dashboard data
router.get('/revenue', getRevenueStats);

// GET /api/admin/dentists  → all dentists (with search & counts)
router.get('/dentists', getAllDentists);

// GET /api/admin/dentists/:id → single dentist detail (drill-down)
router.get('/dentists/:id', getDentistProfile);

// PATCH /api/admin/dentists/:id/status → toggle active/suspended
router.patch('/dentists/:id/status', toggleDentistStatus);

module.exports = router;
