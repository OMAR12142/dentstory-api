const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// Set deterministic test secrets before loading controllers/middleware
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret';
process.env.ACCESS_TOKEN_EXPIRES_IN = '1h';
process.env.REFRESH_TOKEN_EXPIRES_IN = '30d';

const Dentist = require('../models/Dentist');
const Portfolio = require('../models/Portfolio');
const RefreshToken = require('../models/RefreshToken');
const Session = require('../models/Session');
const { analyticsCache } = require('../utils/cache');
const errorHandler = require('../middleware/errorHandler');
const authRoutes = require('../routes/authRoutes');
const adminRoutes = require('../routes/adminRoutes');
const portfolioRoutes = require('../routes/portfolioRoutes');

// Build a minimal Express app wiring the real routes, middleware, and error handler
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use(errorHandler);

// ── In-memory stores backing Mongoose model stubs ────────────
const ADMIN_ID = new mongoose.Types.ObjectId();
const DENTIST_A_ID = new mongoose.Types.ObjectId();
const DENTIST_B_ID = new mongoose.Types.ObjectId();
const CASE_A_ID = new mongoose.Types.ObjectId();
const SESSION_A_ID = new mongoose.Types.ObjectId();

let dentists = new Map();
let portfolios = new Map();
let refreshTokens = [];
let sessions = [];

function makeDentistDoc(data) {
  return {
    ...data,
    matchPassword: async (pw) => pw === data._plainPassword,
    save: async function () {
      dentists.set(String(this._id), this);
      return this;
    },
  };
}

function makePortfolioDoc(data) {
  const cases = (data.publishedCases || []).map((c) => ({
    ...c,
    isFeatured: Boolean(c.isFeatured),
  }));
  cases.id = function (id) {
    return this.find((c) => String(c._id) === String(id)) || null;
  };
  return {
    ...data,
    cvUrl: data.cvUrl || '',
    cvFileName: data.cvFileName || '',
    visibility: data.visibility || {
      clinicInfo: true,
      yearsOfExperience: true,
      casesCount: true,
      bio: true,
      specialties: true,
      cv: true,
      whatsapp: true,
      phone: true,
      email: true,
      locationCard: true,
      socialLinks: true,
    },
    publishedCases: cases,
    markModified: () => {},
    save: async function () {
      portfolios.set(String(this.dentist_id), this);
      return this;
    },
  };
}

function seedData() {
  analyticsCache.clear();
  dentists = new Map();
  portfolios = new Map();
  refreshTokens = [];
  sessions = [];

  const adminDoc = makeDentistDoc({
    _id: ADMIN_ID,
    name: 'Platform Admin',
    email: 'admin@dentstory.test',
    phone: '01000000000',
    role: 'admin',
    status: 'active',
    profilePhoto: { url: '', publicId: '' },
    hasCompletedOnboarding: true,
    _plainPassword: 'password123',
  });

  const dentistADoc = makeDentistDoc({
    _id: DENTIST_A_ID,
    name: 'Alice Dental',
    email: 'alice@dentstory.test',
    phone: '01011111111',
    role: 'dentist',
    status: 'active',
    profilePhoto: { url: 'https://res.cloudinary.com/demo/alice.jpg', publicId: 'dentstory/avatars/alice' },
    hasCompletedOnboarding: true,
    _plainPassword: 'password123',
  });

  const dentistBDoc = makeDentistDoc({
    _id: DENTIST_B_ID,
    name: 'Bob Dental',
    email: 'bob@dentstory.test',
    phone: '01022222222',
    role: 'dentist',
    status: 'active',
    profilePhoto: { url: '', publicId: '' },
    hasCompletedOnboarding: true,
    _plainPassword: 'password123',
  });

  dentists.set(String(ADMIN_ID), adminDoc);
  dentists.set(String(DENTIST_A_ID), dentistADoc);
  dentists.set(String(DENTIST_B_ID), dentistBDoc);

  portfolios.set(
    String(DENTIST_A_ID),
    makePortfolioDoc({
      _id: new mongoose.Types.ObjectId(),
      dentist_id: DENTIST_A_ID,
      slug: 'dr-alice-dental',
      bio: 'Implant specialist',
      yearsOfExperience: 7,
      services: ['Implants'],
      contactEmail: 'alice@dentstory.test',
      contactPhone: '01011111111',
      clinicName: 'Alice Clinic',
      clinicAddress: 'Cairo',
      cvUrl: 'https://res.cloudinary.com/demo/raw/upload/v1/cv/alice_cv.pdf',
      cvFileName: 'Alice_Dental_CV.pdf',
      isPublished: true,
      isSuspended: false,
      publishedCases: [
        {
          _id: CASE_A_ID,
          session_id: SESSION_A_ID,
          title: 'Anterior Crown',
          description: 'Full ceramic crown',
          category: 'Esthetic',
          treatmentType: ['Fixed'],
          selectedImages: ['https://res.cloudinary.com/demo/case-a1.jpg'],
          coverImage: 'https://res.cloudinary.com/demo/case-a1.jpg',
          order: 0,
          publishedAt: new Date(),
        },
      ],
    })
  );

  sessions.push({
    _id: SESSION_A_ID,
    dentist_id: DENTIST_A_ID,
    isDeleted: false,
    date: new Date(),
    treatment_category: ['Fixed'],
    media_urls: ['https://res.cloudinary.com/demo/case-a1.jpg'],
    patient_id: { name: 'Patient One' },
  });
}

