const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const Dentist = require('../models/Dentist');

/**
 * Protect routes – verifies the Bearer access-token from the
 * Authorization header and attaches the dentist to `req.dentist`.
 */
const protect = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Not authorised — no token provided');
    err.statusCode = 401;
    throw err;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    req.dentist = await Dentist.findById(decoded.id).select('-password');

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
