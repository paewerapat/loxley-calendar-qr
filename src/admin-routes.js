// Back office: password login, sessions stored in MariaDB, CSRF (Origin) check,
// logout and change password. Protects every /admin* and /api/admin/* route.

import express from 'express';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import {
  USERNAME_RE, normalizeUsername, findUserByUsername, findUserById, recordLogin, setPassword,
} from './admin-users.js';
import { verifyPassword, dummyHash, passwordTooLong, MAX_PASSWORD_BYTES } from './passwords.js';
import {
  DEFAULT_THROTTLE, throttleKey, reserveAttempt, failAttempt, isLocked, clearFailures,
  purgeOldThrottleRows, ThrottleBusyError,
} from './throttle.js';
import { createIpLimiter, createSemaphore } from './rate-limit.js';
import { loginPage, adminHomePage, passwordPage } from './admin-pages.js';
import { errorPage } from './pages.js';

const MySQLStore = MySQLStoreFactory(session);

export const SESSION_COOKIE = 'lx.sid';
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000; // logged out after 8h without use
const CLEANUP_MS = 15 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 10;

export const DEFAULT_AUTH_LIMITS = {
  ...DEFAULT_THROTTLE,
  ipPerMinute: 10, // POST /admin/login + /admin/password per client IP, per process
  maxConcurrentChecks: 2, // bcrypt checks running at once, per process
};

