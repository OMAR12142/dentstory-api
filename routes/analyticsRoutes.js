const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { getDashboardStats, getMonthlyEarnings, getTreatmentDistribution, getEarningsHistory } = require('../controllers/analyticsController');

const router = express.Router();

router.use(protect);
router.get('/dashboard-stats', getDashboardStats);
router.get('/monthly-earnings', getMonthlyEarnings);
router.get('/treatments', getTreatmentDistribution);
router.get('/earnings-history', getEarningsHistory);

module.exports = router;
