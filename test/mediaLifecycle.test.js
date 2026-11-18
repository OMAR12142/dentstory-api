const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const multer = require('multer');

process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret';
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'demo';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || 'test-key';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'test-secret';

const cloudinary = require('../config/cloudinary');
const Dentist = require('../models/Dentist');
const Patient = require('../models/Patient');
const Clinic = require('../models/Clinic');
const Session = require('../models/Session');
const Portfolio = require('../models/Portfolio');
const errorHandler = require('../middleware/errorHandler');
const { imageFileFilter } = require('../middleware/uploadMiddleware');
const { extractCloudinaryPublicId, isOwnedPortfolioUploadUrl } = require('../utils/cloudinaryMedia');
const portfolioRoutes = require('../routes/portfolioRoutes');
const { uploadCaseImages, uploadPortfolioCover } = require('../controllers/portfolioController');
const { createSession, updateSession, deleteSession } = require('../controllers/sessionController');
const { protect } = require('../middleware/authMiddleware');

// ── Test IDs & URLs ──────────────────────────────────────────
const DENTIST_ID = new mongoose.Types.ObjectId();
const SUSPENDED_DENTIST_ID = new mongoose.Types.ObjectId();
const OTHER_DENTIST_ID = new mongoose.Types.ObjectId();
const CLINIC_ID = new mongoose.Types.ObjectId();
const PATIENT_ACTIVE_ID = new mongoose.Types.ObjectId();
const PATIENT_DELETED_ID = new mongoose.Types.ObjectId();

const URL_1 = 'https://res.cloudinary.com/demo/image/upload/v1700000001/antigravity/sessions/img_one.jpg';
const URL_2 = 'https://res.cloudinary.com/demo/image/upload/v1700000002/antigravity/sessions/img_two.png';
const URL_3 = 'https://res.cloudinary.com/demo/image/upload/v1700000003/antigravity/sessions/img_three.webp';
const URL_ORPHAN = 'https://res.cloudinary.com/demo/image/upload/v1700000004/antigravity/sessions/img_orphan.jpg';
const URL_FOREIGN = 'https://res.cloudinary.com/demo/image/upload/v1700000009/antigravity/sessions/other_doc.jpg';
const makeDirectUrl = (dentistId, name) =>
  `https://res.cloudinary.com/demo/image/upload/v1700000010/antigravity/portfolio/${dentistId}/${name}.jpg`;

// ── In-memory DB stores ──────────────────────────────────────
let dentists = new Map();
let clinics = new Map();
let patients = new Map();
let sessions = [];
let portfolios = new Map();
let destroyedPublicIds = [];
let forceDestroyError = false;

function makePortfolioDoc(data) {
  const cases = data.publishedCases.map((c) => ({
    _id: c._id || new mongoose.Types.ObjectId(),
    ...c,
  }));
  const origPush = cases.push.bind(cases);
  cases.push = function (...items) {
    return origPush(
      ...items.map((item) => ({
        _id: item._id || new mongoose.Types.ObjectId(),
        ...item,
      }))
    );
  };
  cases.id = function (id) {
    return this.find((c) => String(c._id) === String(id)) || null;
  };
  return {
    ...data,
    publishedCases: cases,
    markModified: () => {},
    save: async function () {
      portfolios.set(String(this.dentist_id), this);
      return this;
    },
  };
}

function makeSessionDoc(data) {
  return {
    ...data,
    isDeleted: data.isDeleted ?? false,
    media_urls: [...(data.media_urls || [])],
    save: async function () {
      const idx = sessions.findIndex((s) => String(s._id) === String(this._id));
      if (idx === -1) sessions.push(this);
      else sessions[idx] = this;
      return this;
    },
  };
}

