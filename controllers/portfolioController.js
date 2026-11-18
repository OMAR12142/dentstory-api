const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Portfolio = require('../models/Portfolio');
const Session = require('../models/Session');
const Dentist = require('../models/Dentist');
const Clinic = require('../models/Clinic');
const {
  destroyUnreferencedMediaUrls,
  isOwnedPortfolioUploadUrl,
  cleanupUploadedFiles,
} = require('../utils/cloudinaryMedia');

const MAX_CASE_IMAGES = 8;
const DEFAULT_COVER_THEME = 'clinical-blue';
const ALLOWED_COVER_THEMES = new Set([
  'clinical-blue',
  'emerald-care',
  'midnight-slate',
  'pearl-minimal',
]);
const RESERVED_SLUGS = new Set([
  'me',
  'admin',
  'manage',
  'upload-images',
  'login',
  'register',
  'dashboard',
]);

// ── Helpers ──────────────────────────────────────

/**
 * Collect all image URLs already saved on a dentist's portfolio cases.
 */
function getPortfolioMediaUrls(portfolio) {
  const urls = [];
  for (const c of portfolio?.publishedCases || []) {
    if (c.coverImage) urls.push(c.coverImage);
    for (const u of c.selectedImages || []) {
      if (u) urls.push(u);
    }
  }
  return urls;
}

/**
 * Build the set of media URLs that belong to a dentist's active sessions,
 * plus any optional extra URLs (e.g. already-attached images on that dentist's portfolio cases).
 */
async function getAllowedMediaSet(dentistId, extraUrls = []) {
  const sessions = await Session.find({
    dentist_id: dentistId,
    isDeleted: { $ne: true },
    media_urls: { $exists: true, $ne: [] },
  })
    .select('media_urls')
    .lean();

  const allowed = new Set(extraUrls.filter((u) => typeof u === 'string' && u.trim()));
  for (const s of sessions) {
    for (const url of s.media_urls || []) {
      if (typeof url === 'string' && url.trim()) {
        allowed.add(url);
      }
    }
  }
  return allowed;
}

/**
 * Deduplicate, preserve order, verify count (1..8), verify ownership against
 * session/portfolio allowedUrls or dentist-scoped Cloudinary portfolio uploads,
 * and guarantee coverImage is a member of selectedImages.
 */
function normalizeAndValidateCaseImages(selectedImages, coverImage, allowedUrls, dentistId) {
  if (!Array.isArray(selectedImages) || selectedImages.length === 0) {
    const err = new Error('At least one image is required');
    err.statusCode = 400;
    throw err;
  }

  const seen = new Set();
  const normalized = [];
  for (const raw of selectedImages) {
    if (typeof raw !== 'string' || !raw.trim()) {
      const err = new Error('Selected images must be valid URLs');
      err.statusCode = 400;
      throw err;
    }
    const url = raw.trim();
    if (!seen.has(url)) {
      seen.add(url);
      normalized.push(url);
    }
  }

  if (normalized.length === 0) {
    const err = new Error('At least one image is required');
    err.statusCode = 400;
    throw err;
  }

  if (normalized.length > MAX_CASE_IMAGES) {
    const err = new Error(`Maximum of ${MAX_CASE_IMAGES} images allowed per case`);
    err.statusCode = 400;
    throw err;
  }

  for (const url of normalized) {
    if (!allowedUrls.has(url) && !isOwnedPortfolioUploadUrl(url, dentistId)) {
      const err = new Error('One or more selected images are invalid or do not belong to your media library');
      err.statusCode = 400;
      throw err;
    }
  }

  const resolvedCover =
    typeof coverImage === 'string' && normalized.includes(coverImage.trim())
      ? coverImage.trim()
      : normalized[0];

  return { selectedImages: normalized, coverImage: resolvedCover };
}

/**
 * Validate optional beforeImage / afterImage pair against the case's selectedImages.
 * - Both empty/nullish -> { beforeImage: null, afterImage: null }
 * - Only one provided -> 400
 * - Both provided -> requires >= 2 images, distinct URLs, and both in selectedImages
 */
