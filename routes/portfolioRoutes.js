const express = require('express');
const { protect, optionalProtect } = require('../middleware/authMiddleware');
const { uploadPortfolioImages, uploadPortfolioCover: uploadCoverMiddleware } = require('../middleware/uploadMiddleware');
const {
  getPublicPortfolio,
  getPublicCase,
  getMyPortfolio,
  createPortfolio,
  updatePortfolio,
  uploadPortfolioCover,
  togglePortfolio,
  publishCase,
  editCase,
  deleteCase,
  reorderCase,
  getMediaLibrary,
  uploadCaseImages,
} = require('../controllers/portfolioController');

const router = express.Router();

// ── Protected routes (dentist auth) ───────────
// MUST be registered BEFORE /:slug to avoid "me" / "upload-images" matching as a slug
router.post('/upload-images', protect, uploadPortfolioImages, uploadCaseImages);
router.get('/me/portfolio', protect, getMyPortfolio);
router.post('/me/portfolio', protect, createPortfolio);
router.put('/me/portfolio', protect, updatePortfolio);
router.post('/me/portfolio/cover', protect, uploadCoverMiddleware, uploadPortfolioCover);
router.put('/me/portfolio/toggle', protect, togglePortfolio);
router.post('/me/portfolio/cases', protect, publishCase);
router.put('/me/portfolio/cases/:caseId', protect, editCase);
router.delete('/me/portfolio/cases/:caseId', protect, deleteCase);
router.put('/me/portfolio/cases/:caseId/reorder', protect, reorderCase);
router.get('/me/media-library', protect, getMediaLibrary);

// ── Public routes (optional auth for owner draft preview) ──
// These come AFTER /me/* to prevent slug matching "me"
router.get('/:slug', optionalProtect, getPublicPortfolio);
router.get('/:slug/case/:caseId', optionalProtect, getPublicCase);

module.exports = router;