export const MSG = {
  badLogin: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  locked: 'ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่',
  busy: 'มีการเข้าสู่ระบบถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
  badCurrent: 'รหัสผ่านเดิมไม่ถูกต้อง',
  tooShort: `รหัสผ่านใหม่ต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`,
  tooLong: `รหัสผ่านใหม่ยาวเกินไป (ไม่เกิน ${MAX_PASSWORD_BYTES} ไบต์ ประมาณ 24 ตัวอักษรภาษาไทย หรือ 72 ตัวอักษรภาษาอังกฤษ)`,
  formTooLarge: 'ข้อมูลที่ส่งมายาวเกินไป กรุณากรอกใหม่',
  sameAsOld: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม',
  mismatch: 'ยืนยันรหัสผ่านใหม่ไม่ตรงกัน',
  changed: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว',
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// --- CSRF: state-changing requests must come from our own pages -----------------
// Compare Origin (or, if absent, Referer) with PUBLIC_ORIGIN when it is configured,
// otherwise with this request's own origin (req.protocol relies on trust proxy).
export function isSameOrigin(req, publicOrigin = null) {
  const expected = (publicOrigin ?? `${req.protocol}://${req.get('host')}`).toLowerCase();
  const origin = req.get('origin');
  if (origin) return origin.toLowerCase() === expected;
  const referer = req.get('referer');
  if (!referer) return false;
  try {
    return new URL(referer).origin.toLowerCase() === expected;
  } catch {
    return false;
  }
}

// --- express-session helpers as promises ------------------------------------------
const call = (fn) => new Promise((resolve, reject) => fn((err) => (err ? reject(err) : resolve())));
const regenerate = (req) => call((cb) => req.session.regenerate(cb));
const saveSession = (req) => call((cb) => req.session.save(cb));
const destroySession = (req) => (req.session ? call((cb) => req.session.destroy(cb)) : Promise.resolve());

async function startSession(req, userId, loginAt) {
  await regenerate(req); // new session id on every login (no fixation)
  req.session.userId = userId;
  req.session.loginAt = loginAt;
  await saveSession(req);
}

const str = (v) => (typeof v === 'string' ? v : '');

export function mountAdminRoutes(app, { config, pool, limits: overrides = {} }) {
  const limits = { ...DEFAULT_AUTH_LIMITS, ...overrides };
  const publicOrigin = config.publicOrigin ?? null;
  const publicIsHttps = publicOrigin?.startsWith('https://') ?? false;

  // Build the dummy hash now (in the background) instead of on the first unknown
  // username; that login still awaits the same promise.
  dummyHash().catch((err) => console.error(`[auth] dummy hash failed: ${err.message}`));

  // Sessions live in the `sessions` table (created by migration 003), on the app's
  // pool, so they survive restarts and are shared by every Passenger process.
  const store = new MySQLStore({
    createDatabaseTable: false,
    clearExpired: false, // replaced by the unref'd timer below
    expiration: SESSION_IDLE_MS,
  }, pool);
  // Background housekeeping (never in the request path).
  setInterval(() => {
    store.clearExpiredSessions().catch((err) => console.error(`[session] cleanup failed: ${err.code ?? err.message}`));
    purgeOldThrottleRows(pool).catch((err) => console.error(`[auth] throttle cleanup failed: ${err.code ?? err.message}`));
  }, CLEANUP_MS).unref();
  app.locals.sessionStore = store;

  const ipLimiter = createIpLimiter({ limit: limits.ipPerMinute, windowMs: 60 * 1000 });
  setInterval(() => ipLimiter.prune(), 60 * 1000).unref();
  const checks = createSemaphore(limits.maxConcurrentChecks);

  const cookie = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.session.cookieSecure,
    path: '/',
    maxAge: SESSION_IDLE_MS,
  };
  const sessionMiddleware = session({
    name: SESSION_COOKIE,
    secret: config.session.secret,
    store,
    resave: false,
    saveUninitialized: false, // no session (and no cookie) until someone logs in
    rolling: true, // every request pushes the 8h idle timeout forward
    cookie,
  });

  // PUBLIC_ORIGIN=https://… declares that the public site is https-only. Requests
  // only reach Passenger through Plesk's nginx, which serves the site over https,
  // so when nginx did not send X-Forwarded-Proto we take the declared scheme.
  // express-session then still issues the Secure cookie (it checks req.secure).
  // An explicit X-Forwarded-Proto from the proxy is always respected.
  function publicScheme(req, res, next) {
    if (publicIsHttps && !req.get('x-forwarded-proto')) {
      Object.defineProperty(req, 'protocol', { value: 'https', configurable: true, enumerable: true });
    }
    next();
  }

  function sameOrigin({ json }) {
    return (req, res, next) => {
      if (SAFE_METHODS.has(req.method) || isSameOrigin(req, publicOrigin)) return next();
      if (json) return res.status(403).json({ error: 'forbidden' });
      return res.status(403).type('html').send(errorPage({ status: 403 }));
    };
  }

  // Loads req.adminUser from the session. Sessions of deleted users, or that
  // logged in before the last password change, count as logged out.
  async function loadUser(req, res, next) {
    req.adminUser = null;
    const { userId, loginAt } = req.session ?? {};
    if (!userId) return next();
    const user = await findUserById(pool, userId);
    if (user && Number(loginAt) >= user.password_changed_at.getTime()) {
      req.adminUser = user;
      return next();
    }
    // Drop the stale session from the store; the fresh empty one is never saved.
    await regenerate(req);
    return next();
  }

  const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  const urlencoded = express.urlencoded({ extended: false, limit: '10kb' });
  // An oversized form becomes an empty one plus a flag, so the handlers can show a
  // Thai form error instead of the generic 413 page.
  const parseForm = (req, res, next) => urlencoded(req, res, (err) => {
    if (err?.type === 'entity.too.large') {
      req.body = {};
      req.formTooLarge = true;
      return next();
    }
    return next(err);
  });

  /**
   * Shared guard for every password check (login, change password). Runs, in order:
   * per-IP limit → concurrency cap → DB reservation (all before bcrypt) → check.
   * @returns {Promise<'busy'|'locked'|'wrong'|'ok'>}
   */
  async function guardedCheck(req, key, check) {
    if (!ipLimiter.take(req.ip)) return 'busy';
    const release = checks.tryAcquire();
    if (!release) return 'busy';
    try {
      if (await reserveAttempt(pool, key, limits) === 'locked') return 'locked';
      if (!(await check())) return (await failAttempt(pool, key, limits)) ? 'locked' : 'wrong';
      // Other requests of the same burst may have locked the key while bcrypt ran.
      if (await isLocked(pool, key)) return 'locked';
      return 'ok';
    } catch (err) {
      if (err instanceof ThrottleBusyError) return 'busy';
      throw err;
    } finally {
      release();
    }
  }

  const logAttempt = (req, what, outcome) => {
    const line = `[auth] ${what} ${outcome} ip=${req.ip} proto=${req.protocol} secure=${req.secure}`;
    if (outcome === 'ok') console.log(line); else console.warn(line);
  };

  // ---------------------------------------------------------------- /api/admin/*
  const api = express.Router();
  api.use(noStore, publicScheme, sameOrigin({ json: true }), sessionMiddleware, loadUser);
  api.use((req, res, next) => (req.adminUser ? next() : res.status(401).json({ error: 'unauthorized' })));
  // Endpoints arrive with task 04.
  api.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api/admin', api);

  // ---------------------------------------------------------------- /admin*
  const admin = express.Router();
  admin.use(noStore, publicScheme, sameOrigin({ json: false }), sessionMiddleware, parseForm, loadUser);

  const renderLogin = (res, status, opts) => res.status(status).type('html').send(loginPage(opts));

  admin.get('/login', (req, res) => {
    if (req.adminUser) return res.redirect('/admin');
    return renderLogin(res, 200, {});
  });

  admin.post('/login', async (req, res) => {
    // Oversized form: a plain form error, not a password check (not counted).
    if (req.formTooLarge) {
      logAttempt(req, 'login', 'too-large');
      return renderLogin(res, 400, { error: MSG.formTooLarge });
    }
    const body = req.body ?? {};
    const username = normalizeUsername(body.username);
    const password = str(body.password);
    const key = throttleKey(req.ip, username);
    let user = null;

    const outcome = await guardedCheck(req, key, async () => {
      // Over 72 bytes can never be a valid password: a normal (counted) failure.
      if (passwordTooLong(password)) return false;
      user = USERNAME_RE.test(username) ? await findUserByUsername(pool, username) : null;
      // Always one bcrypt compare (dummy hash for unknown users): timing does not
      // tell whether the username exists.
      const matches = await verifyPassword(password, user?.password_hash ?? await dummyHash());
      return Boolean(user && password && matches);
    });
    logAttempt(req, 'login', outcome === 'wrong' ? 'failed' : outcome);

    if (outcome === 'busy') return renderLogin(res, 429, { error: MSG.busy, username });
    if (outcome === 'locked') return renderLogin(res, 429, { error: MSG.locked, username });
    if (outcome === 'wrong') return renderLogin(res, 401, { error: MSG.badLogin, username });

    await startSession(req, user.id, Date.now());
    await recordLogin(pool, user.id);
    await clearFailures(pool, key);
    return res.redirect('/admin');
  });

  // Everything below needs a valid session.
  admin.use((req, res, next) => (req.adminUser ? next() : res.redirect('/admin/login')));

  admin.get('/', (req, res) => {
    const notice = req.query.changed === '1' ? MSG.changed : undefined;
    res.type('html').send(adminHomePage({ username: req.adminUser.username, notice }));
  });

  admin.post('/logout', async (req, res) => {
    await destroySession(req);
    res.clearCookie(SESSION_COOKIE, { ...cookie, maxAge: undefined });
    res.redirect('/admin/login');
  });

  const renderPassword = (res, status, error) => res.status(status).type('html').send(passwordPage({ error }));

  admin.get('/password', (req, res) => renderPassword(res, 200));

  admin.post('/password', async (req, res) => {
    if (req.formTooLarge) return renderPassword(res, 400, MSG.formTooLarge);
    const user = req.adminUser;
    const body = req.body ?? {};
    const current = str(body.current_password);
    const next = str(body.new_password);
    const confirm = str(body.confirm_password);
    const key = throttleKey(req.ip, user.username);

    // A wrong current password counts exactly like a failed login.
    const outcome = await guardedCheck(req, key, async () => (
      Boolean(current) && !passwordTooLong(current) && verifyPassword(current, user.password_hash)
    ));
    if (outcome !== 'ok') logAttempt(req, 'password change', outcome === 'wrong' ? 'failed' : outcome);
    if (outcome === 'busy') return renderPassword(res, 429, MSG.busy);
    if (outcome === 'locked') return renderPassword(res, 429, MSG.locked);
    if (outcome === 'wrong') return renderPassword(res, 400, MSG.badCurrent);

    await clearFailures(pool, key); // the current password was right
    if ([...next].length < MIN_PASSWORD_LENGTH) return renderPassword(res, 400, MSG.tooShort);
    if (passwordTooLong(next)) return renderPassword(res, 400, MSG.tooLong);
    if (next === current) return renderPassword(res, 400, MSG.sameAsOld);
    if (confirm !== next) return renderPassword(res, 400, MSG.mismatch);

    // Hashing the new password is bcrypt work too: it takes a slot as well.
    const release = checks.tryAcquire();
    if (!release) return renderPassword(res, 429, MSG.busy);
    let changedAt;
    try {
      changedAt = await setPassword(pool, user.id, next);
    } finally {
      release();
    }
    // This browser stays logged in (login time = change time); every other session
    // of this user is now older than password_changed_at and gets logged out.
    await startSession(req, user.id, changedAt.getTime());
    logAttempt(req, 'password change', 'ok');
    return res.redirect('/admin?changed=1');
  });

  app.use('/admin', admin);
}