function signToken(id) {
  return jwt.sign({ id: String(id) }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
}

// ── Express app wiring real routes, middleware, errorHandler ──
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/portfolio', portfolioRoutes);

// Test helper routes invoking real session controllers with simulated Multer req.files
app.post('/test/sessions', protect, (req, _res, next) => {
  if (Array.isArray(req.body._mockFiles)) {
    req.files = req.body._mockFiles;
    delete req.body._mockFiles;
  }
  next();
}, createSession);

app.put('/test/sessions/:id', protect, (req, _res, next) => {
  if (Array.isArray(req.body._mockFiles)) {
    req.files = req.body._mockFiles;
    delete req.body._mockFiles;
  }
  next();
}, updateSession);

app.delete('/test/sessions/:id', protect, deleteSession);

// Test helper route invoking real uploadCaseImages controller with simulated Multer req.files
app.post('/test/portfolio/upload-images', protect, (req, _res, next) => {
  if (Array.isArray(req.body._mockFiles)) {
    req.files = req.body._mockFiles;
    delete req.body._mockFiles;
  }
  next();
}, uploadCaseImages);

// Test helper route invoking real uploadPortfolioCover controller with simulated Multer req.file
app.post('/test/portfolio/me/portfolio/cover', protect, (req, _res, next) => {
  if (req.body._mockFile) {
    req.file = req.body._mockFile;
    delete req.body._mockFile;
  }
  next();
}, uploadPortfolioCover);

// Route to exercise MulterError handling through real errorHandler
app.get('/test/multer-error/:code', (_req, _res, next) => {
  next(new multer.MulterError(_req.params.code));
});

app.get('/test/portfolio/multer-error/:code', (_req, _res, next) => {
  next(new multer.MulterError(_req.params.code));
});

app.use(errorHandler);

// ── Patch Mongoose models & Cloudinary spy ───────────────────
const originals = {
  dentistFindById: Dentist.findById,
  clinicFindById: Clinic.findById,
  clinicFindOne: Clinic.findOne,
  patientFindById: Patient.findById,
  sessionFind: Session.find,
  sessionFindOne: Session.findOne,
  sessionFindByIdAndUpdate: Session.findByIdAndUpdate,
  sessionFindOneAndUpdate: Session.findOneAndUpdate,
  sessionCreate: Session.create,
  portfolioFindOne: Portfolio.findOne,
  portfolioCreate: Portfolio.create,
  cloudinaryDestroy: cloudinary.uploader.destroy,
};

function matchesSessionFilter(s, filter = {}) {
  if (filter._id && String(s._id) !== String(filter._id)) return false;
  if (filter.dentist_id && String(s.dentist_id) !== String(filter.dentist_id)) return false;
  if (filter.isDeleted && typeof filter.isDeleted === 'object' && '$ne' in filter.isDeleted) {
    if (s.isDeleted === filter.isDeleted.$ne) return false;
  }
  if (filter.media_urls && typeof filter.media_urls === 'object') {
    if (filter.media_urls.$exists && !Array.isArray(s.media_urls)) return false;
    if (Array.isArray(filter.media_urls.$ne) && filter.media_urls.$ne.length === 0) {
      if (!s.media_urls || s.media_urls.length === 0) return false;
    }
    if (Array.isArray(filter.media_urls.$in)) {
      const set = new Set(filter.media_urls.$in);
      if (!(s.media_urls || []).some((u) => set.has(u))) return false;
    }
  }
  return true;
}

function makeSessionQuery(list) {
  let populatePatient = false;
  const q = {
    select() { return q; },
    populate(field) {
      if (field === 'patient_id') populatePatient = true;
      return q;
    },
    sort() { return q; },
    lean() {
      return Promise.resolve(
        list.map((s) => ({
          ...s,
          media_urls: [...(s.media_urls || [])],
          patient_id: populatePatient ? (patients.get(String(s.patient_id)) || null) : s.patient_id,
        }))
      );
    },
    then(resolve, reject) {
      return Promise.resolve(list).then(resolve, reject);
    },
  };
  return q;
}

function installMocks() {
  Dentist.findById = (id) => {
    const doc = dentists.get(String(id)) || null;
    return {
      select: async () => (doc ? { ...doc } : null),
      then: (res, rej) => Promise.resolve(doc).then(res, rej),
    };
  };

  Clinic.findById = async (id) => clinics.get(String(id)) || null;
  Clinic.findOne = (filter = {}) => {
    let found = null;
    for (const c of clinics.values()) {
      if (filter.dentist_id && String(c.dentist_id) !== String(filter.dentist_id)) continue;
      found = c;
      break;
    }
    const q = {
      sort() { return q; },
      lean: async () => (found ? { ...found } : null),
      then: (res, rej) => Promise.resolve(found).then(res, rej),
    };
    return q;
  };
  Patient.findById = (id) => {
    const doc = patients.get(String(id)) || null;
    return {
      populate: async () => {
        if (!doc) return null;
        return {
          ...doc,
          clinic_id: clinics.get(String(doc.clinic_id)) || doc.clinic_id,
        };
      },
      then: (res, rej) => Promise.resolve(doc).then(res, rej),
    };
  };

  Session.find = (filter = {}) => {
    const matched = sessions.filter((s) => matchesSessionFilter(s, filter));
    return makeSessionQuery(matched);
  };

  Session.findOne = async (filter = {}) => {
    return sessions.find((s) => matchesSessionFilter(s, filter)) || null;
  };

  Session.findByIdAndUpdate = async (id, update) => {
    const s = sessions.find((item) => String(item._id) === String(id));
    if (!s) return null;
    Object.assign(s, update);
    return s;
  };

  Session.findOneAndUpdate = async (filter, update) => {
    const s = sessions.find((item) => matchesSessionFilter(item, filter));
    if (!s) return null;
    Object.assign(s, update);
    return s;
  };

  Session.create = async (data) => {
    const doc = makeSessionDoc({ _id: new mongoose.Types.ObjectId(), ...data });
    sessions.push(doc);
    return doc;
  };

  Portfolio.findOne = (filter = {}) => {
    let found = null;
    for (const p of portfolios.values()) {
      if (filter.dentist_id && String(p.dentist_id) !== String(filter.dentist_id)) continue;
      if (filter.slug && p.slug !== filter.slug) continue;
      found = p;
      break;
    }
    let shouldPopulateDentist = false;
    const resolveDoc = () => {
      if (!found) return null;
      if (!shouldPopulateDentist) return found;
      return {
        ...found,
        dentist_id: dentists.get(String(found.dentist_id)) || null,
      };
    };
    return {
      select() { return this; },
      populate(arg) {
        if (arg === 'dentist_id' || arg?.path === 'dentist_id') {
          shouldPopulateDentist = true;
        }
        return this;
      },
      lean: async () => {
        const d = resolveDoc();
        return d ? { ...d, publishedCases: d.publishedCases.map((c) => ({ ...c })) } : null;
      },
      then: (res, rej) => Promise.resolve(resolveDoc()).then(res, rej),
    };
  };

  Portfolio.create = async (data) => {
    const doc = makePortfolioDoc({
      _id: new mongoose.Types.ObjectId(),
      isPublished: false,
      showClinicInfo: data.showClinicInfo !== undefined ? data.showClinicInfo : true,
      coverPhoto: null,
      coverTheme: 'clinical-blue',
      publishedCases: [],
      ...data,
    });
    portfolios.set(String(doc.dentist_id), doc);
    return doc;
  };

  cloudinary.uploader.destroy = async (publicId) => {
    if (forceDestroyError) {
      throw new Error('Simulated Cloudinary network failure');
    }
    destroyedPublicIds.push(publicId);
    return { result: 'ok' };
  };
}

function restoreMocks() {
  Dentist.findById = originals.dentistFindById;
  Clinic.findById = originals.clinicFindById;
  Clinic.findOne = originals.clinicFindOne;
  Patient.findById = originals.patientFindById;
  Session.find = originals.sessionFind;
  Session.findOne = originals.sessionFindOne;
  Session.findByIdAndUpdate = originals.sessionFindByIdAndUpdate;
  Session.findOneAndUpdate = originals.sessionFindOneAndUpdate;
  Session.create = originals.sessionCreate;
  Portfolio.findOne = originals.portfolioFindOne;
  Portfolio.create = originals.portfolioCreate;
  cloudinary.uploader.destroy = originals.cloudinaryDestroy;
}

function resetFixture() {
  destroyedPublicIds = [];
  forceDestroyError = false;
  dentists = new Map();
  clinics = new Map();
  patients = new Map();
  sessions = [];
  portfolios = new Map();

  dentists.set(String(DENTIST_ID), {
    _id: DENTIST_ID,
    name: 'Dr. Media',
    email: 'media@example.com',
    role: 'dentist',
    status: 'active',
  });

  dentists.set(String(SUSPENDED_DENTIST_ID), {
    _id: SUSPENDED_DENTIST_ID,
    name: 'Dr. Suspended',
    email: 'suspended@example.com',
    role: 'dentist',
    status: 'suspended',
  });

  clinics.set(String(CLINIC_ID), {
    _id: CLINIC_ID,
    dentist_id: DENTIST_ID,
    name: 'Main Clinic',
    default_commission_percentage: 50,
  });

  patients.set(String(PATIENT_ACTIVE_ID), {
    _id: PATIENT_ACTIVE_ID,
    dentist_id: DENTIST_ID,
    clinic_id: CLINIC_ID,
    name: 'Active Patient',
    isDeleted: false,
  });

  patients.set(String(PATIENT_DELETED_ID), {
    _id: PATIENT_DELETED_ID,
    dentist_id: DENTIST_ID,
    clinic_id: CLINIC_ID,
    name: 'Deleted Patient',
    isDeleted: true,
  });

  sessions.push(
    makeSessionDoc({
      _id: new mongoose.Types.ObjectId(),
      dentist_id: DENTIST_ID,
      clinic_id: CLINIC_ID,
      patient_id: PATIENT_ACTIVE_ID,
      date: new Date('2026-10-01'),
      treatment_category: ['Implant'],
      total_cost: 1000,
      amount_paid: 500,
      media_urls: [URL_1, URL_2, URL_3],
      isDeleted: false,
    }),
    makeSessionDoc({
      _id: new mongoose.Types.ObjectId(),
      dentist_id: DENTIST_ID,
      clinic_id: CLINIC_ID,
      patient_id: PATIENT_DELETED_ID,
      date: new Date('2026-09-01'),
      treatment_category: ['Endo'],
      total_cost: 500,
      amount_paid: 500,
      media_urls: [URL_ORPHAN],
      isDeleted: false,
    }),
    makeSessionDoc({
      _id: new mongoose.Types.ObjectId(),
      dentist_id: OTHER_DENTIST_ID,
      clinic_id: new mongoose.Types.ObjectId(),
      patient_id: new mongoose.Types.ObjectId(),
      date: new Date('2026-08-01'),
      treatment_category: ['Surgery'],
      media_urls: [URL_FOREIGN],
      isDeleted: false,
    })
  );

  portfolios.set(
    String(DENTIST_ID),
    makePortfolioDoc({
      _id: new mongoose.Types.ObjectId(),
      dentist_id: DENTIST_ID,
      slug: 'dr-media',
      isPublished: true,
      publishedCases: [],
    })
  );
}

let server;
let baseUrl;

test.before(async () => {
  installMocks();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  restoreMocks();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json };
}

// ── Tests ────────────────────────────────────────────────────

test('1. Upload validation rejects disallowed MIME types and normalizes MulterError to 400', async () => {
  const checkMime = (mimetype) =>
    new Promise((resolve) => {
      imageFileFilter({}, { mimetype }, (err, accepted) => resolve({ err, accepted }));
    });

  for (const allowed of ['image/jpeg', 'image/png', 'image/webp']) {
    const res = await checkMime(allowed);
    assert.equal(res.err, null);
    assert.equal(res.accepted, true);
  }

  for (const blocked of ['application/pdf', 'image/gif', 'image/svg+xml', 'text/plain']) {
    const res = await checkMime(blocked);
    assert.ok(res.err instanceof Error);
    assert.equal(res.err.statusCode, 400);
    assert.match(res.err.message, /JPG, PNG, and WebP/i);
  }

  const sizeErr = await request('/test/multer-error/LIMIT_FILE_SIZE');
  assert.equal(sizeErr.status, 400);
  assert.match(sizeErr.json.message, /too large/i);

  const countErr = await request('/test/multer-error/LIMIT_FILE_COUNT');
  assert.equal(countErr.status, 400);
  assert.match(countErr.json.message, /Maximum of 5 images/i);

  assert.equal(
    extractCloudinaryPublicId(URL_1),
    'antigravity/sessions/img_one'
  );
  assert.equal(
    extractCloudinaryPublicId('https://example.com/external/photo.jpg'),
    null
  );
});

test('2. Orphan upload cleanup destroys Multer-uploaded files when session creation aborts on validation', async () => {
  resetFixture();
  const token = signToken(DENTIST_ID);

  const res = await request('/test/sessions', {
    method: 'POST',
    token,
    body: {
      patient_id: String(new mongoose.Types.ObjectId()), // non-existent patient -> 403
      treatment_category: ['Implant'],
      _mockFiles: [
        { path: URL_1, filename: 'antigravity/sessions/orphan_a' },
        { path: URL_2, filename: 'antigravity/sessions/orphan_b' },
      ],
    },
  });

  assert.equal(res.status, 403);
  assert.deepEqual(destroyedPublicIds, [
    'antigravity/sessions/orphan_a',
    'antigravity/sessions/orphan_b',
  ]);
});

test('3. Media deletion reference safety: preserves assets referenced by Portfolio cases and destroys unreferenced ones', async () => {
  resetFixture();
  const token = signToken(DENTIST_ID);
  const activeSession = sessions[0];

  // Publish a portfolio case referencing URL_1 (but NOT URL_2 or URL_3)
  const pubRes = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Implant Case',
      treatmentType: ['Implant'],
      selectedImages: [URL_1],
      coverImage: URL_1,
    },
  });
  assert.equal(pubRes.status, 201);

  // Update session to remove URL_1 (still in portfolio) and URL_2 (unreferenced anywhere), keeping URL_3
  const updRes = await request(`/test/sessions/${activeSession._id}`, {
    method: 'PUT',
    token,
    body: {
      existing_media: JSON.stringify([URL_3]),
    },
  });
  assert.equal(updRes.status, 200);

  // URL_2 must be destroyed; URL_1 must be PRESERVED because the portfolio case still uses it!
  assert.deepEqual(destroyedPublicIds, ['antigravity/sessions/img_two']);

  // Now delete the session altogether -> URL_3 becomes unreferenced and must be destroyed
  destroyedPublicIds = [];
  const delRes = await request(`/test/sessions/${activeSession._id}`, {
    method: 'DELETE',
    token,
  });
  assert.equal(delRes.status, 200);
  assert.deepEqual(destroyedPublicIds, ['antigravity/sessions/img_three']);
});

