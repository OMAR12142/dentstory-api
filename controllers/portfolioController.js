const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Portfolio = require('../models/Portfolio');
const Session = require('../models/Session');
const Dentist = require('../models/Dentist');

// ── Helpers ──────────────────────────────────────

/**
 * Generate a URL-safe slug from a dentist name.
 * "Omar El-Shamy" → "dr-omar-el-shamy"
 * Appends a numeric suffix if a collision is found.
 */
async function generateUniqueSlug(name) {
  const base = 'dr-' + name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  let slug = base;
  let counter = 1;

  while (await Portfolio.findOne({ slug })) {
    counter++;
    slug = `${base}-${counter}`;
  }

  return slug;
}

// ════════════════════════════════════════════════
// PUBLIC ENDPOINTS (No Auth)
// ════════════════════════════════════════════════

/**
 * GET /api/portfolio/:slug
 * Fetch a published portfolio + case summaries.
 * Returns dentist profile photo, name, and portfolio data.
 * NEVER returns patient PII.
 */
const getPublicPortfolio = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 12;
  const skip = (page - 1) * limit;

  const portfolio = await Portfolio.findOne({
    slug: req.params.slug,
  }).populate({
    path: 'dentist_id',
    select: 'name profilePhoto',
  });

  if (!portfolio) {
    res.status(404);
    throw new Error('Portfolio not found');
  }

  // Security: Block public access if unpublished
  if (!portfolio.isPublished) {
    res.status(403);
    throw new Error('This portfolio is currently in draft mode and not visible to the public.');
  }

  // Sort and Paginate cases in JS (since they are embedded)
  const allCases = [...portfolio.publishedCases].sort((a, b) => a.order - b.order);
  const totalItems = allCases.length;
  const totalPages = Math.ceil(totalItems / limit);
  
  const paginatedCases = allCases.slice(skip, skip + limit).map((c) => ({
    _id: c._id,
    title: c.title,
    description: c.description,
    category: c.category,
    coverImage: c.coverImage,
    selectedImages: c.selectedImages,
    publishedAt: c.publishedAt,
  }));

  res.json({
    dentist: {
      name: portfolio.dentist_id?.name || '',
      profilePhoto: portfolio.dentist_id?.profilePhoto || {},
    },
    slug: portfolio.slug,
    bio: portfolio.bio,
    yearsOfExperience: portfolio.yearsOfExperience,
    services: portfolio.services,
    contactEmail: portfolio.contactEmail,
    contactPhone: portfolio.contactPhone,
    clinicName: portfolio.clinicName,
    clinicAddress: portfolio.clinicAddress,
    isPublished: portfolio.isPublished,
    cases: paginatedCases,
    pagination: {
      totalItems,
      totalPages,
      currentPage: page,
      limit,
    },
  });
});

/**
 * GET /api/portfolio/:slug/case/:caseId
 * Fetch a single published case with all images.
 * NEVER returns patient PII.
 */
const getPublicCase = asyncHandler(async (req, res) => {
  const portfolio = await Portfolio.findOne({
    slug: req.params.slug,
  }).populate({
    path: 'dentist_id',
    select: 'name profilePhoto',
  });

  if (!portfolio) {
    res.status(404);
    throw new Error('Portfolio not found');
  }

  // Security: Block public access if unpublished
  if (!portfolio.isPublished) {
    res.status(403);
    throw new Error('This portfolio is currently in draft mode.');
  }

  const caseItem = portfolio.publishedCases.id(req.params.caseId);
  if (!caseItem) {
    res.status(404);
    throw new Error('Case not found');
  }

  res.json({
    dentist: {
      name: portfolio.dentist_id?.name || '',
      profilePhoto: portfolio.dentist_id?.profilePhoto || {},
    },
    slug: portfolio.slug,
    case: {
      _id: caseItem._id,
      title: caseItem.title,
      description: caseItem.description,
      category: caseItem.category,
      coverImage: caseItem.coverImage,
      selectedImages: caseItem.selectedImages,
      publishedAt: caseItem.publishedAt,
    },
  });
});

