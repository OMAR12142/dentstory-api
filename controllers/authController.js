const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const Dentist = require('../models/Dentist');

// ── Helpers ───────────────────────────────────
const generateAccessToken = (id, role) =>
  jwt.sign({ id, role }, process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  });

const generateRefreshToken = (id, role) =>
  jwt.sign({ id, role }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
  });

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
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

  // Persist refresh token in DB
  dentist.refreshToken = refreshToken;
  await dentist.save({ validateModifiedOnly: true });

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

  res.status(201).json({
    _id: dentist._id,
    name: dentist.name,
    email: dentist.email,
    role: dentist.role,
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

  dentist.refreshToken = refreshToken;
  await dentist.save({ validateModifiedOnly: true });

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

  res.json({
    _id: dentist._id,
    name: dentist.name,
    email: dentist.email,
    role: dentist.role,
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
  if (!dentist || dentist.refreshToken !== token) {
    res.status(403);
    throw new Error('Refresh token mismatch — possible reuse detected');
  }

  // Rotate tokens (include current role from DB for freshness)
  const newAccessToken = generateAccessToken(dentist._id, dentist.role);
  const newRefreshToken = generateRefreshToken(dentist._id, dentist.role);

  dentist.refreshToken = newRefreshToken;
  await dentist.save({ validateModifiedOnly: true });

  res.cookie('refreshToken', newRefreshToken, REFRESH_COOKIE_OPTIONS);
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
    const dentist = await Dentist.findOne({ refreshToken: token });
    if (dentist) {
      dentist.refreshToken = null;
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
  const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
  const dentist = await Dentist.findById(decoded.id).select('-password -refreshToken');

  if (!dentist) {
    res.status(404);
    throw new Error('User not found');
  }

  res.json({
    _id: dentist._id,
    name: dentist.name,
    email: dentist.email,
    role: dentist.role,
    status: dentist.status,
  });
});

module.exports = { register, login, refreshAccessToken, logout, getMe };
