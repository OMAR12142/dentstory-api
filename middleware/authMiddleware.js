const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const Dentist = require('../models/Dentist');
const { analyticsCache } = require('../utils/cache');

/**
 * Protect routes – verifies the Bearer access-token from the
 * Authorization header and attaches the dentist to `req.dentist`.
 */
const protect = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Not authorised — no token provided');
    err.statusCode = 401;
    throw err;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    
    // ── Mid-Tier Cache Lookup ────────────────
    const cacheKey = `prof_${decoded.id}`;
    let dentist = analyticsCache.get(cacheKey);

    if (!dentist) {
      dentist = await Dentist.findById(decoded.id).select('-password');
      if (dentist) {
        // Cache profile for 2 minutes to reduce IO
        analyticsCache.set(cacheKey, dentist, 120);
      }
    }

    req.dentist = dentist;

    if (!req.dentist) {
      const err = new Error('Not authorised — dentist not found');
      err.statusCode = 401;
      throw err;
    }

    // ── Kill Switch: block suspended accounts ───
    if (req.dentist.status === 'suspended') {
      return res.status(403).json({
        message: 'Account suspended. Please contact support.',
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      error.message = 'Token expired';
      error.statusCode = 401;
    }
    throw error;
  }
});

/**
 * Authorise admin-only routes.
 * Must run AFTER `protect` so that `req.dentist` is already set.
 *
 * Returns 403 Forbidden if the authenticated user does not have the
 * 'admin' role – ensures regular dentists cannot access Super-Admin
 * endpoints even with a valid token.
 */
const isAdmin = asyncHandler(async (req, _res, next) => {
  if (!req.dentist || req.dentist.role !== 'admin') {
    const err = new Error(
      'Forbidden — admin privileges required to access this resource'
    );
    err.statusCode = 403;
    throw err;
  }

  next();
});

module.exports = { protect, isAdmin };