// Helper for Mongoose chainable query mocks (.select(), .populate(), .lean(), .sort())
function makeQuery(resolver) {
  let populateDentist = false;
  const q = {
    select() { return q; },
    sort() { return q; },
    limit() { return q; },
    lean() { return q; },
    populate(arg) {
      if (arg === 'dentist_id' || arg?.path === 'dentist_id') {
        populateDentist = true;
      }
      return q;
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve()
        .then(() => resolver({ populateDentist }))
        .then(onFulfilled, onRejected);
    },
  };
  return q;
}

// Stub Mongoose model methods
const originals = {
  dentistFindById: Dentist.findById,
  dentistFindOne: Dentist.findOne,
  portfolioFindOne: Portfolio.findOne,
  refreshFindOne: RefreshToken.findOne,
  refreshFind: RefreshToken.find,
  refreshCount: RefreshToken.countDocuments,
  refreshCreate: RefreshToken.create,
  refreshDeleteOne: RefreshToken.deleteOne,
  refreshDeleteMany: RefreshToken.deleteMany,
  sessionFind: Session.find,
};

let server;
let baseUrl;

test.before(async () => {
  Dentist.findById = (id) => makeQuery(() => dentists.get(String(id)) || null);
  Dentist.findOne = (query) =>
    makeQuery(() => {
      for (const d of dentists.values()) {
        if (query.email && d.email === query.email) return d;
      }
      return null;
    });

  Portfolio.findOne = (query) =>
    makeQuery(({ populateDentist }) => {
      let found = null;
      for (const p of portfolios.values()) {
        if (query.slug && p.slug === query.slug) found = p;
        if (query.dentist_id && String(p.dentist_id) === String(query.dentist_id)) found = p;
      }
      if (!found) return null;
      if (populateDentist) {
        const d = dentists.get(String(found.dentist_id)) || null;
        return {
          ...found,
          publishedCases: found.publishedCases,
          dentist_id: d ? { _id: d._id, name: d.name, profilePhoto: d.profilePhoto, status: d.status } : null,
        };
      }
      return found;
    });

  RefreshToken.findOne = async (query) => refreshTokens.find((t) => t.token === query.token) || null;
  RefreshToken.find = (query) =>
    makeQuery(() => refreshTokens.filter((t) => String(t.dentistId) === String(query.dentistId)));
  RefreshToken.countDocuments = async (query) =>
    refreshTokens.filter((t) => String(t.dentistId) === String(query.dentistId)).length;
  RefreshToken.create = async (doc) => {
    const rec = { _id: new mongoose.Types.ObjectId(), ...doc };
    refreshTokens.push(rec);
    return rec;
  };
  RefreshToken.deleteOne = async (query) => {
    refreshTokens = refreshTokens.filter((t) => {
      if (query._id) return String(t._id) !== String(query._id);
      if (query.token) return t.token !== query.token;
      return true;
    });
  };
  RefreshToken.deleteMany = async (query) => {
    refreshTokens = refreshTokens.filter((t) => {
      if (query.dentistId) return String(t.dentistId) !== String(query.dentistId);
      if (query._id?.$in) return !query._id.$in.some((id) => String(id) === String(t._id));
      return true;
    });
  };

  Session.find = (query) =>
    makeQuery(() =>
      sessions.filter(
        (s) => String(s.dentist_id) === String(query.dentist_id) && !s.isDeleted && s.media_urls.length > 0
      )
    );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  Dentist.findById = originals.dentistFindById;
  Dentist.findOne = originals.dentistFindOne;
  Portfolio.findOne = originals.portfolioFindOne;
  RefreshToken.findOne = originals.refreshFindOne;
  RefreshToken.find = originals.refreshFind;
  RefreshToken.countDocuments = originals.refreshCount;
  RefreshToken.create = originals.refreshCreate;
  RefreshToken.deleteOne = originals.refreshDeleteOne;
  RefreshToken.deleteMany = originals.refreshDeleteMany;
  Session.find = originals.sessionFind;
  analyticsCache.clear();
});

const signToken = (id, role) => jwt.sign({ id: String(id), role }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });

async function apiReq(method, path, { token, cookie, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, setCookie };
}

function extractRefreshCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/refreshToken=([^;]+)/);
  return match ? `refreshToken=${match[1]}` : null;
}

test('Full lifecycle: active -> suspend (revokes RefreshToken, clears analyticsCache, blocks private & public APIs) -> reactivate (restores pre-suspension state)', async () => {
  seedData();
  const adminToken = signToken(ADMIN_ID, 'admin');

  // ── 1. Active Dentist A logs in, caches profile + analytics, uses private & public Portfolio ──
  const loginRes = await apiReq('POST', '/api/auth/login', {
    body: { email: 'alice@dentstory.test', password: 'password123' },
  });
  assert.equal(loginRes.status, 200);
  const aliceToken = loginRes.data.accessToken;
  const aliceCookie = extractRefreshCookie(loginRes.setCookie);
  assert.ok(aliceToken);
  assert.ok(aliceCookie);
  assert.equal(refreshTokens.filter((t) => String(t.dentistId) === String(DENTIST_A_ID)).length, 1);

  // Private portfolio & media library succeed (and populate analyticsCache prof_<alice>)
  const myPortActive = await apiReq('GET', '/api/portfolio/me/portfolio', { token: aliceToken });
  assert.equal(myPortActive.status, 200);
  assert.equal(myPortActive.data.slug, 'dr-alice-dental');
  assert.equal(myPortActive.data.cvUrl, 'https://res.cloudinary.com/demo/raw/upload/v1/cv/alice_cv.pdf');
  assert.equal(myPortActive.data.cvFileName, 'Alice_Dental_CV.pdf');
  assert.ok(analyticsCache.get(`prof_${DENTIST_A_ID}`));

  const mediaActive = await apiReq('GET', '/api/portfolio/me/media-library', { token: aliceToken });
  assert.equal(mediaActive.status, 200);
  assert.equal(mediaActive.data.length, 1);

  // Seed analyticsCache for both Dentist A and Dentist B
  analyticsCache.set(`dash_${DENTIST_A_ID}_monthly`, { earnings: 5000 }, 300);
  analyticsCache.set(`treat_${DENTIST_A_ID}_all_2026_undefined_undefined`, { Fixed: 10 }, 300);
  analyticsCache.set(`hist_${DENTIST_A_ID}_yearly_2026_undefined_undefined_undefined`, { months: [] }, 300);
  analyticsCache.set(`prof_${DENTIST_B_ID}`, dentists.get(String(DENTIST_B_ID)), 120);
  analyticsCache.set(`dash_${DENTIST_B_ID}_monthly`, { earnings: 9000 }, 300);

  // Public portfolio & public case are visible when published and active
  const pubPortActive = await apiReq('GET', '/api/portfolio/dr-alice-dental');
  assert.equal(pubPortActive.status, 200);
  assert.equal(pubPortActive.data.dentist.name, 'Alice Dental');
  assert.equal(pubPortActive.data.cvUrl, 'https://res.cloudinary.com/demo/raw/upload/v1/cv/alice_cv.pdf');
  assert.equal(pubPortActive.data.cvFileName, 'Alice_Dental_CV.pdf');
  assert.equal('status' in pubPortActive.data.dentist, false); // status never leaked

  const pubCaseActive = await apiReq('GET', `/api/portfolio/dr-alice-dental/case/${CASE_A_ID}`);
  assert.equal(pubCaseActive.status, 200);
  assert.equal(pubCaseActive.data.case.title, 'Anterior Crown');
  assert.equal('status' in pubCaseActive.data.dentist, false);

  // ── 2. Admin suspends Dentist A ──
  const suspendRes = await apiReq('PATCH', `/api/admin/dentists/${DENTIST_A_ID}/status`, {
    token: adminToken,
  });
  assert.equal(suspendRes.status, 200);
  assert.equal(suspendRes.data.status, 'suspended');

  // Verify RefreshToken collection records for Dentist A were revoked
  assert.equal(refreshTokens.filter((t) => String(t.dentistId) === String(DENTIST_A_ID)).length, 0);

  // Verify analyticsCache entries for Dentist A were invalidated, while Dentist B's entries remain untouched
  assert.equal(analyticsCache.get(`prof_${DENTIST_A_ID}`), null);
  assert.equal(analyticsCache.get(`dash_${DENTIST_A_ID}_monthly`), null);
  assert.equal(analyticsCache.get(`treat_${DENTIST_A_ID}_all_2026_undefined_undefined`), null);
  assert.equal(analyticsCache.get(`hist_${DENTIST_A_ID}_yearly_2026_undefined_undefined_undefined`), null);
  assert.ok(analyticsCache.get(`prof_${DENTIST_B_ID}`));
  assert.deepEqual(analyticsCache.get(`dash_${DENTIST_B_ID}_monthly`), { earnings: 9000 });

  // ── 3. Suspended Dentist A with previously valid access token is IMMEDIATELY blocked (403 ACCOUNT_SUSPENDED) ──
  const blockedPrivateCalls = await Promise.all([
    apiReq('GET', '/api/portfolio/me/portfolio', { token: aliceToken }),
    apiReq('PUT', '/api/portfolio/me/portfolio', { token: aliceToken, body: { bio: 'Hacked' } }),
    apiReq('PUT', '/api/portfolio/me/portfolio/toggle', { token: aliceToken }),
    apiReq('POST', '/api/portfolio/me/portfolio/cases', {
      token: aliceToken,
      body: { title: 'New', selectedImages: ['https://res.cloudinary.com/demo/x.jpg'] },
    }),
    apiReq('PUT', `/api/portfolio/me/portfolio/cases/${CASE_A_ID}`, { token: aliceToken, body: { title: 'Edit' } }),
    apiReq('DELETE', `/api/portfolio/me/portfolio/cases/${CASE_A_ID}`, { token: aliceToken }),
    apiReq('PUT', `/api/portfolio/me/portfolio/cases/${CASE_A_ID}/reorder`, { token: aliceToken, body: { direction: 'up' } }),
    apiReq('GET', '/api/portfolio/me/media-library', { token: aliceToken }),
  ]);

  for (const r of blockedPrivateCalls) {
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'ACCOUNT_SUSPENDED');
  }
  // Suspended profile must NOT be cached in analyticsCache
  assert.equal(analyticsCache.get(`prof_${DENTIST_A_ID}`), null);

  // Suspended Dentist A cannot refresh token or log in again or be impersonated
  const refreshBlocked = await apiReq('POST', '/api/auth/refresh', { cookie: aliceCookie });
  assert.equal(refreshBlocked.status, 403);

  const loginBlocked = await apiReq('POST', '/api/auth/login', {
    body: { email: 'alice@dentstory.test', password: 'password123' },
  });
  assert.equal(loginBlocked.status, 403);
  assert.equal(loginBlocked.data.code, 'ACCOUNT_SUSPENDED');

  const impersonateBlocked = await apiReq('POST', `/api/admin/dentists/${DENTIST_A_ID}/impersonate`, {
    token: adminToken,
  });
  assert.equal(impersonateBlocked.status, 403);

  // Even if a RefreshToken doc somehow lingered in DB for a suspended dentist, /api/auth/refresh still blocks & deletes it
  const strayRefresh = jwt.sign({ id: String(DENTIST_A_ID), role: 'dentist' }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '30d' });
  await RefreshToken.create({ dentistId: DENTIST_A_ID, token: strayRefresh, expiresAt: new Date(Date.now() + 60000) });
  const strayRefreshRes = await apiReq('POST', '/api/auth/refresh', { cookie: `refreshToken=${strayRefresh}` });
  assert.equal(strayRefreshRes.status, 403);
  assert.equal(strayRefreshRes.data.code, 'ACCOUNT_SUSPENDED');
  assert.equal(refreshTokens.filter((t) => String(t.dentistId) === String(DENTIST_A_ID)).length, 0);

  // ── 4. Suspended Dentist A's public portfolio & public case are hidden without overwriting isPublished ──
  const pubPortSuspended = await apiReq('GET', '/api/portfolio/dr-alice-dental');
  assert.equal(pubPortSuspended.status, 403);

  const pubCaseSuspended = await apiReq('GET', `/api/portfolio/dr-alice-dental/case/${CASE_A_ID}`);
  assert.equal(pubCaseSuspended.status, 403);

  // Pre-suspension publish flag was NOT destructively overwritten
  assert.equal(portfolios.get(String(DENTIST_A_ID)).isPublished, true);
  assert.equal(portfolios.get(String(DENTIST_A_ID)).isSuspended, false);

  // ── 5. Admin reactivates Dentist A ──
  // Seed a stale cache entry to verify reactivation also clears analyticsCache
  analyticsCache.set(`dash_${DENTIST_A_ID}_monthly`, { stale: true }, 300);

  const reactivateRes = await apiReq('PATCH', `/api/admin/dentists/${DENTIST_A_ID}/status`, {
    token: adminToken,
  });
  assert.equal(reactivateRes.status, 200);
  assert.equal(reactivateRes.data.status, 'active');
  assert.equal(analyticsCache.get(`dash_${DENTIST_A_ID}_monthly`), null);
  assert.equal(analyticsCache.get(`prof_${DENTIST_A_ID}`), null);

  // ── 6. Reactivation restores login, refresh, private Portfolio/Media Library, and public visibility ──
  const reloginRes = await apiReq('POST', '/api/auth/login', {
    body: { email: 'alice@dentstory.test', password: 'password123' },
  });
  assert.equal(reloginRes.status, 200);
  const newAliceToken = reloginRes.data.accessToken;
  const newAliceCookie = extractRefreshCookie(reloginRes.setCookie);
  assert.ok(newAliceToken);
  assert.ok(newAliceCookie);

  const refreshOk = await apiReq('POST', '/api/auth/refresh', { cookie: newAliceCookie });
  assert.equal(refreshOk.status, 200);
  assert.ok(refreshOk.data.accessToken);

  const myPortRestored = await apiReq('GET', '/api/portfolio/me/portfolio', { token: newAliceToken });
  assert.equal(myPortRestored.status, 200);
  assert.equal(myPortRestored.data.isPublished, true);

  const mediaRestored = await apiReq('GET', '/api/portfolio/me/media-library', { token: newAliceToken });
  assert.equal(mediaRestored.status, 200);

  const pubPortRestored = await apiReq('GET', '/api/portfolio/dr-alice-dental');
  assert.equal(pubPortRestored.status, 200);
  assert.equal(pubPortRestored.data.cases.length, 1);
  assert.equal(pubPortRestored.data.cvUrl, 'https://res.cloudinary.com/demo/raw/upload/v1/cv/alice_cv.pdf');
  assert.equal(pubPortRestored.data.cvFileName, 'Alice_Dental_CV.pdf');

  const pubCaseRestored = await apiReq('GET', `/api/portfolio/dr-alice-dental/case/${CASE_A_ID}`);
  assert.equal(pubCaseRestored.status, 200);
  assert.equal(pubCaseRestored.data.case.title, 'Anterior Crown');
});

