const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const {
  getPublicPortfolio,
  getPublicCase,
  getMyPortfolio,
  createPortfolio,
  updatePortfolio,
  togglePortfolio,
  publishCase,
  editCase,
  deleteCase,
  reorderCase,
  getMediaLibrary,
} = require('../controllers/portfolioController');

const router = express.Router();

// ── Protected routes (dentist auth) ───────────
// MUST be registered BEFORE /:slug to avoid "me" matching as a slug
router.get('/me/portfolio', protect, getMyPortfolio);
router.post('/me/portfolio', protect, createPortfolio);
router.put('/me/portfolio', protect, updatePortfolio);
router.put('/me/portfolio/toggle', protect, togglePortfolio);
router.post('/me/portfolio/cases', protect, publishCase);
router.put('/me/portfolio/cases/:caseId', protect, editCase);
router.delete('/me/portfolio/cases/:caseId', protect, deleteCase);
router.put('/me/portfolio/cases/:caseId/reorder', protect, reorderCase);
router.get('/me/media-library', protect, getMediaLibrary);

// ── Public routes (no auth) ───────────────────
// These come AFTER /me/* to prevent slug matching "me"
router.get('/:slug', getPublicPortfolio);
router.get('/:slug/case/:caseId', getPublicCase);

module.exports = router;
