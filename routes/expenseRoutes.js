const express = require('express');
const router = express.Router();
const {
  getExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseSummary,
} = require('../controllers/expenseController');

const { protect } = require('../middleware/authMiddleware');

router.use(protect); // All expense routes require authentication

router.get('/summary', getExpenseSummary); // Must be before /:id
router.route('/')
  .get(getExpenses)
  .post(createExpense);

router.route('/:id')
  .put(updateExpense)
  .delete(deleteExpense);

module.exports = router;