test('4. Case edit & delete cleanup respects active session references and tolerates Cloudinary failures', async () => {
  resetFixture();
  const token = signToken(DENTIST_ID);
  const activeSession = sessions[0];

  // Publish case with [URL_1, URL_2]
  const pubRes = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Crown Case',
      treatmentType: ['Fixed'],
      selectedImages: [URL_1, URL_2],
      coverImage: URL_2,
    },
  });
  assert.equal(pubRes.status, 201);
  const caseId = pubRes.json._id;

  // Edit case removing URL_2 while URL_2 is still in activeSession -> must NOT destroy URL_2
  const edit1 = await request(`/api/portfolio/me/portfolio/cases/${caseId}`, {
    method: 'PUT',
    token,
    body: {
      selectedImages: [URL_1],
    },
  });
  assert.equal(edit1.status, 200);
  // Cover was URL_2 (removed), so cover must auto-resolve to URL_1
  assert.equal(edit1.json.coverImage, URL_1);
  assert.deepEqual(destroyedPublicIds, []);

  // Delete activeSession -> URL_2 and URL_3 are unreferenced and destroyed, URL_1 is preserved by case
  await request(`/test/sessions/${activeSession._id}`, { method: 'DELETE', token });
  assert.deepEqual(destroyedPublicIds.sort(), [
    'antigravity/sessions/img_three',
    'antigravity/sessions/img_two',
  ]);

  // Editing the case while its source session is deleted must STILL allow keeping URL_1
  const edit2 = await request(`/api/portfolio/me/portfolio/cases/${caseId}`, {
    method: 'PUT',
    token,
    body: {
      title: 'Crown Case Updated',
      selectedImages: [URL_1],
    },
  });
  assert.equal(edit2.status, 200);
  assert.equal(edit2.json.title, 'Crown Case Updated');

  // Now delete the case -> URL_1 has zero remaining references and must be destroyed
  destroyedPublicIds = [];
  const delCase = await request(`/api/portfolio/me/portfolio/cases/${caseId}`, {
    method: 'DELETE',
    token,
  });
  assert.equal(delCase.status, 200);
  assert.deepEqual(destroyedPublicIds, ['antigravity/sessions/img_one']);

  // Verify Cloudinary destroy error never crashes case deletion
  resetFixture();
  const pubRes2 = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: { title: 'Resilience Case', selectedImages: [URL_1] },
  });
  sessions[0].isDeleted = true;
  forceDestroyError = true;
  const delResilient = await request(`/api/portfolio/me/portfolio/cases/${pubRes2.json._id}`, {
    method: 'DELETE',
    token,
  });
  assert.equal(delResilient.status, 200);
});

