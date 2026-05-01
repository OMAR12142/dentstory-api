const express = require('express');
const router = express.Router();
const { protect, isAdmin } = require('../middleware/authMiddleware');
const {
  getPlatformStats,
  getAllDentists,
  toggleDentistStatus,
  getRevenueStats,
  getDentistProfile,
  resetDentistPassword,
  impersonateDentist,
  togglePortfolioSuspension,
} = require('../controllers/adminController');
const {
  createAnnouncement,
  getAllAnnouncements,
  toggleAnnouncement,
  deleteAnnouncement,
} = require('../controllers/announcementController');

// ── Apply auth + admin guard to every route in this file ──
router.use(protect);
router.use(isAdmin);

// ── Admin endpoints ───────────────────────────────────────
// Announcements
router.get('/announcements', getAllAnnouncements);
router.post('/announcements', createAnnouncement);
router.patch('/announcements/:id/toggle', toggleAnnouncement);
router.delete('/announcements/:id', deleteAnnouncement);

// Stats & Users
router.get('/stats', getPlatformStats);

// GET /api/admin/revenue   → revenue dashboard data
router.get('/revenue', getRevenueStats);

// GET /api/admin/dentists  → all dentists (with search & counts)
router.get('/dentists', getAllDentists);

// GET /api/admin/dentists/:id → single dentist detail (drill-down)
router.get('/dentists/:id', getDentistProfile);

// PATCH /api/admin/dentists/:id/status → toggle active/suspended
router.patch('/dentists/:id/status', toggleDentistStatus);

// POST /api/admin/dentists/:id/reset-password → force password reset
router.post('/dentists/:id/reset-password', resetDentistPassword);

// POST /api/admin/dentists/:id/impersonate → shadow access
router.post('/dentists/:id/impersonate', impersonateDentist);

// PATCH /api/admin/dentists/:id/portfolio-status → toggle portfolio suspension
router.patch('/dentists/:id/portfolio-status', togglePortfolioSuspension);

module.exports = router;
