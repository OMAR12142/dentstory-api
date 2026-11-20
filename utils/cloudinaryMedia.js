const cloudinary = require('../config/cloudinary');
const Session = require('../models/Session');
const Portfolio = require('../models/Portfolio');

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MANAGED_SESSION_FOLDER = 'antigravity/sessions/';
const MANAGED_PORTFOLIO_FOLDER = 'antigravity/portfolio/';
const MANAGED_CV_FOLDER = 'dentstory/portfolios/cv/';
const MANAGED_MEDIA_FOLDERS = [MANAGED_SESSION_FOLDER, MANAGED_PORTFOLIO_FOLDER, MANAGED_CV_FOLDER];

/**
 * Extract the Cloudinary public_id for managed session or portfolio images.
 * Returns null for non-Cloudinary or unmanaged URLs (e.g., avatars or external links).
 */
function extractCloudinaryPublicId(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') {
    return null;
  }

  const pathname = parsed.pathname || '';
  for (const folder of MANAGED_MEDIA_FOLDERS) {
    const folderIdx = pathname.indexOf(folder);
    if (folderIdx !== -1) {
      const relativePath = pathname.slice(folderIdx);
      if (relativePath.includes('..')) return null;
      return relativePath.replace(/\.[^/.]+$/, '');
    }
  }
  return null;
}

/**
 * Verify whether a URL is a direct Cloudinary portfolio upload strictly scoped
 * to the given dentist's folder: antigravity/portfolio/<dentistId>/<asset>.
 */
function isOwnedPortfolioUploadUrl(url, dentistId) {
  if (!dentistId) return false;
  const publicId = extractCloudinaryPublicId(url);
  if (!publicId) return false;
  const expectedPrefix = `${MANAGED_PORTFOLIO_FOLDER}${String(dentistId)}/`;
  return publicId.startsWith(expectedPrefix) && publicId.length > expectedPrefix.length;
}

/**
 * Best-effort destroy of a single Cloudinary asset. Never throws.
 * Supports both 'raw' and 'image' resource types with fallback
 * so legacy and new CV assets are safely cleaned up.
 */
async function safeDestroyAsset(publicId, options = {}) {
  if (!publicId) return false;
  try {
    const opts = typeof options === 'string' ? { resource_type: options } : { ...options };
    if (opts.resource_type) {
      const res = await cloudinary.uploader.destroy(publicId, opts);
      if (res?.result === 'ok') return true;
      const fallbackType = opts.resource_type === 'raw' ? 'image' : 'raw';
      await cloudinary.uploader.destroy(publicId, { ...opts, resource_type: fallbackType });
      return true;
    }

    if (publicId.startsWith(MANAGED_CV_FOLDER)) {
      const res = await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
      if (res?.result === 'ok') return true;
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
      return true;
    }

    const res = await cloudinary.uploader.destroy(publicId);
    if (res?.result === 'not found') {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up files already streamed to Cloudinary by Multer when a controller
 * rejects the request before saving to MongoDB.
 */
async function cleanupUploadedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return;
  const publicIds = files
    .map((f) => f?.filename || extractCloudinaryPublicId(f?.path))
    .filter(Boolean);

  await Promise.all(publicIds.map((id) => safeDestroyAsset(id)));
}

/**
 * Safely destroy candidate session image URLs from Cloudinary ONLY when they
 * are no longer referenced by any active Session OR any Portfolio publishedCase
 * belonging to the dentist.
 */
async function destroyUnreferencedMediaUrls(dentistId, candidateUrls) {
  if (!dentistId || !Array.isArray(candidateUrls) || candidateUrls.length === 0) {
    return { destroyed: [], preserved: [] };
  }

  const uniqueCandidates = [...new Set(candidateUrls.filter((u) => extractCloudinaryPublicId(u)))];
  if (uniqueCandidates.length === 0) {
    return { destroyed: [], preserved: [] };
  }

  const [activeSessions, portfolio] = await Promise.all([
    Session.find({
      dentist_id: dentistId,
      isDeleted: { $ne: true },
      media_urls: { $in: uniqueCandidates },
    })
      .select('media_urls')
      .lean(),
    Portfolio.findOne({ dentist_id: dentistId })
      .select('coverPhoto publishedCases.selectedImages publishedCases.coverImage')
      .lean(),
  ]);

  const stillReferenced = new Set();
  for (const s of activeSessions || []) {
    for (const url of s.media_urls || []) {
      stillReferenced.add(url);
    }
  }
  if (portfolio?.coverPhoto) {
    stillReferenced.add(portfolio.coverPhoto);
  }
  for (const c of portfolio?.publishedCases || []) {
    if (c.coverImage) stillReferenced.add(c.coverImage);
    for (const url of c.selectedImages || []) {
      stillReferenced.add(url);
    }
  }

  const destroyed = [];
  const preserved = [];

  for (const url of uniqueCandidates) {
    if (stillReferenced.has(url)) {
      preserved.push(url);
    } else {
      const publicId = extractCloudinaryPublicId(url);
      if (publicId) {
        await safeDestroyAsset(publicId);
        destroyed.push(publicId);
      }
    }
  }

  return { destroyed, preserved };
}

module.exports = {
  ALLOWED_IMAGE_MIMES,
  MANAGED_SESSION_FOLDER,
  MANAGED_PORTFOLIO_FOLDER,
  MANAGED_CV_FOLDER,
  extractCloudinaryPublicId,
  isOwnedPortfolioUploadUrl,
  safeDestroyAsset,
  cleanupUploadedFiles,
  destroyUnreferencedMediaUrls,
};