test('5. Case image ownership validation, intra-case ordering, case reordering, and media library filtering', async () => {
  resetFixture();
  const token = signToken(DENTIST_ID);

  // Media library must exclude sessions of soft-deleted patients
  const libRes = await request('/api/portfolio/me/media-library', { token });
  assert.equal(libRes.status, 200);
  assert.equal(libRes.json.length, 1);
  assert.equal(libRes.json[0].patientName, 'Active Patient');

  // Reject foreign URLs, empty title, >5 images
  const foreignRes = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: { title: 'Foreign Test', selectedImages: [URL_FOREIGN] },
  });
  assert.equal(foreignRes.status, 400);
  assert.match(foreignRes.json.message, /media library/i);

  const blankTitleRes = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: { title: '   ', selectedImages: [URL_1] },
  });
  assert.equal(blankTitleRes.status, 400);

  // Publish 3 cases with explicit image order and deduplication
  const c1 = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Case A',
      selectedImages: [URL_3, URL_1, URL_3, URL_2],
      coverImage: URL_1,
    },
  });
  assert.equal(c1.status, 201);
  assert.deepEqual(c1.json.selectedImages, [URL_3, URL_1, URL_2]);
  assert.equal(c1.json.coverImage, URL_1);

  const c2 = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: { title: 'Case B', selectedImages: [URL_2] },
  });
  const c3 = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: { title: 'Case C', selectedImages: [URL_3] },
  });
  assert.equal(c2.status, 201);
  assert.equal(c3.status, 201);

  // Edit intra-case image order and verify persistence
  const reorderImgs = await request(`/api/portfolio/me/portfolio/cases/${c1.json._id}`, {
    method: 'PUT',
    token,
    body: { selectedImages: [URL_2, URL_3, URL_1], coverImage: URL_2 },
  });
  assert.equal(reorderImgs.status, 200);
  assert.deepEqual(reorderImgs.json.selectedImages, [URL_2, URL_3, URL_1]);
  assert.equal(reorderImgs.json.coverImage, URL_2);

  // Reject edit with empty title or coverImage not in selectedImages
  const badEditTitle = await request(`/api/portfolio/me/portfolio/cases/${c1.json._id}`, {
    method: 'PUT',
    token,
    body: { title: '   ' },
  });
  assert.equal(badEditTitle.status, 400);

  const badCover = await request(`/api/portfolio/me/portfolio/cases/${c1.json._id}`, {
    method: 'PUT',
    token,
    body: { coverImage: URL_FOREIGN },
  });
  assert.equal(badCover.status, 400);

  // Reject invalid reorder direction
  const badDir = await request(`/api/portfolio/me/portfolio/cases/${c2.json._id}/reorder`, {
    method: 'PUT',
    token,
    body: { direction: 'sideways' },
  });
  assert.equal(badDir.status, 400);

  // Move Case C up -> order should become [Case A (0), Case C (1), Case B (2)]
  const moved = await request(`/api/portfolio/me/portfolio/cases/${c3.json._id}/reorder`, {
    method: 'PUT',
    token,
    body: { direction: 'up' },
  });
  assert.equal(moved.status, 200);
  assert.deepEqual(
    moved.json.map((c) => [c.title, c.order]),
    [['Case A', 0], ['Case C', 1], ['Case B', 2]]
  );

  // Delete middle case (Case C) -> remaining cases must be contiguously re-indexed 0, 1
  const delMid = await request(`/api/portfolio/me/portfolio/cases/${c3.json._id}`, {
    method: 'DELETE',
    token,
  });
  assert.equal(delMid.status, 200);
  const p = portfolios.get(String(DENTIST_ID));
  assert.deepEqual(
    p.publishedCases.map((c) => [c.title, c.order]),
    [['Case A', 0], ['Case B', 1]]
  );
});

