const rateLimit = require('express-rate-limit');

/**
 * Global API Rate Limiter
 * Limits standard API requests to protect against DDoS and general scraping.
 * Configured for 500 requests per 15 minutes per IP.
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, // Increased to 2000 to support high-sync mobile users and large dashboards
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    message: 'Too many requests from this IP. To ensure platform stability, please wait 15 minutes and try again.',
  },
});

/**
 * Strict Auth Rate Limiter
 * Specifically protects /login and /register endpoints against brute-force
 * and credential stuffing attacks.
 * Configured for 5 requests per 15 minutes per IP.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 failed/successful login requests per `window`
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many authentication attempts detected. For your security, this IP has been temporarily blocked from auth routes for 15 minutes.',
  },
});

module.exports = {
  apiLimiter,
  authLimiter,
};
