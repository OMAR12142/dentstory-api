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
  const cases = data.publishedCases.map((c) => ({ ...c }));
  cases.id = function (id) {
    return this.find((c) => String(c._id) === String(id)) || null;
  };
  return {
    ...data,
    publishedCases: cases,
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

