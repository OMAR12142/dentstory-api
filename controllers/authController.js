const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const Dentist = require('../models/Dentist');

// ── Helpers ───────────────────────────────────
const generateAccessToken = (id, role) =>
  jwt.sign({ id, role }, process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '30d',
  });

const generateRefreshToken = (id, role) =>
  jwt.sign({ id, role }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
  });

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  // Force secure: true for Vercel/Production to ensure Safari (iOS) accepts the cookie.
  // Safari blocks 'sameSite: none' cookies if 'secure' is false.
  secure: true,
  sameSite: 'none',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

// ── Register ──────────────────────────────────
// POST /api/auth/register
const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;

  const exists = await Dentist.findOne({ email });
  if (exists) {
    res.status(409);
    throw new Error('A dentist with this email already exists');
  }

  const dentist = await Dentist.create({ name, email, password, phone });

  const accessToken = generateAccessToken(dentist._id, dentist.role);
  const refreshToken = generateRefreshToken(dentist._id, dentist.role);

  // Persist refresh token in DB (limit array size to 5 devices max)
  dentist.refreshTokens.push(refreshToken);
  if (dentist.refreshTokens.length > 5) {
    dentist.refreshTokens = dentist.refreshTokens.slice(-5);
  }
  await dentist.save({ validateModifiedOnly: true });

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

  res.status(201).json({
    _id: dentist._id,
    name: dentist.name,
    email: dentist.email,
    phone: dentist.phone,
    role: dentist.role,
    profilePhoto: dentist.profilePhoto,
    accessToken,
  });
});

// ── Login ─────────────────────────────────────
// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const dentist = await Dentist.findOne({ email }).select('+password');
  if (!dentist || !(await dentist.matchPassword(password))) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  const accessToken = generateAccessToken(dentist._id, dentist.role);
  const refreshToken = generateRefreshToken(dentist._id, dentist.role);

  dentist.refreshTokens.push(refreshToken);
  if (dentist.refreshTokens.length > 5) {
    dentist.refreshTokens = dentist.refreshTokens.slice(-5);
  }
  await dentist.save({ validateModifiedOnly: true });

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

  res.json({
    _id: dentist._id,
    name: dentist.name,
    email: dentist.email,
    phone: dentist.phone,
    role: dentist.role,
    profilePhoto: dentist.profilePhoto,
    accessToken,
  });
});

// ── Refresh Token ─────────────────────────────
// POST /api/auth/refresh
const refreshAccessToken = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) {
    res.status(401);
    throw new Error('No refresh token — please log in');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
  } catch {
    res.status(403);
    throw new Error('Invalid or expired refresh token');
  }

  const dentist = await Dentist.findById(decoded.id);
  if (!dentist || !dentist.refreshTokens.includes(token)) {
    res.status(403);
    throw new Error('Refresh token mismatch — possible reuse detected');
  }

  // Issue a new short-lived access token, but DO NOT rotate the refresh
  // token to prevent race conditions when the user has multiple tabs open.
  const newAccessToken = generateAccessToken(dentist._id, dentist.role);

  res.cookie('refreshToken', token, REFRESH_COOKIE_OPTIONS);
  res.json({
    accessToken: newAccessToken,
    role: dentist.role,       // let frontend stay in sync after silent refresh
  });
});

// ── Logout ────────────────────────────────────
// POST /api/auth/logout
const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;

  if (token) {
    const dentist = await Dentist.findOne({ refreshTokens: token });
    if (dentist) {
      dentist.refreshTokens = dentist.refreshTokens.filter((t) => t !== token);
      await dentist.save({ validateModifiedOnly: true });
    }
  }

  res.clearCookie('refreshToken', REFRESH_COOKIE_OPTIONS);
  res.json({ message: 'Logged out successfully' });
});