test('Reactivation preserves pre-suspension draft (isPublished: false) and portfolio-level suspension (isSuspended: true)', async () => {
  seedData();
  const adminToken = signToken(ADMIN_ID, 'admin');

  // Set portfolio to draft before suspending dentist
  portfolios.get(String(DENTIST_A_ID)).isPublished = false;

  // Suspend then reactivate dentist
  await apiReq('PATCH', `/api/admin/dentists/${DENTIST_A_ID}/status`, { token: adminToken });
  await apiReq('PATCH', `/api/admin/dentists/${DENTIST_A_ID}/status`, { token: adminToken });

  // Portfolio must STILL be in draft mode (403)
  assert.equal(portfolios.get(String(DENTIST_A_ID)).isPublished, false);
  const draftCheck = await apiReq('GET', '/api/portfolio/dr-alice-dental');
  assert.equal(draftCheck.status, 403);

  // Now set isPublished: true but portfolio.isSuspended: true before suspending dentist
  portfolios.get(String(DENTIST_A_ID)).isPublished = true;
  portfolios.get(String(DENTIST_A_ID)).isSuspended = true;

  await apiReq('PATCH', `/api/admin/dentists/${DENTIST_A_ID}/status`, { token: adminToken });
  await apiReq('PATCH', `/api/admin/dentists/${DENTIST_A_ID}/status`, { token: adminToken });

  // Portfolio-level suspension must STILL hold (403)
  assert.equal(portfolios.get(String(DENTIST_A_ID)).isSuspended, true);
  const portSuspendedCheck = await apiReq('GET', '/api/portfolio/dr-alice-dental');
  assert.equal(portSuspendedCheck.status, 403);
});