test('6. Direct portfolio upload validation, suspended dentist 403 block, and 8-image limit (create & edit)', async () => {
  resetFixture();
  const token = signToken(DENTIST_ID);
  const suspendedToken = signToken(SUSPENDED_DENTIST_ID);

  // Suspended dentist MUST be blocked with 403 ACCOUNT_SUSPENDED on real /api/portfolio/upload-images
  const suspRes = await request('/api/portfolio/upload-images', {
    method: 'POST',
    token: suspendedToken,
  });
  assert.equal(suspRes.status, 403);
  assert.equal(suspRes.json.code, 'ACCOUNT_SUSPENDED');

  // Multer LIMIT_FILE_COUNT on portfolio route reports 8-image limit
  const portCountErr = await request('/test/portfolio/multer-error/LIMIT_FILE_COUNT');
  assert.equal(portCountErr.status, 400);
  assert.match(portCountErr.json.message, /Maximum of 8 images/i);

  // Empty upload rejected with 400
  const emptyUpload = await request('/test/portfolio/upload-images', {
    method: 'POST',
    token,
    body: { _mockFiles: [] },
  });
  assert.equal(emptyUpload.status, 400);

  // Valid upload of 6 direct device photos returns 201 with URLs
  const directFiles = Array.from({ length: 6 }, (_, i) => ({
    path: makeDirectUrl(DENTIST_ID, `direct_${i + 1}`),
    filename: `antigravity/portfolio/${DENTIST_ID}/direct_${i + 1}`,
  }));
  const okUpload = await request('/test/portfolio/upload-images', {
    method: 'POST',
    token,
    body: { _mockFiles: directFiles },
  });
  assert.equal(okUpload.status, 201);
  assert.equal(okUpload.json.count, 6);
  assert.equal(okUpload.json.urls.length, 6);

  // Exceeding 8 files on upload rejects with 400 and cleans up uploaded files
  const nineFiles = Array.from({ length: 9 }, (_, i) => ({
    path: makeDirectUrl(DENTIST_ID, `excess_${i + 1}`),
    filename: `antigravity/portfolio/${DENTIST_ID}/excess_${i + 1}`,
  }));
  const tooManyUpload = await request('/test/portfolio/upload-images', {
    method: 'POST',
    token,
    body: { _mockFiles: nineFiles },
  });
  assert.equal(tooManyUpload.status, 400);
  assert.equal(destroyedPublicIds.length, 9);

  // Creating a case with 8 mixed images (2 session + 6 direct uploads) succeeds and preserves exact order
  const eightImages = [
    URL_1,
    directFiles[0].path,
    URL_2,
    directFiles[1].path,
    directFiles[2].path,
    directFiles[3].path,
    directFiles[4].path,
    directFiles[5].path,
  ];
  const pub8 = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Eight Photo Smile Makeover',
      treatmentType: ['Restorative'],
      selectedImages: eightImages,
      coverImage: directFiles[0].path,
    },
  });
  assert.equal(pub8.status, 201);
  assert.deepEqual(pub8.json.selectedImages, eightImages);
  assert.equal(pub8.json.coverImage, directFiles[0].path);

  // Creating a case with 9 images is rejected with 400
  const pub9 = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Nine Photos Invalid',
      selectedImages: [...eightImages, URL_3],
    },
  });
  assert.equal(pub9.status, 400);
  assert.match(pub9.json.message, /Maximum of 8 images/i);

  // Editing case to reorder 8 images succeeds; editing to 9 images fails with 400
  const reordered8 = [...eightImages].reverse();
  const edit8 = await request(`/api/portfolio/me/portfolio/cases/${pub8.json._id}`, {
    method: 'PUT',
    token,
    body: { selectedImages: reordered8, coverImage: reordered8[0] },
  });
  assert.equal(edit8.status, 200);
  assert.deepEqual(edit8.json.selectedImages, reordered8);
  assert.equal(edit8.json.coverImage, reordered8[0]);

  const edit9 = await request(`/api/portfolio/me/portfolio/cases/${pub8.json._id}`, {
    method: 'PUT',
    token,
    body: { selectedImages: [...reordered8, URL_3] },
  });
  assert.equal(edit9.status, 400);
  assert.match(edit9.json.message, /Maximum of 8 images/i);
});