// ── Get Current User ──────────────────────────
// GET /api/auth/me
// NOTE: This endpoint intentionally does NOT use the `protect` middleware
// because suspended users need to reach it for the polling check.
// It verifies the JWT manually and returns status.
const getMe = asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401);
    throw new Error('Not authorised');
  }

  const token = authHeader.split(' ')[1];
  let decoded;

  try {
    decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
  } catch (error) {
    res.status(401);
    throw new Error('Token expired or invalid');
  }

  const dentist = await Dentist.findById(decoded.id).select('-password -refreshToken');

  if (!dentist) {
    res.status(404);
    throw new Error('User not found');
  }

  res.json({
    _id: dentist._id,
    name: dentist.name,
    email: dentist.email,
    phone: dentist.phone,
    role: dentist.role,
    status: dentist.status,
    profilePhoto: dentist.profilePhoto,
  });
});

// ── Update Profile ────────────────────────────
// PUT /api/auth/profile
const updateProfile = asyncHandler(async (req, res) => {
  const dentist = await Dentist.findById(req.dentist._id);
  if (!dentist) {
    res.status(404);
    throw new Error('User not found');
  }

  // Update allowed fields only (Email is read-only per requirement)
  dentist.name = req.body.name || dentist.name;
  dentist.phone = req.body.phone || dentist.phone;

  const updatedDentist = await dentist.save();

  // Clear cache to ensure MainLayout and other components get fresh data
  const { analyticsCache } = require('../utils/cache');
  analyticsCache.del(`prof_${dentist._id}`);

  res.json({
    _id: updatedDentist._id,
    name: updatedDentist.name,
    email: updatedDentist.email,
    phone: updatedDentist.phone,
    role: updatedDentist.role,
    profilePhoto: updatedDentist.profilePhoto,
  });
});

// ── Update Password ───────────────────────────
// PUT /api/auth/password
const updatePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!newPassword || newPassword.length < 6) {
    res.status(400);
    throw new Error('New password must be at least 6 characters');
  }

  const dentist = await Dentist.findById(req.dentist._id).select('+password');

  // Verify current password
  const isMatch = await dentist.matchPassword(currentPassword);
  if (!isMatch) {
    res.status(401);
    throw new Error('Current password is incorrect');
  }

  // Update password field – Mongoose pre-save hook will hash it
  dentist.password = newPassword;

  // Optional: Invalidate other sessions (clear refresh tokens)
  // dentist.refreshTokens = []; 

  await dentist.save();

  res.json({ message: 'Password updated successfully' });
});

// ── Upload Profile Photo ──────────────────────
// POST /api/auth/photo
const uploadPhoto = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('No image file provided');
  }

  const dentist = await Dentist.findById(req.dentist._id);
  if (!dentist) {
    res.status(404);
    throw new Error('User not found');
  }

  // Delete old photo from Cloudinary if it exists
  if (dentist.profilePhoto?.publicId) {
    const cloudinary = require('../config/cloudinary');
    await cloudinary.uploader.destroy(dentist.profilePhoto.publicId);
  }

  // Save new photo
  dentist.profilePhoto = {
    url: req.file.path,
    publicId: req.file.filename,
  };
  await dentist.save({ validateModifiedOnly: true });

  // Clear cache
  const { analyticsCache } = require('../utils/cache');
  analyticsCache.del(`prof_${dentist._id}`);

  res.json({
    _id: dentist._id,
    name: dentist.name,
    email: dentist.email,
    phone: dentist.phone,
    role: dentist.role,
    profilePhoto: dentist.profilePhoto,
  });
});

// ── Remove Profile Photo ──────────────────────
// DELETE /api/auth/photo
const removePhoto = asyncHandler(async (req, res) => {
  const dentist = await Dentist.findById(req.dentist._id);
  if (!dentist) {
    res.status(404);
    throw new Error('User not found');
  }

  // Delete from Cloudinary
  if (dentist.profilePhoto?.publicId) {
    const cloudinary = require('../config/cloudinary');
    await cloudinary.uploader.destroy(dentist.profilePhoto.publicId);
  }

  dentist.profilePhoto = { url: '', publicId: '' };
  await dentist.save({ validateModifiedOnly: true });

  // Clear cache
  const { analyticsCache } = require('../utils/cache');
  analyticsCache.del(`prof_${dentist._id}`);

  res.json({ message: 'Profile photo removed' });
});

module.exports = {
  register,
  login,
  refreshAccessToken,
  logout,
  getMe,
  updateProfile,
  updatePassword,
  uploadPhoto,
  removePhoto,
};
