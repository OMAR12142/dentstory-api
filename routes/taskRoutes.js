const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const {
  getTasks,
  createTask,
  toggleTaskCompletion,
  updateTask,
  deleteTask,
} = require('../controllers/taskController');

const router = express.Router();

// ── All routes protected ────────────────────
router.use(protect);

// ── Routes ──────────────────────────────────
router.get('/', getTasks);
router.post('/', createTask);
router.patch('/:id', toggleTaskCompletion);
router.put('/:id', updateTask);
router.delete('/:id', deleteTask);

module.exports = router;
