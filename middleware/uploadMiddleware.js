const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
});

/**
 * Accept up to 5 images on the "images" field.
 * Uploaded files are available at `req.files`.
 */
const uploadImages = upload.array('images', 5);

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
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
});

const uploadAvatar = avatarUpload.single('avatar');

module.exports = { uploadImages, uploadAvatar };