test('7. Direct portfolio upload ownership enforcement and reference-safe Cloudinary cleanup', async () => {
  resetFixture();
  const token = signToken(DENTIST_ID);

  const ownDirectA = makeDirectUrl(DENTIST_ID, 'case_direct_a');
  const ownDirectB = makeDirectUrl(DENTIST_ID, 'case_direct_b');
  const foreignDirect = makeDirectUrl(OTHER_DENTIST_ID, 'stolen_direct');
  const spoofedHost = `https://evil.com/res.cloudinary.com/antigravity/portfolio/${DENTIST_ID}/spoof.jpg`;

  // Unit assertions on helper
  assert.equal(isOwnedPortfolioUploadUrl(ownDirectA, DENTIST_ID), true);
  assert.equal(isOwnedPortfolioUploadUrl(foreignDirect, DENTIST_ID), false);
  assert.equal(isOwnedPortfolioUploadUrl(spoofedHost, DENTIST_ID), false);

  // Reject foreign dentist's direct upload URL and spoofed external URL
  const resForeign = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: { title: 'Stolen Direct', selectedImages: [foreignDirect] },
  });
  assert.equal(resForeign.status, 400);

  const resSpoof = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: { title: 'Spoofed Host', selectedImages: [spoofedHost] },
  });
  assert.equal(resSpoof.status, 400);

  // Publish two cases sharing ownDirectA; Case 1 also has ownDirectB + Session URL_1
  const case1 = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Mixed Case 1',
      selectedImages: [ownDirectA, ownDirectB, URL_1],
      coverImage: ownDirectA,
    },
  });
  assert.equal(case1.status, 201);

  const case2 = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Shared Direct Case 2',
      selectedImages: [ownDirectA],
      coverImage: ownDirectA,
    },
  });
  assert.equal(case2.status, 201);

  // Edit Case 1 to drop ownDirectA (shared with Case 2), ownDirectB (now unreferenced!), and URL_1 (still in active Session)
  destroyedPublicIds = [];
  const editCase1 = await request(`/api/portfolio/me/portfolio/cases/${case1.json._id}`, {
    method: 'PUT',
    token,
    body: { selectedImages: [URL_2], coverImage: URL_2 },
  });
  assert.equal(editCase1.status, 200);

  // ONLY ownDirectB must be destroyed; ownDirectA is preserved by Case 2 and URL_1 is preserved by active Session!
  assert.deepEqual(destroyedPublicIds, [
    `antigravity/portfolio/${DENTIST_ID}/case_direct_b`,
  ]);

  // Now delete Case 2 -> ownDirectA has zero remaining references and must be destroyed!
  destroyedPublicIds = [];
  const delCase2 = await request(`/api/portfolio/me/portfolio/cases/${case2.json._id}`, {
    method: 'DELETE',
    token,
  });
  assert.equal(delCase2.status, 200);
  assert.deepEqual(destroyedPublicIds, [
    `antigravity/portfolio/${DENTIST_ID}/case_direct_a`,
  ]);
});

test('8. Dentist-selectable Before/After images: persistence, public exposure, validation, and auto-reset on image removal', async () => {
  resetFixture();
  const token = signToken(DENTIST_ID);

  // Reject partial selection (only beforeImage without afterImage)
  const partialOnlyBefore = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Partial Before Only',
      selectedImages: [URL_1, URL_2, URL_3],
      beforeImage: URL_1,
    },
  });
  assert.equal(partialOnlyBefore.status, 400);
  assert.equal(partialOnlyBefore.json.message, 'Both Before and After images must be selected together.');

  // Reject identical beforeImage and afterImage
  const samePair = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Same Pair',
      selectedImages: [URL_1, URL_2],
      beforeImage: URL_1,
      afterImage: URL_1,
    },
  });
  assert.equal(samePair.status, 400);

  // Reject beforeImage/afterImage not in selectedImages
  const outsidePair = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Outside Pair',
      selectedImages: [URL_1, URL_2],
      beforeImage: URL_1,
      afterImage: URL_3,
    },
  });
  assert.equal(outsidePair.status, 400);

  // Create case with valid explicit Before (URL_3) and After (URL_1)
  const created = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token,
    body: {
      title: 'Explicit Before After Case',
      treatmentType: ['Restorative'],
      selectedImages: [URL_1, URL_2, URL_3],
      coverImage: URL_2,
      beforeImage: URL_3,
      afterImage: URL_1,
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.beforeImage, URL_3);
  assert.equal(created.json.afterImage, URL_1);

  // Verify getPublicCase and getPublicPortfolio expose beforeImage & afterImage
  const publicCase = await request(`/api/portfolio/dr-media/case/${created.json._id}`);
  assert.equal(publicCase.status, 200);
  assert.equal(publicCase.json.case.beforeImage, URL_3);
  assert.equal(publicCase.json.case.afterImage, URL_1);

  const publicPort = await request('/api/portfolio/dr-media');
  assert.equal(publicPort.status, 200);
  assert.equal(publicPort.json.cases[0].beforeImage, URL_3);
  assert.equal(publicPort.json.cases[0].afterImage, URL_1);

  // Edit case to update Before/After pair
  const editedPair = await request(`/api/portfolio/me/portfolio/cases/${created.json._id}`, {
    method: 'PUT',
    token,
    body: {
      beforeImage: URL_2,
      afterImage: URL_3,
    },
  });
  assert.equal(editedPair.status, 200);
  assert.equal(editedPair.json.beforeImage, URL_2);
  assert.equal(editedPair.json.afterImage, URL_3);

  // Reject edit with partial beforeImage only
  const badPartialEdit = await request(`/api/portfolio/me/portfolio/cases/${created.json._id}`, {
    method: 'PUT',
    token,
    body: { beforeImage: URL_1 },
  });
  assert.equal(badPartialEdit.status, 400);
  assert.equal(badPartialEdit.json.message, 'Both Before and After images must be selected together.');

  // Edit selectedImages removing the currently selected beforeImage (URL_2) without passing beforeImage/afterImage -> both MUST auto-reset to null
  const removedBefore = await request(`/api/portfolio/me/portfolio/cases/${created.json._id}`, {
    method: 'PUT',
    token,
    body: {
      selectedImages: [URL_1, URL_3],
    },
  });
  assert.equal(removedBefore.status, 200);
  assert.equal(removedBefore.json.beforeImage, null);
  assert.equal(removedBefore.json.afterImage, null);

  // Verify public endpoint reflects cleared null values
  const publicAfterReset = await request(`/api/portfolio/dr-media/case/${created.json._id}`);
  assert.equal(publicAfterReset.status, 200);
  assert.equal(publicAfterReset.json.case.beforeImage, null);
  assert.equal(publicAfterReset.json.case.afterImage, null);
});

