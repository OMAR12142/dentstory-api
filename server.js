require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');

// ── Route imports ─────────────────────────────
const authRoutes = require('./routes/authRoutes');
const patientRoutes = require('./routes/patientRoutes');
const clinicRoutes = require('./routes/clinicRoutes');
const sessionRoutes = require('./routes/sessionRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const taskRoutes = require('./routes/taskRoutes');
const adminRoutes = require('./routes/adminRoutes');
const insuranceRoutes = require('./routes/insuranceRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const announcementRoutes = require('./routes/announcementRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const fixedSalaryRoutes = require('./routes/fixedSalaryRoutes');

// ── App initialisation ────────────────────────
const app = express();

// Build allowed origins list from CLIENT_URL (supports comma-separated values)
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://dentstory.vercel.app',
  ...(process.env.CLIENT_URL ? process.env.CLIENT_URL.split(',').map(u => u.trim()) : []),
];

// CORS must come BEFORE helmet so preflight responses aren't blocked
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked: ${origin}`));
      }
    },
    credentials: true,
  })
);

// Helmet for security headers — configured to not conflict with CORS
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: false,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// ── Health check ──────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Rate Limiting ─────────────────────────────
// Apply global apiLimiter to all requests under /api
app.use('/api', apiLimiter);

// ── API routes ────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/clinics', clinicRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/insurance', insuranceRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/fixed-salaries', fixedSalaryRoutes);

// ── 404 handler ───────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// ── Error handler (must be last) ──────────────
app.use(errorHandler);

// ── Connect to MongoDB eagerly (works for both local & Vercel) ──
connectDB();

// ── Start server (local development only) ─────
// On Vercel, the exported app is used as a serverless function handler.
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 5001;
  app.listen(PORT, () => {
    console.log(`  dentstory server running on port ${PORT}`);
  });
}

// ── Export for Vercel serverless ───────────────
module.exports = app;