function normalizeAndValidateBeforeAfter(beforeImage, afterImage, selectedImages) {
  const normBefore = typeof beforeImage === 'string' && beforeImage.trim() ? beforeImage.trim() : null;
  const normAfter = typeof afterImage === 'string' && afterImage.trim() ? afterImage.trim() : null;

  if (!normBefore && !normAfter) {
    return { beforeImage: null, afterImage: null };
  }

  if (!normBefore || !normAfter) {
    const err = new Error('Both Before and After images must be selected together.');
    err.statusCode = 400;
    throw err;
  }

  if (!Array.isArray(selectedImages) || selectedImages.length < 2) {
    const err = new Error('At least 2 images are required to set Before and After images.');
    err.statusCode = 400;
    throw err;
  }

  if (normBefore === normAfter) {
    const err = new Error('Before and After images must be two different images.');
    err.statusCode = 400;
    throw err;
  }

  if (!selectedImages.includes(normBefore) || !selectedImages.includes(normAfter)) {
    const err = new Error('Before and After images must belong to the selected case images.');
    err.statusCode = 400;
    throw err;
  }

  return { beforeImage: normBefore, afterImage: normAfter };
}

/**
 * Generate a URL-safe slug from a dentist name.
 * "Omar El-Shamy" → "dr-omar-el-shamy"
 * Non-Latin / Arabic names (e.g. "د. أحمد") cleanly fall back to "dr-dentist".
 * Appends a numeric suffix if a collision is found.
 */
async function generateUniqueSlug(name, excludePortfolioId = null) {
  const cleaned = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const withoutLeadingDr = cleaned.replace(/^dr-+/, '').replace(/^-+|-+$/g, '');
  const base = withoutLeadingDr ? `dr-${withoutLeadingDr}` : 'dr-dentist';

  let slug = base;
  let counter = 1;

  while (true) {
    const existing = await Portfolio.findOne({ slug });
    if (!existing || (excludePortfolioId && String(existing._id) === String(excludePortfolioId))) {
      break;
    }
    counter++;
    slug = `${base}-${counter}`;
  }

  return slug;
}

/**
 * Normalize and validate a dentist-chosen custom slug.
 * Enforces [a-z0-9-], length 3..60, rejects reserved words, and checks global uniqueness.
 */