// ════════════════════════════════════════════════
// PROTECTED ENDPOINTS (Auth Required)
// ════════════════════════════════════════════════

/**
 * GET /api/portfolio/me
 * Get the current dentist's portfolio (or null).
 */
const getMyPortfolio = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 12;
  const skip = (page - 1) * limit;

  const portfolio = await Portfolio.findOne({ dentist_id: req.dentist._id }).lean();
  
  if (!portfolio) {
    return res.json(null);
  }

  const allCases = (portfolio.publishedCases || []).sort((a, b) => a.order - b.order);
  const totalItems = allCases.length;
  const totalPages = Math.ceil(totalItems / limit);
  const paginatedCases = allCases.slice(skip, skip + limit);

  res.json({
    ...portfolio,
    publishedCases: paginatedCases,
    pagination: {
      totalItems,
      totalPages,
      currentPage: page,
      limit,
    }
  });
});

/**
 * POST /api/portfolio
 * Create a new portfolio (auto-generates slug).
 * Only one portfolio per dentist.
 */
const createPortfolio = asyncHandler(async (req, res) => {
  const existing = await Portfolio.findOne({ dentist_id: req.dentist._id });
  if (existing) {
    res.status(400);
    throw new Error('You already have a portfolio');
  }

  const slug = await generateUniqueSlug(req.dentist.name);

  const portfolio = await Portfolio.create({
    dentist_id: req.dentist._id,
    slug,
    bio: req.body.bio || '',
    yearsOfExperience: req.body.yearsOfExperience || 0,
    services: req.body.services || [],
    contactEmail: req.body.contactEmail || req.dentist.email,
    contactPhone: req.body.contactPhone || req.dentist.phone || '',
    clinicName: req.body.clinicName || '',
    clinicAddress: req.body.clinicAddress || '',
  });

  res.status(201).json(portfolio);
});

/**
 * PUT /api/portfolio
 * Update portfolio bio, services, contact info.
 */
const updatePortfolio = asyncHandler(async (req, res) => {
  const portfolio = await Portfolio.findOne({ dentist_id: req.dentist._id });
  if (!portfolio) {
    res.status(404);
    throw new Error('No portfolio found. Create one first.');
  }

  const allowed = [
    'bio', 'yearsOfExperience', 'services',
    'contactEmail', 'contactPhone', 'clinicName', 'clinicAddress',
  ];

  allowed.forEach((field) => {
    if (req.body[field] !== undefined) {
      portfolio[field] = req.body[field];
    }
  });

  await portfolio.save();
  res.json(portfolio);
});

/**
 * PUT /api/portfolio/toggle
 * Toggle the master isPublished flag.
 */
const togglePortfolio = asyncHandler(async (req, res) => {
  const portfolio = await Portfolio.findOne({ dentist_id: req.dentist._id });
  if (!portfolio) {
    res.status(404);
    throw new Error('No portfolio found');
  }

  portfolio.isPublished = !portfolio.isPublished;
  await portfolio.save();

  res.json({ isPublished: portfolio.isPublished });
});

/**
 * POST /api/portfolio/cases
 * Publish a new case to the portfolio.
 * Body: { title, description, category, selectedImages, coverImage }
 *
 * selectedImages = array of Cloudinary URLs the doctor picked from their sessions.
 */
const publishCase = asyncHandler(async (req, res) => {
  const portfolio = await Portfolio.findOne({ dentist_id: req.dentist._id });
  if (!portfolio) {
    res.status(404);
    throw new Error('No portfolio found. Create one first.');
  }

  const { title, description, category, selectedImages, coverImage } = req.body;

  if (!title) {
    res.status(400);
    throw new Error('Case title is required');
  }

  if (!selectedImages || selectedImages.length === 0) {
    res.status(400);
    throw new Error('At least one image is required');
  }

  if (selectedImages.length > 5) {
    res.status(400);
    throw new Error('Maximum of 5 images allowed per case');
  }

  const newCase = {
    session_id: req.body.session_id || new mongoose.Types.ObjectId(),
    title,
    description: description || '',
    category: category || '',
    selectedImages,
    coverImage: coverImage || selectedImages[0],
    order: portfolio.publishedCases.length,
    publishedAt: new Date(),
  };

  portfolio.publishedCases.push(newCase);
  await portfolio.save();

  const saved = portfolio.publishedCases[portfolio.publishedCases.length - 1];
  res.status(201).json(saved);
});

