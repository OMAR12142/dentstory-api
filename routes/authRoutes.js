const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const {
  register,
  login,
  refreshAccessToken,
  logout,
  getMe,
  updateProfile,
  updatePassword,
  uploadPhoto,
  removePhoto,
  googleLogin,
} = require('../controllers/authController');
const { authLimiter } = require('../middleware/rateLimiter');
const { protect } = require('../middleware/authMiddleware');
const { uploadAvatar } = require('../middleware/uploadMiddleware');

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

const profileSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  phone: z.string().optional(),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

// ── Routes ────────────────────────────────────
router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/google', googleLogin);
router.post('/refresh', refreshAccessToken);
router.post('/logout', logout);
router.get('/me', getMe);

// Profile & Security (Protected)
router.put('/profile', protect, validate(profileSchema), updateProfile);
router.put('/password', protect, validate(passwordSchema), updatePassword);

// Profile Photo (Protected)
router.post('/photo', protect, uploadAvatar, uploadPhoto);
router.delete('/photo', protect, removePhoto);

module.exports = router;

