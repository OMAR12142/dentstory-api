const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const { ALLOWED_IMAGE_MIMES } = require('../utils/cloudinaryMedia');

const imageFileFilter = (_req, file, cb) => {
  if (ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new Error('Only JPG, PNG, and WebP images are allowed');
    err.statusCode = 400;
    cb(err, false);
  }
};

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'antigravity/sessions',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1200, crop: 'limit', quality: 'auto' }],
  },
});

const upload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
});

/**
 * Accept up to 5 images on the "images" field.
 * Uploaded files are available at `req.files`.
 */
const uploadImages = upload.array('images', 5);

const MAX_PORTFOLIO_CASE_IMAGES = 8;

const portfolioStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req) => ({
    folder: `antigravity/portfolio/${req.dentist._id}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1200, crop: 'limit', quality: 'auto' }],
  }),
});

const portfolioUpload = multer({
  storage: portfolioStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB per file
    files: MAX_PORTFOLIO_CASE_IMAGES,
  },
});

/**
 * Accept up to 8 images on the "images" field for direct portfolio uploads.
 * Must be placed AFTER `protect` middleware so `req.dentist._id` is populated.
 */
const uploadPortfolioImages = portfolioUpload.array('images', MAX_PORTFOLIO_CASE_IMAGES);

// ── Portfolio Cover Photo Upload (Single Banner) ─
const portfolioCoverStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req) => ({
    folder: `antigravity/portfolio/${req.dentist._id}`,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 1600, crop: 'limit', quality: 'auto' }],
  }),
});

const portfolioCoverUpload = multer({
  storage: portfolioCoverStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
    files: 1,
  },
});

const uploadPortfolioCover = portfolioCoverUpload.single('cover');

// ── Avatar Upload (Profile Photo) ──────────────
const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'dentstory/avatars',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto' }],
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
});

const uploadAvatar = avatarUpload.single('avatar');

module.exports = {
  uploadImages,
  uploadPortfolioImages,
  uploadPortfolioCover,
  uploadAvatar,
  imageFileFilter,
  MAX_PORTFOLIO_CASE_IMAGES,
};

