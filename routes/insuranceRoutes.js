const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const {
  getInsuranceProviders,
  addInsuranceProvider,
  deleteInsuranceProvider,
  renameInsuranceProvider,
} = require('../controllers/insuranceController');

const router = express.Router();

// ── All routes require auth ───────────────────
router.use(protect);

router.route('/')
  .get(getInsuranceProviders)
  .post(addInsuranceProvider);

router.route('/:name')
  .put(renameInsuranceProvider)
  .delete(deleteInsuranceProvider);

module.exports = router;
