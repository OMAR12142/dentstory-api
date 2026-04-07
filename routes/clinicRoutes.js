const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const { protect } = require('../middleware/authMiddleware');
const { createClinic, getClinics, updateClinic, deleteClinic } = require('../controllers/clinicController');

const router = express.Router();

// ── Zod schema ────────────────────────────────
const clinicSchema = z.object({
  name: z.string().min(1, 'Clinic name is required'),
  address: z.string().optional(),
  default_commission_percentage: z.coerce.number().min(0).max(100),
  working_days: z
    .array(
      z.object({
        day: z.enum(['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']),
        start_time: z.string().min(1, 'Start time is required'),
        end_time: z.string().min(1, 'End time is required'),
      })
    )
    .optional(),
});

// ── Routes (all protected) ────────────────────
router.use(protect);

router.route('/')
  .post(validate(clinicSchema), createClinic)
  .get(getClinics);

router.route('/:id')
  .put(validate(clinicSchema.partial()), updateClinic)
  .delete(deleteClinic);

module.exports = router;
