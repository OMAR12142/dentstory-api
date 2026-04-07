const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const {
  register,
  login,
  refreshAccessToken,
  logout,
  getMe,
} = require('../controllers/authController');

const router = express.Router();

// ── Zod schemas ───────────────────────────────
const registerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(1, 'Password is required'),
});

// ── Routes ────────────────────────────────────
router.post('/register', validate(registerSchema), register);
router.post('/login', validate(loginSchema), login);
router.post('/refresh', refreshAccessToken);
router.post('/logout', logout);
router.get('/me', getMe);

module.exports = router;
