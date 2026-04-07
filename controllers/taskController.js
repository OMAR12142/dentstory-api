const asyncHandler = require('express-async-handler');
const Task = require('../models/Task');
const Clinic = require('../models/Clinic');

// ── Get all tasks for logged-in dentist ────
// GET /api/tasks
const getTasks = asyncHandler(async (req, res) => {
  const tasks = await Task.find({ dentist_id: req.dentist._id })
    .populate('clinic_id', 'name')
    .populate('patient_id', 'name phone')
    .sort({ createdAt: -1 });

  res.json({ tasks });
});

// ── Create task ────────────────────────────
// POST /api/tasks
const createTask = asyncHandler(async (req, res) => {
  const { text, type, clinic_id, patient_id, dueDate } = req.body;

  if (!text) {
    res.status(400);
    throw new Error('Task text is required');
  }

  // Verify clinic ownership if provided
  if (clinic_id) {
    const clinic = await Clinic.findById(clinic_id);
    if (!clinic || clinic.dentist_id.toString() !== req.dentist._id.toString()) {
      res.status(403);
      throw new Error('You do not have access to this clinic');
    }
  }

  const task = await Task.create({
    dentist_id: req.dentist._id,
    clinic_id: clinic_id || null,
    patient_id: patient_id || null,
    text,
    type: type || 'General',
    dueDate: dueDate || null,
    isCompleted: false,
  });

  // Populate references
  await task.populate('clinic_id', 'name');
  await task.populate('patient_id', 'name phone');

  res.status(201).json(task);
});

// ── Toggle task completion ─────────────────
// PATCH /api/tasks/:id
const toggleTaskCompletion = asyncHandler(async (req, res) => {
  const task = await Task.findById(req.params.id);

  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }

  // Verify ownership
  if (task.dentist_id.toString() !== req.dentist._id.toString()) {
    res.status(403);
    throw new Error('You do not have access to this task');
  }

  task.isCompleted = !task.isCompleted;
  await task.save();

  // Populate references
  await task.populate('clinic_id', 'name');
  await task.populate('patient_id', 'name phone');

  res.json(task);
});

// ── Update task ────────────────────────────
// PUT /api/tasks/:id
const updateTask = asyncHandler(async (req, res) => {
  const task = await Task.findById(req.params.id);

  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }

  // Verify ownership
  if (task.dentist_id.toString() !== req.dentist._id.toString()) {
    res.status(403);
    throw new Error('You do not have access to this task');
  }

  // Verify clinic ownership if being updated
  if (req.body.clinic_id && req.body.clinic_id !== task.clinic_id?.toString()) {
    const clinic = await Clinic.findById(req.body.clinic_id);
    if (!clinic || clinic.dentist_id.toString() !== req.dentist._id.toString()) {
      res.status(403);
      throw new Error('You do not have access to this clinic');
    }
  }

  const updatedTask = await Task.findByIdAndUpdate(
    req.params.id,
    req.body,
    { new: true, runValidators: true }
  )
    .populate('clinic_id', 'name')
    .populate('patient_id', 'name phone');

  res.json(updatedTask);
});

// ── Delete task ────────────────────────────
// DELETE /api/tasks/:id
const deleteTask = asyncHandler(async (req, res) => {
  const task = await Task.findById(req.params.id);

  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }

  // Verify ownership
  if (task.dentist_id.toString() !== req.dentist._id.toString()) {
    res.status(403);
    throw new Error('You do not have access to this task');
  }

  await Task.findByIdAndDelete(req.params.id);

  res.json({ message: 'Task deleted successfully' });
});

module.exports = {
  getTasks,
  createTask,
  toggleTaskCompletion,
  updateTask,
  deleteTask,
};