test('9. Portfolio Cover Photo upload, Cover Theme presets, suspended dentist 403 block, and Cloudinary cleanup', async () => {
  resetFixture();
  const token = signToken(DENTIST_ID);
  const suspendedToken = signToken(SUSPENDED_DENTIST_ID);

  // Suspended dentist MUST be blocked with 403 ACCOUNT_SUSPENDED on real cover upload route
  const suspCover = await request('/api/portfolio/me/portfolio/cover', {
    method: 'POST',
    token: suspendedToken,
  });
  assert.equal(suspCover.status, 403);
  assert.equal(suspCover.json.code, 'ACCOUNT_SUSPENDED');

  // Missing file returns 400
  const emptyCover = await request('/test/portfolio/me/portfolio/cover', {
    method: 'POST',
    token,
    body: {},
  });
  assert.equal(emptyCover.status, 400);

  // Upload first custom cover photo
  const coverUrl1 = makeDirectUrl(DENTIST_ID, 'cover_banner_1');
  const coverUrl2 = makeDirectUrl(DENTIST_ID, 'cover_banner_2');

  const up1 = await request('/test/portfolio/me/portfolio/cover', {
    method: 'POST',
    token,
    body: {
      _mockFile: {
        path: coverUrl1,
        filename: `antigravity/portfolio/${DENTIST_ID}/cover_banner_1`,
      },
    },
  });
  assert.equal(up1.status, 200);
  assert.equal(up1.json.coverPhoto, coverUrl1);
  assert.equal(up1.json.coverTheme, 'clinical-blue');

  // Update coverTheme to valid preset 'emerald-care'
  const themeOk = await request('/api/portfolio/me/portfolio', {
    method: 'PUT',
    token,
    body: { coverTheme: 'emerald-care' },
  });
  assert.equal(themeOk.status, 200);
  assert.equal(themeOk.json.coverTheme, 'emerald-care');

  // Reject invalid coverTheme preset with 400
  const themeBad = await request('/api/portfolio/me/portfolio', {
    method: 'PUT',
    token,
    body: { coverTheme: 'neon-rainbow' },
  });
  assert.equal(themeBad.status, 400);

  // Reject setting arbitrary string as coverPhoto via PUT with 400
  const coverInject = await request('/api/portfolio/me/portfolio', {
    method: 'PUT',
    token,
    body: { coverPhoto: 'https://evil.com/banner.jpg' },
  });
  assert.equal(coverInject.status, 400);

  // Verify getPublicPortfolio & getMyPortfolio return coverPhoto and coverTheme
  const pubPort = await request('/api/portfolio/dr-media');
  assert.equal(pubPort.status, 200);
  assert.equal(pubPort.json.coverPhoto, coverUrl1);
  assert.equal(pubPort.json.coverTheme, 'emerald-care');

  const myPort = await request('/api/portfolio/me/portfolio', { token });
  assert.equal(myPort.status, 200);
  assert.equal(myPort.json.coverPhoto, coverUrl1);
  assert.equal(myPort.json.coverTheme, 'emerald-care');

  // Replace coverPhoto with coverUrl2 -> coverUrl1 MUST be destroyed on Cloudinary
  destroyedPublicIds = [];
  const up2 = await request('/test/portfolio/me/portfolio/cover', {
    method: 'POST',
    token,
    body: {
      _mockFile: {
        path: coverUrl2,
        filename: `antigravity/portfolio/${DENTIST_ID}/cover_banner_2`,
      },
    },
  });
  assert.equal(up2.status, 200);
  assert.equal(up2.json.coverPhoto, coverUrl2);
  assert.deepEqual(destroyedPublicIds, [
    `antigravity/portfolio/${DENTIST_ID}/cover_banner_1`,
  ]);

  // Remove coverPhoto via PUT { coverPhoto: null } -> coverUrl2 MUST be destroyed on Cloudinary
  destroyedPublicIds = [];
  const clearCover = await request('/api/portfolio/me/portfolio', {
    method: 'PUT',
    token,
    body: { coverPhoto: null },
  });
  assert.equal(clearCover.status, 200);
  assert.equal(clearCover.json.coverPhoto, null);
  assert.deepEqual(destroyedPublicIds, [
    `antigravity/portfolio/${DENTIST_ID}/cover_banner_2`,
  ]);

  const pubAfterClear = await request('/api/portfolio/dr-media');
  assert.equal(pubAfterClear.status, 200);
  assert.equal(pubAfterClear.json.coverPhoto, null);
  assert.equal(pubAfterClear.json.coverTheme, 'emerald-care');
});