test('getMyPortfolio category filtering, global categories breakdown, and pagination', async () => {
  seedData();
  const aliceToken = signToken(DENTIST_A_ID, 'dentist');

  const alicePort = portfolios.get(String(DENTIST_A_ID));
  alicePort.publishedCases = [
    {
      _id: new mongoose.Types.ObjectId(),
      session_id: SESSION_A_ID,
      title: 'Case 1 - Anterior Crown',
      category: 'Esthetic',
      treatmentType: ['Fixed'],
      selectedImages: ['https://res.cloudinary.com/demo/case-1.jpg'],
      coverImage: 'https://res.cloudinary.com/demo/case-1.jpg',
      order: 0,
    },
    {
      _id: new mongoose.Types.ObjectId(),
      session_id: SESSION_A_ID,
      title: 'Case 2 - Wisdom Tooth',
      category: 'Surgery',
      treatmentType: ['Surgery'],
      selectedImages: ['https://res.cloudinary.com/demo/case-2.jpg'],
      coverImage: 'https://res.cloudinary.com/demo/case-2.jpg',
      order: 1,
    },
    {
      _id: new mongoose.Types.ObjectId(),
      session_id: SESSION_A_ID,
      title: 'Case 3 - All on 4',
      category: 'Implantology',
      treatmentType: ['Surgery', 'Implant'],
      selectedImages: ['https://res.cloudinary.com/demo/case-3.jpg'],
      coverImage: 'https://res.cloudinary.com/demo/case-3.jpg',
      order: 2,
    },
    {
      _id: new mongoose.Types.ObjectId(),
      session_id: SESSION_A_ID,
      title: 'Case 4 - Composite Filling',
      category: '',
      treatmentType: ['General'],
      selectedImages: ['https://res.cloudinary.com/demo/case-4.jpg'],
      coverImage: 'https://res.cloudinary.com/demo/case-4.jpg',
      order: 3,
    },
  ];

  // 1. Unfiltered request returns all cases and global category breakdown
  const resAll = await apiReq('GET', '/api/portfolio/me/portfolio', { token: aliceToken });
  assert.equal(resAll.status, 200);
  assert.equal(resAll.data.totalAllCases, 4);
  assert.equal(resAll.data.pagination.totalItems, 4);
  assert.equal(resAll.data.pagination.totalCases, 4);
  assert.equal(resAll.data.publishedCases.length, 4);
  assert.equal(resAll.data.selectedCategory, '');

  // Verify categories array is populated and sorted by count desc
  const surgeryCat = resAll.data.categories.find((c) => c.name.toLowerCase() === 'surgery');
  assert.ok(surgeryCat, 'Surgery category should be present');
  assert.equal(surgeryCat.count, 2); // Case 2 and Case 3

  // 2. Filter by category=surgery (case-insensitive)
  const resSurgery = await apiReq('GET', '/api/portfolio/me/portfolio?category=surgery', { token: aliceToken });
  assert.equal(resSurgery.status, 200);
  assert.equal(resSurgery.data.totalAllCases, 4); // Still 4 total across all categories
  assert.equal(resSurgery.data.pagination.totalItems, 2);
  assert.equal(resSurgery.data.publishedCases.length, 2);
  assert.equal(resSurgery.data.selectedCategory, 'surgery');
  assert.deepEqual(
    resSurgery.data.publishedCases.map((c) => c.title),
    ['Case 2 - Wisdom Tooth', 'Case 3 - All on 4']
  );

  // 3. Filter by category=Esthetic (matching category field)
  const resEsthetic = await apiReq('GET', '/api/portfolio/me/portfolio?category=Esthetic', { token: aliceToken });
  assert.equal(resEsthetic.status, 200);
  assert.equal(resEsthetic.data.pagination.totalItems, 1);
  assert.equal(resEsthetic.data.publishedCases[0].title, 'Case 1 - Anterior Crown');

  // 4. Filter by category=all resets filter to all cases
  const resCategoryAll = await apiReq('GET', '/api/portfolio/me/portfolio?category=all', { token: aliceToken });
  assert.equal(resCategoryAll.status, 200);
  assert.equal(resCategoryAll.data.pagination.totalItems, 4);
  assert.equal(resCategoryAll.data.publishedCases.length, 4);

  // 5. Filter by non-existent category returns 0 cases but preserves categories and totalAllCases
  const resEmpty = await apiReq('GET', '/api/portfolio/me/portfolio?category=NonExistent', { token: aliceToken });
  assert.equal(resEmpty.status, 200);
  assert.equal(resEmpty.data.totalAllCases, 4);
  assert.equal(resEmpty.data.pagination.totalItems, 0);
  assert.equal(resEmpty.data.publishedCases.length, 0);
  assert.ok(resEmpty.data.categories.length > 0);

  // 6. Pagination with limit=2
  const resPage1 = await apiReq('GET', '/api/portfolio/me/portfolio?page=1&limit=2', { token: aliceToken });
  assert.equal(resPage1.status, 200);
  assert.equal(resPage1.data.pagination.totalPages, 2);
  assert.equal(resPage1.data.pagination.currentPage, 1);
  assert.equal(resPage1.data.publishedCases.length, 2);
  assert.equal(resPage1.data.publishedCases[0].title, 'Case 1 - Anterior Crown');

  const resPage2 = await apiReq('GET', '/api/portfolio/me/portfolio?page=2&limit=2', { token: aliceToken });
  assert.equal(resPage2.status, 200);
  assert.equal(resPage2.data.pagination.currentPage, 2);
  assert.equal(resPage2.data.publishedCases.length, 2);
  assert.equal(resPage2.data.publishedCases[0].title, 'Case 3 - All on 4');
});

