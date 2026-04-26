const express = require('express');
const router = express.Router();
const { getActiveAnnouncement } = require('../controllers/announcementController');

// GET /api/announcements/active → get the current system-wide active announcement
router.get('/active', getActiveAnnouncement);

module.exports = router;
