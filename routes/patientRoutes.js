const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/authMiddleware');
const {
  createPatient,
  getPatients,
  getPatientById,
  updatePatient,
  deletePatient,
} = require('../controllers/patientController');

const router = express.Router();

// ── Zod schema ────────────────────────────────
const patientSchema = z.object({
  name: z.string().min(1, 'Patient name is required'),
  age: z.coerce.number().int().min(0).optional(),
  dateOfBirth: z.string().or(z.date()).optional().nullable(),
  phone: z.string().optional(),
  phone2: z.string().optional(),
  address: z.string().optional(),
  job: z.string().optional(),
  medical_history: z.array(z.string()).optional(),
  treatment_plan: z.array(z.object({
    _id: z.string().optional(),
    text: z.string(),
    isCompleted: z.boolean(),
    createdAt: z.string().or(z.date()).optional(),
  })).optional(),
  status: z.enum(['Active', 'On-Hold', 'Completed', 'Dropped']).optional().default('Active'),
  insuranceCompany: z.string().optional(),
  clinic_id: z.string().min(1, 'Clinic is required'),
  commission_percentage: z.coerce.number().min(0).max(100),
});

// ── Routes (all protected) ────────────────────
router.use(protect);

router.route('/')
  .post(validate(patientSchema), createPatient)
  .get(getPatients);

router.route('/:id')
  .get(getPatientById)
  .put(updatePatient)
  .delete(deletePatient);

module.exports = router;
