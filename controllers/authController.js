const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const Dentist = require('../models/Dentist');
const RefreshToken = require('../models/RefreshToken');
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

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

  // Atomic Refresh Token Persistance
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30); // 30 days matches REFRESH_TOKEN_EXPIRES_IN

  await RefreshToken.create({
    dentistId: dentist._id,
    token: refreshToken,
    expiresAt,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress,
  });

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

  // Manage active sessions (limit to 5 devices)
  // We delete the oldest tokens if the limit is exceeded
  const sessionCount = await RefreshToken.countDocuments({ dentistId: dentist._id });
  if (sessionCount >= 5) {
    const oldestTokens = await RefreshToken.find({ dentistId: dentist._id })
      .sort({ createdAt: 1 })
      .limit(sessionCount - 4);
    await RefreshToken.deleteMany({ _id: { $in: oldestTokens.map(t => t._id) } });
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await RefreshToken.create({
    dentistId: dentist._id,
    token: refreshToken,
    expiresAt,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress,
  });

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

  // REFRESH TOKEN ROTATION (RTR)
  // 1. Verify token exists in DB
  const storedToken = await RefreshToken.findOne({ token });

  if (!storedToken) {
    res.status(403);
    throw new Error('Refresh token mismatch — possible reuse detected');
  }

  const dentist = await Dentist.findById(decoded.id);
  if (!dentist) {
    await RefreshToken.deleteMany({ dentistId: decoded.id }); // Compromised? Clear all
    res.status(403);
    throw new Error('User not found');
  }

  // 2. Invalidate old token and issue new ones (Rotation)
  await RefreshToken.deleteOne({ _id: storedToken._id });

  const newAccessToken = generateAccessToken(dentist._id, dentist.role);
  const newRefreshToken = generateRefreshToken(dentist._id, dentist.role);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await RefreshToken.create({
    dentistId: dentist._id,
    token: newRefreshToken,
    expiresAt,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress,
  });

  res.cookie('refreshToken', newRefreshToken, REFRESH_COOKIE_OPTIONS);
  res.json({
    accessToken: newAccessToken,
    role: dentist.role,
  });
});

// ── Logout ────────────────────────────────────
// POST /api/auth/logout
const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;

  if (token) {
    await RefreshToken.deleteOne({ token });
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

  await RefreshToken.deleteMany({ dentistId: dentist._id });

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

/**
 * POST /api/auth/google
 * Verify Google token and login/register user
 */
const googleLogin = asyncHandler(async (req, res) => {
  const { googleToken } = req.body;

  if (!googleToken) {
    res.status(400);
    throw new Error('Google token is required');
  }

  let email, name, picture;

  try {
    // Try as ID Token first (original behavior)
    const ticket = await client.verifyIdToken({
      idToken: googleToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    email = payload.email;
    name = payload.name;
    picture = payload.picture;
  } catch (err) {
    // If ID token fails, try as Access Token using getTokenInfo
    try {
      const tokenInfo = await client.getTokenInfo(googleToken);

      // getTokenInfo returns basic info, but for name/picture we might still need userinfo API
      // However, email is available in tokenInfo.
      if (tokenInfo.email) {
        email = tokenInfo.email;
        // For name and picture, if not in tokenInfo, we'll try to get them from payload if possible
        // but tokenInfo usually has 'email' and 'sub'. 
        // If we want more info, we have to use the userinfo endpoint.
        // Let's use the userinfo endpoint but with the library's request method for safety.
        const url = 'https://www.googleapis.com/oauth2/v3/userinfo';
        const response = await client.request({ url, headers: { Authorization: `Bearer ${googleToken}` } });

        email = response.data.email;
        name = response.data.name;
        picture = response.data.picture;
      } else {
        throw new Error('Invalid Google token');
      }
    } catch (tokenErr) {
      res.status(400);
      throw new Error('Invalid Google token');
    }
  }

  let dentist = await Dentist.findOne({ email });

  if (!dentist) {
    dentist = await Dentist.create({
      name,
      email,
      authProvider: 'google',
      role: 'dentist',
      profilePhoto: { url: picture },
    });
  }

  const accessToken = generateAccessToken(dentist._id, dentist.role);
  const refreshToken = generateRefreshToken(dentist._id, dentist.role);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await RefreshToken.create({
    dentistId: dentist._id,
    token: refreshToken,
    expiresAt,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress,
  });

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

  res.status(200).json({
    _id: dentist._id,
    name: dentist.name,
    email: dentist.email,
    phone: dentist.phone,
    role: dentist.role,
    profilePhoto: dentist.profilePhoto,
    accessToken,
  });
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
  googleLogin,
};