test('Case Priority Ordering: isFeatured toggle, direct rank position, and unified sorting', async () => {
  seedData();
  const aliceToken = signToken(DENTIST_A_ID, 'dentist');
  const alicePort = portfolios.get(String(DENTIST_A_ID));

  const id1 = new mongoose.Types.ObjectId();
  const id2 = new mongoose.Types.ObjectId();
  const id3 = new mongoose.Types.ObjectId();
  const id4 = new mongoose.Types.ObjectId();

  const caseDocs = [
    {
      _id: id1,
      title: 'Case Alpha',
      order: 0,
      isFeatured: false,
      publishedAt: new Date(Date.now() - 3000),
    },
    {
      _id: id2,
      title: 'Case Beta',
      order: 1,
      isFeatured: false,
      publishedAt: new Date(Date.now() - 2000),
    },
    {
      _id: id3,
      title: 'Case Gamma',
      order: 2,
      isFeatured: false,
      publishedAt: new Date(Date.now() - 1000),
    },
    {
      _id: id4,
      title: 'Case Delta',
      order: 3,
      isFeatured: false,
      publishedAt: new Date(),
    },
  ];
  caseDocs.id = function (id) {
    return this.find((c) => String(c._id) === String(id)) || null;
  };
  alicePort.publishedCases = caseDocs;

  // 1. Initially sorted Alpha (0), Beta (1), Gamma (2), Delta (3)
  const initial = await apiReq('GET', '/api/portfolio/me/portfolio', { token: aliceToken });
  assert.equal(initial.status, 200);
  assert.deepEqual(
    initial.data.publishedCases.map((c) => c.title),
    ['Case Alpha', 'Case Beta', 'Case Gamma', 'Case Delta']
  );

  // 2. Toggle Case Gamma to isFeatured = true -> Gamma MUST jump to #1 ahead of all unfeatured cases
  const featRes = await apiReq('PATCH', `/api/portfolio/me/cases/${id3}/featured`, {
    token: aliceToken,
    body: { isFeatured: true },
  });
  assert.equal(featRes.status, 200);
  assert.equal(featRes.data.isFeatured, true);

  // Verify in getMyPortfolio
  const myPortFeat = await apiReq('GET', '/api/portfolio/me/portfolio', { token: aliceToken });
  assert.equal(myPortFeat.status, 200);
  assert.deepEqual(
    myPortFeat.data.publishedCases.map((c) => c.title),
    ['Case Gamma', 'Case Alpha', 'Case Beta', 'Case Delta']
  );
  assert.equal(myPortFeat.data.publishedCases[0].globalRank, 1);
  assert.equal(myPortFeat.data.publishedCases[0].isFeatured, true);
  assert.equal(myPortFeat.data.publishedCases[1].isFeatured, false);

  // Verify in getPublicPortfolio
  const pubPortFeat = await apiReq('GET', '/api/portfolio/dr-alice-dental');
  assert.equal(pubPortFeat.status, 200);
  assert.deepEqual(
    pubPortFeat.data.cases.map((c) => c.title),
    ['Case Gamma', 'Case Alpha', 'Case Beta', 'Case Delta']
  );
  assert.equal(pubPortFeat.data.cases[0].isFeatured, true);

  // 3. Move Case Delta to position 1 -> Delta is non-featured, so it moves to top of non-featured cases (position 2, right behind Gamma)
  const moveDeltaTop = await apiReq('PATCH', `/api/portfolio/me/cases/${id4}/position`, {
    token: aliceToken,
    body: { position: 1 },
  });
  assert.equal(moveDeltaTop.status, 200);
  assert.equal(moveDeltaTop.data.newPosition, 2);

  const myPortDelta = await apiReq('GET', '/api/portfolio/me/portfolio', { token: aliceToken });
  assert.deepEqual(
    myPortDelta.data.publishedCases.map((c) => c.title),
    ['Case Gamma', 'Case Delta', 'Case Alpha', 'Case Beta']
  );
  assert.deepEqual(
    myPortDelta.data.publishedCases.map((c) => c.order),
    [0, 1, 2, 3]
  );

  // 4. Move Case Delta to position 4 (last place)
  const moveDeltaEnd = await apiReq('PATCH', `/api/portfolio/me/cases/${id4}/position`, {
    token: aliceToken,
    body: { position: 4 },
  });
  assert.equal(moveDeltaEnd.status, 200);
  assert.equal(moveDeltaEnd.data.newPosition, 4);

  const myPortDeltaEnd = await apiReq('GET', '/api/portfolio/me/portfolio', { token: aliceToken });
  assert.deepEqual(
    myPortDeltaEnd.data.publishedCases.map((c) => c.title),
    ['Case Gamma', 'Case Alpha', 'Case Beta', 'Case Delta']
  );

  // 5. Unpin Case Gamma -> returns to normal order based on numeric order/publishedAt
  const unpinRes = await apiReq('PATCH', `/api/portfolio/me/cases/${id3}/featured`, {
    token: aliceToken,
    body: { isFeatured: false },
  });
  assert.equal(unpinRes.status, 200);
  assert.equal(unpinRes.data.isFeatured, false);

  // Now with all unpinned, move Beta to position 1 (global #1)
  const moveBetaTop = await apiReq('PATCH', `/api/portfolio/me/cases/${id2}/position`, {
    token: aliceToken,
    body: { position: 1 },
  });
  assert.equal(moveBetaTop.status, 200);
  assert.equal(moveBetaTop.data.newPosition, 1);

  const myPortBetaTop = await apiReq('GET', '/api/portfolio/me/portfolio', { token: aliceToken });
  assert.deepEqual(
    myPortBetaTop.data.publishedCases.map((c) => c.title),
    ['Case Beta', 'Case Gamma', 'Case Alpha', 'Case Delta']
  );
  assert.deepEqual(
    myPortBetaTop.data.publishedCases.map((c) => c.order),
    [0, 1, 2, 3]
  );
});