async function normalizeAndValidateCustomSlug(rawSlug, currentPortfolioId) {
  const normalized = String(rawSlug || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (RESERVED_SLUGS.has(normalized)) {
    const err = new Error('This portfolio URL is reserved. Please choose a different one.');
    err.statusCode = 400;
    throw err;
  }

  if (normalized.length < 3 || normalized.length > 60) {
    const err = new Error('Portfolio URL must be between 3 and 60 characters using letters, numbers, and hyphens.');
    err.statusCode = 400;
    throw err;
  }

  const existing = await Portfolio.findOne({ slug: normalized });
  if (existing && String(existing._id) !== String(currentPortfolioId)) {
    const err = new Error('This portfolio URL is already taken.');
    err.statusCode = 400;
    throw err;
  }

  return normalized;
}

/**
 * Determine whether the request belongs to the active owning dentist of the portfolio.
 */
function isActivePortfolioOwner(req, portfolio) {
  if (!req.dentist || req.dentist.status === 'suspended' || !portfolio?.dentist_id) {
    return false;
  }
  const ownerId = portfolio.dentist_id._id || portfolio.dentist_id;
  return String(req.dentist._id) === String(ownerId);
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
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 12);
  const treatmentTypeFilter = req.query.treatmentType;
  const skip = (page - 1) * limit;

  const portfolio = await Portfolio.findOne({
    slug: req.params.slug,
  }).populate({
    path: 'dentist_id',
    select: 'name profilePhoto status',
  });

  if (!portfolio) {
    res.status(404);
    throw new Error('Portfolio not found');
  }

  // Security: Always block suspended portfolios or suspended dentist accounts (even for owner)
  if (portfolio.isSuspended || !portfolio.dentist_id || portfolio.dentist_id.status === 'suspended') {
    res.status(403);
    throw new Error('This clinical portfolio has been temporarily suspended by the platform administrator.');
  }

  // Allow owner draft preview for the active owning dentist; block everyone else while draft
  const isOwnerPreview = !portfolio.isPublished && isActivePortfolioOwner(req, portfolio);
  if (!portfolio.isPublished && !isOwnerPreview) {
    res.status(403);
    throw new Error('This portfolio is currently in draft mode and not visible to the public.');
  }

  // Sort cases
  let allCases = [...portfolio.publishedCases].sort((a, b) => a.order - b.order);

  // Extract all unique treatment types across the entire portfolio (before filtering)
  const availableTypesSet = new Set(['General']);
  allCases.forEach(c => {
    const types = Array.isArray(c.treatmentType) ? c.treatmentType : (c.treatmentType ? [c.treatmentType] : ['General']);
    types.forEach(t => availableTypesSet.add(t));
  });
  const availableTreatmentTypes = Array.from(availableTypesSet);

  // Apply filtering before pagination
  if (treatmentTypeFilter && treatmentTypeFilter !== 'All') {
    allCases = allCases.filter(c => {
      const types = Array.isArray(c.treatmentType) ? c.treatmentType : [c.treatmentType || 'General'];
      return types.includes(treatmentTypeFilter);
    });
  }

  const totalItems = allCases.length;
  const totalPages = Math.ceil(totalItems / limit) || 1;
  
  const paginatedCases = allCases.slice(skip, skip + limit).map((c) => ({
    _id: c._id,
    title: c.title,
    description: c.description,
    category: c.category,
    treatmentType: Array.isArray(c.treatmentType) ? c.treatmentType : (c.treatmentType ? [c.treatmentType] : ['General']),
    coverImage: c.coverImage,
    beforeImage: c.beforeImage || null,
    afterImage: c.afterImage || null,
    selectedImages: c.selectedImages,
    publishedAt: c.publishedAt,
  }));

  const showClinicInfo = portfolio.showClinicInfo !== false;

  res.json({
    dentist: {
      name: portfolio.dentist_id?.name || '',
      profilePhoto: portfolio.dentist_id?.profilePhoto || {},
    },
    slug: portfolio.slug,
    coverPhoto: portfolio.coverPhoto || null,
    coverTheme: portfolio.coverTheme || DEFAULT_COVER_THEME,
    bio: portfolio.bio,
    yearsOfExperience: portfolio.yearsOfExperience,
    services: portfolio.services,
    contactEmail: portfolio.contactEmail,
    contactPhone: portfolio.contactPhone,
    clinicName: showClinicInfo ? portfolio.clinicName : '',
    clinicAddress: showClinicInfo ? portfolio.clinicAddress : '',
    showClinicInfo,
    isPublished: portfolio.isPublished,
    isDraftPreview: isOwnerPreview,
    availableTreatmentTypes,
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
    select: 'name profilePhoto status',
  });

  if (!portfolio) {
    res.status(404);
    throw new Error('Portfolio not found');
  }

  // Security: Always block suspended portfolios or suspended dentist accounts (even for owner)
  if (portfolio.isSuspended || !portfolio.dentist_id || portfolio.dentist_id.status === 'suspended') {
    res.status(403);
    throw new Error('This case study is part of a portfolio that has been temporarily suspended.');
  }

  const isOwnerPreview = !portfolio.isPublished && isActivePortfolioOwner(req, portfolio);
  if (!portfolio.isPublished && !isOwnerPreview) {
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
    isDraftPreview: isOwnerPreview,
    case: {
      _id: caseItem._id,
      title: caseItem.title,
      description: caseItem.description,
      category: caseItem.category,
      treatmentType: Array.isArray(caseItem.treatmentType) ? caseItem.treatmentType : (caseItem.treatmentType ? [caseItem.treatmentType] : ['General']),
      coverImage: caseItem.coverImage,
      beforeImage: caseItem.beforeImage || null,
      afterImage: caseItem.afterImage || null,
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
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 12);
  const skip = (page - 1) * limit;

  const portfolio = await Portfolio.findOne({ dentist_id: req.dentist._id }).lean();
  
  if (!portfolio) {
    return res.json(null);
  }

  const allCases = (portfolio.publishedCases || []).sort((a, b) => a.order - b.order);
  const totalItems = allCases.length;
  const totalPages = Math.ceil(totalItems / limit) || 1;
  const paginatedCases = allCases.slice(skip, skip + limit).map((c) => ({
    ...c,
    beforeImage: c.beforeImage || null,
    afterImage: c.afterImage || null,
  }));

  res.json({
    ...portfolio,
    coverPhoto: portfolio.coverPhoto || null,
    coverTheme: portfolio.coverTheme || DEFAULT_COVER_THEME,
    showClinicInfo: portfolio.showClinicInfo !== false,
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
 * Create a new portfolio (auto-generates slug and pre-fills contact + primary clinic info).
 * Only one portfolio per dentist.
 */
const createPortfolio = asyncHandler(async (req, res) => {
  const existing = await Portfolio.findOne({ dentist_id: req.dentist._id });
  if (existing) {
    res.status(400);
    throw new Error('You already have a portfolio');
  }

  const slug = await generateUniqueSlug(req.dentist.name);

  // Pre-fill clinicName and clinicAddress from the dentist's primary Clinic if present
  let primaryClinic = null;
  try {
    const clinicQuery = Clinic.findOne({ dentist_id: req.dentist._id });
    if (clinicQuery && typeof clinicQuery.sort === 'function') {
      primaryClinic = await clinicQuery.sort({ createdAt: 1 }).lean();
    } else {
      primaryClinic = await clinicQuery;
    }
  } catch {
    primaryClinic = null;
  }

  const portfolio = await Portfolio.create({
    dentist_id: req.dentist._id,
    slug,
    bio: req.body.bio || '',
    yearsOfExperience: req.body.yearsOfExperience || 0,
    services: req.body.services || [],
    contactEmail: req.body.contactEmail || req.dentist.email,
    contactPhone: req.body.contactPhone || req.dentist.phone || '',
    clinicName: req.body.clinicName !== undefined ? req.body.clinicName : (primaryClinic?.name || ''),
    clinicAddress: req.body.clinicAddress !== undefined ? req.body.clinicAddress : (primaryClinic?.address || ''),
    showClinicInfo: req.body.showClinicInfo !== undefined ? Boolean(req.body.showClinicInfo) : true,
  });

  res.status(201).json(portfolio);
});

/**
 * PUT /api/portfolio
 * Update portfolio bio, services, contact info, clinic visibility, cover theme/photo, and custom slug.
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

  if (req.body.showClinicInfo !== undefined) {
    portfolio.showClinicInfo = Boolean(req.body.showClinicInfo);
  }

  if (req.body.slug !== undefined) {
    portfolio.slug = await normalizeAndValidateCustomSlug(req.body.slug, portfolio._id);
  }

  if (req.body.coverTheme !== undefined) {
    const theme = typeof req.body.coverTheme === 'string' ? req.body.coverTheme.trim() : '';
    if (!ALLOWED_COVER_THEMES.has(theme)) {
      res.status(400);
      throw new Error('Invalid cover theme preset.');
    }
    portfolio.coverTheme = theme;
  }

  const previousCoverPhoto = portfolio.coverPhoto || null;
  if (req.body.coverPhoto !== undefined) {
    if (req.body.coverPhoto === null || req.body.coverPhoto === '') {
      portfolio.coverPhoto = null;
    } else {
      res.status(400);
      throw new Error('Use the cover upload endpoint to set a custom cover photo.');
    }
  }

  await portfolio.save();

  if (previousCoverPhoto && portfolio.coverPhoto !== previousCoverPhoto) {
    await destroyUnreferencedMediaUrls(req.dentist._id, [previousCoverPhoto]);
  }

  res.json(portfolio);
});

/**
 * POST /api/portfolio/me/portfolio/cover
 * Upload and save a custom profile cover photo (JPG, PNG, WebP, max 5MB).
 * Saves DB reference first, then cleans up the previous unreferenced cover asset.
 */
const uploadPortfolioCover = asyncHandler(async (req, res) => {
  if (!req.file?.path) {
    res.status(400);
    throw new Error('Cover image file is required');
  }

  const portfolio = await Portfolio.findOne({ dentist_id: req.dentist._id });
  if (!portfolio) {
    await cleanupUploadedFiles([req.file]);
    res.status(404);
    throw new Error('No portfolio found. Create one first.');
  }

  const previousCoverPhoto = portfolio.coverPhoto || null;
  portfolio.coverPhoto = req.file.path;

  try {
    await portfolio.save();
  } catch (saveErr) {
    await cleanupUploadedFiles([req.file]);
    throw saveErr;
  }

  if (previousCoverPhoto && previousCoverPhoto !== portfolio.coverPhoto) {
    await destroyUnreferencedMediaUrls(req.dentist._id, [previousCoverPhoto]);
  }

  res.json({
    coverPhoto: portfolio.coverPhoto,
    coverTheme: portfolio.coverTheme || DEFAULT_COVER_THEME,
  });
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

  const {
    title,
    description,
    category,
    treatmentType,
    selectedImages,
    coverImage,
    beforeImage,
    afterImage,
  } = req.body;
  const trimmedTitle = typeof title === 'string' ? title.trim() : '';

  if (!trimmedTitle) {
    res.status(400);
    throw new Error('Case title is required');
  }

  const allowedUrls = await getAllowedMediaSet(
    req.dentist._id,
    getPortfolioMediaUrls(portfolio)
  );
  const { selectedImages: validatedImages, coverImage: validatedCover } =
    normalizeAndValidateCaseImages(selectedImages, coverImage, allowedUrls, req.dentist._id);
  const { beforeImage: validatedBefore, afterImage: validatedAfter } =
    normalizeAndValidateBeforeAfter(beforeImage, afterImage, validatedImages);

  // Normalize treatmentType: accept string or array, always store as array
  let normalizedType = ['General'];
  if (Array.isArray(treatmentType) && treatmentType.length > 0) {
    normalizedType = treatmentType;
  } else if (typeof treatmentType === 'string' && treatmentType.trim()) {
    normalizedType = [treatmentType.trim()];
  }

  const nextOrder =
    portfolio.publishedCases.length > 0
      ? Math.max(
          ...portfolio.publishedCases.map((c, idx) =>
            typeof c.order === 'number' ? c.order : idx
          )
        ) + 1
      : 0;

  const newCase = {
    session_id: req.body.session_id || new mongoose.Types.ObjectId(),
    title: trimmedTitle,
    description: description || '',
    category: category || '',
    treatmentType: normalizedType,
    selectedImages: validatedImages,
    coverImage: validatedCover,
    beforeImage: validatedBefore,
    afterImage: validatedAfter,
    order: nextOrder,
    publishedAt: new Date(),
  };

  portfolio.publishedCases.push(newCase);
  await portfolio.save();

  const saved = portfolio.publishedCases[portfolio.publishedCases.length - 1];
  res.status(201).json(saved);
});

/**
 * PUT /api/portfolio/cases/:caseId
 * Edit a published case's title, description, category, treatmentType, images, and cover.
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

  if (req.body.title !== undefined) {
    const trimmedTitle = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!trimmedTitle) {
      res.status(400);
      throw new Error('Case title is required');
    }
    caseItem.title = trimmedTitle;
  }

  if (req.body.description !== undefined) caseItem.description = req.body.description;
  if (req.body.category !== undefined) caseItem.category = req.body.category;
  if (req.body.treatmentType !== undefined) {
    const tt = req.body.treatmentType;
    if (Array.isArray(tt)) {
      const cleaned = tt.filter((t) => typeof t === 'string' && t.trim());
      caseItem.treatmentType = cleaned.length > 0 ? cleaned : ['General'];
    } else if (typeof tt === 'string' && tt.trim()) {
      caseItem.treatmentType = [tt.trim()];
    } else {
      caseItem.treatmentType = ['General'];
    }
  }

  const previousImages = [
    ...(caseItem.selectedImages || []),
    ...(caseItem.coverImage ? [caseItem.coverImage] : []),
  ];

  if (req.body.selectedImages !== undefined) {
    const allowedUrls = await getAllowedMediaSet(req.dentist._id, [
      ...getPortfolioMediaUrls(portfolio),
      ...previousImages,
    ]);
    const candidateCover =
      req.body.coverImage !== undefined ? req.body.coverImage : caseItem.coverImage;
    const { selectedImages: validatedImages, coverImage: validatedCover } =
      normalizeAndValidateCaseImages(
        req.body.selectedImages,
        candidateCover,
        allowedUrls,
        req.dentist._id
      );
    caseItem.selectedImages = validatedImages;
    caseItem.coverImage = validatedCover;
  } else if (req.body.coverImage !== undefined) {
    const candidateCover = typeof req.body.coverImage === 'string' ? req.body.coverImage.trim() : '';
    if (!candidateCover || !(caseItem.selectedImages || []).includes(candidateCover)) {
      res.status(400);
      throw new Error('Cover image must be one of the selected case images');
    }
    caseItem.coverImage = candidateCover;
  }

  // Validate or auto-reconcile Before / After selections against final selectedImages
  const hasBeforeInBody = req.body.beforeImage !== undefined;
  const hasAfterInBody = req.body.afterImage !== undefined;
  if (hasBeforeInBody || hasAfterInBody) {
    const { beforeImage: validatedBefore, afterImage: validatedAfter } =
      normalizeAndValidateBeforeAfter(
        req.body.beforeImage,
        req.body.afterImage,
        caseItem.selectedImages
      );
    caseItem.beforeImage = validatedBefore;
    caseItem.afterImage = validatedAfter;
  } else if (req.body.selectedImages !== undefined) {
    const currentImages = caseItem.selectedImages || [];
    const existingBefore = caseItem.beforeImage || null;
    const existingAfter = caseItem.afterImage || null;
    const stillValid =
      currentImages.length >= 2 &&
      Boolean(existingBefore) &&
      Boolean(existingAfter) &&
      existingBefore !== existingAfter &&
      currentImages.includes(existingBefore) &&
      currentImages.includes(existingAfter);
    if (!stillValid) {
      caseItem.beforeImage = null;
      caseItem.afterImage = null;
    }
  }

  await portfolio.save();

  // Best-effort cleanup of any images removed from this case that are no longer referenced anywhere
  const currentSet = new Set([
    ...(caseItem.selectedImages || []),
    ...(caseItem.coverImage ? [caseItem.coverImage] : []),
  ]);
  const removedUrls = previousImages.filter((url) => !currentSet.has(url));
  if (removedUrls.length > 0) {
    await destroyUnreferencedMediaUrls(req.dentist._id, removedUrls);
  }

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

  const removedCase = portfolio.publishedCases[caseIndex];
  const removedUrls = [
    ...(removedCase.selectedImages || []),
    ...(removedCase.coverImage ? [removedCase.coverImage] : []),
  ];

  portfolio.publishedCases.splice(caseIndex, 1);

  // Re-index remaining cases contiguously by their existing order
  portfolio.publishedCases.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  portfolio.publishedCases.forEach((c, i) => {
    c.order = i;
  });
  portfolio.markModified('publishedCases');

  await portfolio.save();

  // Best-effort cleanup of images only if no active session or other portfolio case references them
  if (removedUrls.length > 0) {
    await destroyUnreferencedMediaUrls(req.dentist._id, removedUrls);
  }

  res.json({ message: 'Case removed from portfolio' });
});

/**
 * GET /api/portfolio/media-library
 * Return all Cloudinary image URLs from the dentist's active sessions (excluding soft-deleted patients).
 * This powers the "image picker" in the editor.
 */
const getMediaLibrary = asyncHandler(async (req, res) => {
  const sessions = await Session.find({
    dentist_id: req.dentist._id,
    isDeleted: { $ne: true },
    media_urls: { $exists: true, $ne: [] },
  })
    .select('media_urls treatment_category date patient_id')
    .populate('patient_id', 'name isDeleted')
    .sort({ date: -1 })
    .lean();

  // Exclude sessions belonging to soft-deleted patients
  const activeSessions = sessions.filter((s) => s.patient_id?.isDeleted !== true);

  // Group images by session with minimal context
  const library = activeSessions.map((s) => ({
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
  if (direction !== 'up' && direction !== 'down') {
    res.status(400);
    throw new Error('Invalid reorder direction. Must be "up" or "down".');
  }

  const portfolio = await Portfolio.findOne({ dentist_id: req.dentist._id });

  if (!portfolio) {
    res.status(404);
    throw new Error('Portfolio not found');
  }

  // Ensure array order matches display order before swapping
  const cases = portfolio.publishedCases;
  cases.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

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

  // Re-sync contiguous order numbers
  cases.forEach((c, i) => {
    c.order = i;
  });
  portfolio.markModified('publishedCases');

  await portfolio.save();
  res.json(portfolio.publishedCases);
});

/**
 * POST /api/portfolio/upload-images
 * Upload up to 8 images directly from the dentist's device to a dentist-scoped
 * Cloudinary portfolio folder (`antigravity/portfolio/<dentistId>`).
 */
const uploadCaseImages = asyncHandler(async (req, res) => {
  if (!Array.isArray(req.files) || req.files.length === 0) {
    res.status(400);
    throw new Error('At least one image file is required');
  }

  if (req.files.length > MAX_CASE_IMAGES) {
    await cleanupUploadedFiles(req.files);
    res.status(400);
    throw new Error(`Maximum of ${MAX_CASE_IMAGES} images allowed per upload`);
  }

  const urls = req.files
    .map((file) => file?.path)
    .filter((url) => typeof url === 'string' && url.trim());

  if (urls.length === 0) {
    await cleanupUploadedFiles(req.files);
    res.status(400);
    throw new Error('Failed to process uploaded images');
  }

  res.status(201).json({
    urls,
    count: urls.length,
  });
});

module.exports = {
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
};