test('10. Smart slug fallback (Arabic names), custom slug validation, clinic auto-fill & workplace privacy toggle', async () => {
  resetFixture();

  // Add two Arabic-named dentists + a clinic for the first one
  const ARABIC_DOC_1 = new mongoose.Types.ObjectId();
  const ARABIC_DOC_2 = new mongoose.Types.ObjectId();
  const ARABIC_CLINIC_ID = new mongoose.Types.ObjectId();

  dentists.set(String(ARABIC_DOC_1), {
    _id: ARABIC_DOC_1,
    name: 'د. أحمد',
    email: 'ahmed@example.com',
    role: 'dentist',
    status: 'active',
  });
  dentists.set(String(ARABIC_DOC_2), {
    _id: ARABIC_DOC_2,
    name: 'د. سارة',
    email: 'sara@example.com',
    role: 'dentist',
    status: 'active',
  });
  clinics.set(String(ARABIC_CLINIC_ID), {
    _id: ARABIC_CLINIC_ID,
    dentist_id: ARABIC_DOC_1,
    name: 'Nile Dental Studio',
    address: '15 Zamalek St, Cairo',
    default_commission_percentage: 50,
  });

  const tok1 = signToken(ARABIC_DOC_1);
  const tok2 = signToken(ARABIC_DOC_2);

  // First Arabic dentist creates portfolio -> falls back cleanly to 'dr-dentist' & auto-fills clinicName/clinicAddress
  const create1 = await request('/api/portfolio/me/portfolio', {
    method: 'POST',
    token: tok1,
    body: {},
  });
  assert.equal(create1.status, 201);
  assert.equal(create1.json.slug, 'dr-dentist');
  assert.equal(create1.json.clinicName, 'Nile Dental Studio');
  assert.equal(create1.json.clinicAddress, '15 Zamalek St, Cairo');
  assert.equal(create1.json.showClinicInfo, true);

  // Second Arabic dentist gets deduplicated fallback slug 'dr-dentist-2'
  const create2 = await request('/api/portfolio/me/portfolio', {
    method: 'POST',
    token: tok2,
    body: {},
  });
  assert.equal(create2.status, 201);
  assert.equal(create2.json.slug, 'dr-dentist-2');

  // Reserved slugs must be rejected with 400
  for (const reserved of ['admin', 'me', 'upload-images', 'dashboard']) {
    const res = await request('/api/portfolio/me/portfolio', {
      method: 'PUT',
      token: tok1,
      body: { slug: reserved },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.message, /reserved/i);
  }

  // Too-short slug must be rejected with 400
  const shortRes = await request('/api/portfolio/me/portfolio', {
    method: 'PUT',
    token: tok1,
    body: { slug: 'ab' },
  });
  assert.equal(shortRes.status, 400);

  // Duplicate slug belonging to another dentist ('dr-media') must be rejected with 400
  const dupRes = await request('/api/portfolio/me/portfolio', {
    method: 'PUT',
    token: tok1,
    body: { slug: 'dr-media' },
  });
  assert.equal(dupRes.status, 400);
  assert.equal(dupRes.json.message, 'This portfolio URL is already taken.');

  // Valid custom slug updates cleanly and normalizes spacing/casing
  const okSlug = await request('/api/portfolio/me/portfolio', {
    method: 'PUT',
    token: tok1,
    body: { slug: '  Dr Ahmed Cairo  ' },
  });
  assert.equal(okSlug.status, 200);
  assert.equal(okSlug.json.slug, 'dr-ahmed-cairo');

  // Publish portfolio -> public endpoint shows clinic info by default
  const toggleRes = await request('/api/portfolio/me/portfolio/toggle', { method: 'PUT', token: tok1 });
  assert.equal(toggleRes.status, 200);
  const pubVisible = await request('/api/portfolio/dr-ahmed-cairo');
  assert.equal(pubVisible.status, 200);
  assert.equal(pubVisible.json.showClinicInfo, true);
  assert.equal(pubVisible.json.clinicName, 'Nile Dental Studio');
  assert.equal(pubVisible.json.clinicAddress, '15 Zamalek St, Cairo');

  // Dentist turns OFF showClinicInfo -> public API hides clinicName/clinicAddress while private API preserves them
  const hideRes = await request('/api/portfolio/me/portfolio', {
    method: 'PUT',
    token: tok1,
    body: { showClinicInfo: false },
  });
  assert.equal(hideRes.status, 200);
  assert.equal(hideRes.json.showClinicInfo, false);

  const pubHidden = await request('/api/portfolio/dr-ahmed-cairo');
  assert.equal(pubHidden.status, 200);
  assert.equal(pubHidden.json.showClinicInfo, false);
  assert.equal(pubHidden.json.clinicName, '');
  assert.equal(pubHidden.json.clinicAddress, '');

  const myPort = await request('/api/portfolio/me/portfolio', { token: tok1 });
  assert.equal(myPort.status, 200);
  assert.equal(myPort.json.showClinicInfo, false);
  assert.equal(myPort.json.clinicName, 'Nile Dental Studio');
  assert.equal(myPort.json.clinicAddress, '15 Zamalek St, Cairo');
});

test('11. Owner Draft Preview: active owner can preview unpublished portfolio & cases; public, other dentists, and suspended owner get 403', async () => {
  resetFixture();

  // Ensure OTHER_DENTIST_ID exists in dentists store so optionalProtect resolves them cleanly
  dentists.set(String(OTHER_DENTIST_ID), {
    _id: OTHER_DENTIST_ID,
    name: 'Dr. Other',
    email: 'other@example.com',
    role: 'dentist',
    status: 'active',
  });

  const ownerToken = signToken(DENTIST_ID);
  const otherToken = signToken(OTHER_DENTIST_ID);

  // Add a case and unpublish portfolio (Draft state)
  const createdCase = await request('/api/portfolio/me/portfolio/cases', {
    method: 'POST',
    token: ownerToken,
    body: {
      title: 'Draft Preview Case',
      treatmentType: ['Implant'],
      selectedImages: [URL_1, URL_2],
      coverImage: URL_1,
    },
  });
  assert.equal(createdCase.status, 201);
  const caseId = createdCase.json._id;

  const p = portfolios.get(String(DENTIST_ID));
  p.isPublished = false;

  // 1. Unauthenticated visitor -> 403 on portfolio and case
  const unauthPort = await request('/api/portfolio/dr-media');
  assert.equal(unauthPort.status, 403);
  const unauthCase = await request(`/api/portfolio/dr-media/case/${caseId}`);
  assert.equal(unauthCase.status, 403);

  // 2. Different logged-in dentist -> 403 on portfolio and case
  const otherPort = await request('/api/portfolio/dr-media', { token: otherToken });
  assert.equal(otherPort.status, 403);
  const otherCase = await request(`/api/portfolio/dr-media/case/${caseId}`, { token: otherToken });
  assert.equal(otherCase.status, 403);

  // 3. Active owning dentist -> 200 with isDraftPreview: true on portfolio and case
  const ownerPort = await request('/api/portfolio/dr-media', { token: ownerToken });
  assert.equal(ownerPort.status, 200);
  assert.equal(ownerPort.json.isDraftPreview, true);
  assert.equal(ownerPort.json.cases.length, 1);

  const ownerCase = await request(`/api/portfolio/dr-media/case/${caseId}`, { token: ownerToken });
  assert.equal(ownerCase.status, 200);
  assert.equal(ownerCase.json.isDraftPreview, true);
  assert.equal(ownerCase.json.case.title, 'Draft Preview Case');

  // 4. Suspended owning dentist -> ALWAYS 403 (even on their own draft!)
  dentists.get(String(DENTIST_ID)).status = 'suspended';
  const suspendedOwnerPort = await request('/api/portfolio/dr-media', { token: ownerToken });
  assert.equal(suspendedOwnerPort.status, 403);
  const suspendedOwnerCase = await request(`/api/portfolio/dr-media/case/${caseId}`, { token: ownerToken });
  assert.equal(suspendedOwnerCase.status, 403);
});