test('Granular Per-Field Visibility: server-side redaction in getPublicPortfolio, full preservation in getMyPortfolio, and restoration', async () => {
  seedData();
  const aliceToken = signToken(DENTIST_A_ID, 'dentist');

  // 1. Initial public fetch: all fields present
  const pubInitial = await apiReq('GET', '/api/portfolio/dr-alice-dental');
  assert.equal(pubInitial.status, 200);
  assert.equal(pubInitial.data.contactPhone, '01011111111');
  assert.equal(pubInitial.data.bio, 'Implant specialist');
  assert.equal(pubInitial.data.cvUrl, 'https://res.cloudinary.com/demo/raw/upload/v1/cv/alice_cv.pdf');
  assert.equal(pubInitial.data.cvFileName, 'Alice_Dental_CV.pdf');
  assert.equal(pubInitial.data.yearsOfExperience, 7);
  assert.deepEqual(pubInitial.data.services, ['Implants']);

  // 2. Hide phone, cv, and bio via PATCH /api/portfolio/me/visibility
  const patchVis = await apiReq('PATCH', '/api/portfolio/me/visibility', {
    token: aliceToken,
    body: {
      visibility: {
        phone: false,
        whatsapp: false,
        cv: false,
        bio: false,
      },
    },
  });
  assert.equal(patchVis.status, 200);
  assert.equal(patchVis.data.visibility.phone, false);
  assert.equal(patchVis.data.visibility.cv, false);
  assert.equal(patchVis.data.visibility.bio, false);

  // 3. getPublicPortfolio must redact phone, whatsappPhone, cv, and bio
  const pubRedacted = await apiReq('GET', '/api/portfolio/dr-alice-dental');
  assert.equal(pubRedacted.status, 200);
  assert.equal(pubRedacted.data.contactPhone, '');
  assert.equal(pubRedacted.data.whatsappPhone, '');
  assert.equal(pubRedacted.data.bio, '');
  assert.equal(pubRedacted.data.cvUrl, '');
  assert.equal(pubRedacted.data.cvFileName, '');
  assert.equal(pubRedacted.data.visibility.phone, false);
  assert.equal(pubRedacted.data.visibility.cv, false);
  assert.equal(pubRedacted.data.visibility.bio, false);
  // Unhidden fields remain visible
  assert.equal(pubRedacted.data.yearsOfExperience, 7);
  assert.deepEqual(pubRedacted.data.services, ['Implants']);

  // 4. getMyPortfolio preserves all original doctor data untouched
  const myPort = await apiReq('GET', '/api/portfolio/me/portfolio', { token: aliceToken });
  assert.equal(myPort.status, 200);
  assert.equal(myPort.data.contactPhone, '01011111111');
  assert.equal(myPort.data.bio, 'Implant specialist');
  assert.equal(myPort.data.cvUrl, 'https://res.cloudinary.com/demo/raw/upload/v1/cv/alice_cv.pdf');
  assert.equal(myPort.data.cvFileName, 'Alice_Dental_CV.pdf');
  assert.equal(myPort.data.yearsOfExperience, 7);
  assert.deepEqual(myPort.data.services, ['Implants']);
  assert.equal(myPort.data.visibility.phone, false);

  // 5. Re-enable visibility flags via PUT /api/portfolio/me/portfolio
  const restoreRes = await apiReq('PUT', '/api/portfolio/me/portfolio', {
    token: aliceToken,
    body: {
      visibility: {
        phone: true,
        whatsapp: true,
        cv: true,
        bio: true,
      },
    },
  });
  assert.equal(restoreRes.status, 200);

  // 6. getPublicPortfolio restores all previously redacted fields
  const pubRestored = await apiReq('GET', '/api/portfolio/dr-alice-dental');
  assert.equal(pubRestored.status, 200);
  assert.equal(pubRestored.data.contactPhone, '01011111111');
  assert.equal(pubRestored.data.bio, 'Implant specialist');
  assert.equal(pubRestored.data.cvUrl, 'https://res.cloudinary.com/demo/raw/upload/v1/cv/alice_cv.pdf');
  assert.equal(pubRestored.data.cvFileName, 'Alice_Dental_CV.pdf');
  assert.equal(pubRestored.data.visibility.phone, true);
  assert.equal(pubRestored.data.visibility.cv, true);
  assert.equal(pubRestored.data.visibility.bio, true);
});

