const express = require('express');
const { protect, optionalProtect } = require('../middleware/authMiddleware');
const {
  uploadPortfolioImages,
  uploadPortfolioCover: uploadCoverMiddleware,
  uploadPortfolioCv: uploadCvMiddleware,
} = require('../middleware/uploadMiddleware');
const {
  getPublicPortfolio,
  getPublicCase,
  getMyPortfolio,
  createPortfolio,
  updatePortfolio,
  updateVisibility,
  uploadPortfolioCover,
  uploadPortfolioCv,
  deletePortfolioCv,
  streamPublicCv,
  streamOwnerCv,
  togglePortfolio,
  publishCase,
  editCase,
  deleteCase,
  reorderCase,
  toggleFeaturedCase,
  moveCasePosition,
  getMediaLibrary,
  uploadCaseImages,
} = require('../controllers/portfolioController');

const router = express.Router();

// ── Protected routes (dentist auth) ───────────
// MUST be registered BEFORE /:slug to avoid "me" / "upload-images" matching as a slug
router.post('/upload-images', protect, uploadPortfolioImages, uploadCaseImages);
router.get('/me', protect, getMyPortfolio);
router.get('/me/portfolio', protect, getMyPortfolio);
router.post('/me/portfolio', protect, createPortfolio);
router.put('/me/portfolio', protect, updatePortfolio);
router.patch('/me/visibility', protect, updateVisibility);
router.patch('/me/portfolio/visibility', protect, updateVisibility);
router.post('/me/portfolio/cover', protect, uploadCoverMiddleware, uploadPortfolioCover);
router.post('/me/cv', protect, uploadCvMiddleware, uploadPortfolioCv);
router.delete('/me/cv', protect, deletePortfolioCv);
router.get('/me/cv/preview', protect, streamOwnerCv);
router.get('/me/cv.pdf', protect, streamOwnerCv);
router.post('/me/portfolio/cv', protect, uploadCvMiddleware, uploadPortfolioCv);
router.delete('/me/portfolio/cv', protect, deletePortfolioCv);
router.get('/me/portfolio/cv/preview', protect, streamOwnerCv);
router.get('/me/portfolio/cv.pdf', protect, streamOwnerCv);
router.put('/me/portfolio/toggle', protect, togglePortfolio);
router.post('/me/portfolio/cases', protect, publishCase);
router.put('/me/portfolio/cases/:caseId', protect, editCase);
router.delete('/me/portfolio/cases/:caseId', protect, deleteCase);
router.put('/me/cases/:caseId/reorder', protect, reorderCase);
router.put('/me/portfolio/cases/:caseId/reorder', protect, reorderCase);
router.patch('/me/cases/:caseId/featured', protect, toggleFeaturedCase);
router.patch('/me/portfolio/cases/:caseId/featured', protect, toggleFeaturedCase);
router.patch('/me/cases/:caseId/position', protect, moveCasePosition);
router.patch('/me/portfolio/cases/:caseId/position', protect, moveCasePosition);
router.get('/me/media-library', protect, getMediaLibrary);

// ── Public routes (optional auth for owner draft preview) ──
// These come AFTER /me/* to prevent slug matching "me"
router.get('/public/:slug/cv.pdf', optionalProtect, streamPublicCv);
router.get('/public/:slug/cv', optionalProtect, streamPublicCv);
router.get('/:slug/cv.pdf', optionalProtect, streamPublicCv);
router.get('/:slug/cv', optionalProtect, streamPublicCv);
router.get('/:slug', optionalProtect, getPublicPortfolio);
router.get('/:slug/case/:caseId', optionalProtect, getPublicCase);

module.exports = router;
