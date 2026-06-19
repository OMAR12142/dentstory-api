const express = require('express');
const router = express.Router();
const {
  getFixedSalaries,
  createFixedSalary,
  updateFixedSalary,
  deleteFixedSalary,
} = require('../controllers/fixedSalaryController');

const { protect } = require('../middleware/authMiddleware');

router.use(protect); // All fixed salary routes require authentication

router.route('/')
  .get(getFixedSalaries)
  .post(createFixedSalary);

router.route('/:id')
  .put(updateFixedSalary)
  .delete(deleteFixedSalary);

module.exports = router;