/**
 * PUT /api/portfolio/cases/:caseId
 * Edit a published case's title, description, category.
 */
const editCase = asyncHandler(async (req, res) => {
  const portfolio = await Portfolio.findOne({ dentist_id: req.dentist._id });
  if (!portfolio) {
    res.status(404);
    throw new Error('No portfolio found');
  }

  const caseItem = portfolio.publishedCases.id(req.params.caseId);
  if (!caseItem) {
    res.status(404);
    throw new Error('Case not found');
  }

  if (req.body.title !== undefined) caseItem.title = req.body.title;
  if (req.body.description !== undefined) caseItem.description = req.body.description;
  if (req.body.category !== undefined) caseItem.category = req.body.category;
  if (req.body.selectedImages !== undefined) caseItem.selectedImages = req.body.selectedImages;
  if (req.body.coverImage !== undefined) caseItem.coverImage = req.body.coverImage;

  await portfolio.save();
  res.json(caseItem);
});

/**
 * DELETE /api/portfolio/cases/:caseId
 * Unpublish (remove) a case from the portfolio.
 */
const deleteCase = asyncHandler(async (req, res) => {
  const portfolio = await Portfolio.findOne({ dentist_id: req.dentist._id });
  if (!portfolio) {
    res.status(404);
    throw new Error('No portfolio found');
  }

  const caseIndex = portfolio.publishedCases.findIndex(
    (c) => c._id.toString() === req.params.caseId
  );

  if (caseIndex === -1) {
    res.status(404);
    throw new Error('Case not found');
  }

  portfolio.publishedCases.splice(caseIndex, 1);
  await portfolio.save();

  res.json({ message: 'Case removed from portfolio' });
});

/**
 * GET /api/portfolio/media-library
 * Return all Cloudinary image URLs from the dentist's sessions.
 * This powers the "image picker" in the editor.
 */
const getMediaLibrary = asyncHandler(async (req, res) => {
  const sessions = await Session.find({
    dentist_id: req.dentist._id,
    isDeleted: { $ne: true },
    media_urls: { $exists: true, $ne: [] },
  })
    .select('media_urls treatment_category date patient_id')
    .populate('patient_id', 'name')
    .sort({ date: -1 })
    .lean();

  // Group images by session with minimal context
  const library = sessions.map((s) => ({
    sessionId: s._id,
    date: s.date,
    patientName: s.patient_id?.name || 'Unknown',
    category: s.treatment_category || [],
    images: s.media_urls,
  }));

  res.json(library);
});

/**
 * PUT /api/portfolio/me/portfolio/cases/:caseId/reorder
 * direction: 'up' | 'down'
 */
const reorderCase = asyncHandler(async (req, res) => {
  const { direction } = req.body;
  const portfolio = await Portfolio.findOne({ dentist_id: req.dentist._id });
  
  if (!portfolio) {
    res.status(404);
    throw new Error('Portfolio not found');
  }

  const cases = portfolio.publishedCases;
  const index = cases.findIndex((c) => c._id.toString() === req.params.caseId);

  if (index === -1) {
    res.status(404);
    throw new Error('Case not found');
  }

  // Swap logic
  if (direction === 'up' && index > 0) {
    [cases[index], cases[index - 1]] = [cases[index - 1], cases[index]];
  } else if (direction === 'down' && index < cases.length - 1) {
    [cases[index], cases[index + 1]] = [cases[index + 1], cases[index]];
  }

  // Re-sync order numbers
  cases.forEach((c, i) => {
    c.order = i;
  });

  await portfolio.save();
  res.json(portfolio.publishedCases);
});

module.exports = {
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
};
