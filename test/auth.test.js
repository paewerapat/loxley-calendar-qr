// Task 03: login, sessions, throttle, route protection, CSRF, logout and change
// password, end to end against the real test database with real cookies.
// Holds the shared DB test lock. Test users get cheap (cost 4) hashes so the suite
// stays fast; the app itself always writes cost 12 (checked below).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { createPool, connectionOptions } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { MSG, SESSION_IDLE_MS, DEFAULT_AUTH_LIMITS } from '../src/admin-routes.js';
import {
  assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, startServer, Browser,
} from './helpers.js';

const config = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(config.db.database);
// These tests drive many logins from one process: lift the per-process request and
// concurrency guards (their defaults are tested in auth-limits.test.js). The DB
// throttle (5 per IP+username, 100 per username) keeps its real values.
const LIMITS = { ipPerMinute: 100_000, maxConcurrentChecks: 100 };

let conn;
let pool;
let srv;
let ipCounter = 0;
// Every test uses its own client IP so throttle counters never interfere.
const nextIp = () => `203.0.113.${++ipCounter}`;

before(async () => {
  conn = await mysql.createConnection(connectionOptions(config.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(config.db);
  pool = createPool(config.db);
  srv = await startServer(createApp({ config, pool, authLimits: LIMITS }));
});

after(async () => {
  await srv?.close();
  await pool?.end();
  await conn?.end();
});

async function addUser(username, password, hash) {
  await conn.query(
    'INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    [username, hash ?? bcrypt.hashSync(password, 4), new Date(Date.now() - 1000)],
  );
}

const userRow = async (username) => (await conn.query('SELECT * FROM admin_users WHERE username = ?', [username]))[0][0];
const throttleRow = async (ip, username) => (await conn.query(
  'SELECT * FROM login_throttle WHERE ip = ? AND username = ?', [ip, username],
))[0][0];
const browser = (opts = {}) => new Browser(srv.url, { ip: nextIp(), ...opts });

async function loggedIn(username, password) {
  const b = browser();
  const res = await b.login(username, password);
  assert.equal(res.status, 302, `login as ${username} failed`);
  assert.equal(res.headers.get('location'), '/admin');
  assert.ok(b.cookie, 'session cookie set');
  return b;
}

// Capture console output (and keep the test output clean).
function captureLogs(t) {
  const lines = [];
  for (const m of ['log', 'warn', 'error', 'info']) {
    t.mock.method(console, m, (...args) => { lines.push(args.map(String).join(' ')); });
  }
  return lines;
}

// ---------------------------------------------------------------- AC5 login page

test('GET /admin/login: Thai form, no-store, noindex, and no session/cookie for visitors', async () => {
  const b = browser();
  const res = await b.get('/admin/login');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.match(html, /<html lang="th">/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<form method="post" action="\/admin\/login">/);
  assert.match(html, /ชื่อผู้ใช้/);
  assert.match(html, /type="password"/);
  assert.deepEqual(b.setCookies, [], 'saveUninitialized: false');
  // Task 05: the dark/gold look moved from inline CSS to the shared admin.css.
  const css = html.match(/<link rel="stylesheet" href="(\/assets\/admin\.css\?v=[0-9a-f]+)">/);
  assert.ok(css, 'admin.css linked');
  const sheet = await (await b.get(css[1])).text();
  assert.match(sheet, /--bg: #0b0b0c/);
  assert.match(sheet, /--gold: #d4af37/);
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM sessions');
  assert.equal(Number(n), 0);
});

// ---------------------------------------------------------------- AC7 protection

for (const p of ['/admin', '/admin/', '/admin/password', '/admin/anything/else']) {
  test(`AC7: GET ${p} without a session → 302 /admin/login, no cookie`, async () => {
    const b = browser();
    const res = await b.get(p);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/login');
    assert.deepEqual(b.setCookies, []);
  });
}

test('AC7: POST /admin/logout and /admin/password without a session → 302 /admin/login', async () => {
  for (const p of ['/admin/logout', '/admin/password']) {
    const res = await browser().post(p, {});
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get('location'), '/admin/login');
  }
});

for (const [method, p] of [['GET', '/api/admin'], ['GET', '/api/admin/videos'], ['POST', '/api/admin/videos'], ['DELETE', '/api/admin/x']]) {
  test(`AC7: ${method} ${p} without a session → 401 {"error":"unauthorized"}`, async () => {
    const res = await browser().request(p, { method });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  });
}

// ---------------------------------------------------------------- AC4/5/7/9 end to end

test('end to end: login → /admin → API → logout; cookie flags; old cookie dead after logout', async (t) => {
  captureLogs(t);
  await addUser('e2e.user', 'correct horse battery');
  const b = browser();

  // Username is case-insensitive and trimmed.
  const login = await b.login('  E2E.User ', 'correct horse battery');
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/admin');
  const setCookie = b.setCookies.find((c) => c.startsWith('lx.sid='));
  assert.ok(setCookie, 'lx.sid set');
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /; Secure/i, 'COOKIE_SECURE=false in .env.test');
  const expires = new Date(setCookie.match(/Expires=([^;]+)/)[1]).getTime();
  assert.ok(Math.abs(expires - (Date.now() + SESSION_IDLE_MS)) < 60_000, '8h idle expiry');

  const home = await b.get('/admin');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  const html = await home.text();
  assert.match(html, /e2e\.user/);
  assert.match(html, /href="\/admin\/password"/);
  assert.match(html, /<form method="post" action="\/admin\/logout">/);
  assert.match(html, /ออกจากระบบ/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  // rolling: an authenticated response refreshes the cookie
  assert.ok(b.setCookies.some((c) => c.startsWith('lx.sid=')), 'rolling cookie');

  assert.ok((await userRow('e2e.user')).last_login_at instanceof Date, 'last_login_at set');

  const api = await b.get('/api/admin/anything');
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: 'not_found' });

  const again = await b.get('/admin/login');
  assert.equal(again.status, 302);
  assert.equal(again.headers.get('location'), '/admin');

  const oldCookie = b.cookie;
  const logout = await b.post('/admin/logout', {});
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get('location'), '/admin/login');
  assert.ok(b.setCookies.some((c) => /^lx\.sid=;/.test(c) && /Expires=Thu, 01 Jan 1970/i.test(c)), 'cookie cleared');
  assert.equal(b.cookie, null);

  const stale = new Browser(srv.url, { ip: nextIp() });
  stale.cookie = oldCookie;
  const after = await stale.get('/admin');
  assert.equal(after.status, 302);
  assert.equal(after.headers.get('location'), '/admin/login');
  assert.equal((await stale.get('/api/admin/x')).status, 401);
});

test('AC4: sessions are stored in MariaDB with an 8h expiry that rolls forward', async (t) => {
  captureLogs(t);
  await addUser('store.user', 'store password 123');
  const b = await loggedIn('store.user', 'store password 123');
  const sid = decodeURIComponent(b.cookie.split('=')[1]).slice(2).split('.')[0];
  const [[row1]] = await conn.query('SELECT expires, data FROM sessions WHERE session_id = ?', [sid]);
  assert.ok(row1, 'session row exists');
  const data = JSON.parse(row1.data);
  assert.equal(typeof data.userId, 'number');
  assert.equal(typeof data.loginAt, 'number');
  assert.ok(!row1.data.includes('store password'), 'no password in the session');
  assert.ok(Math.abs(row1.expires * 1000 - (Date.now() + SESSION_IDLE_MS)) < 60_000);
  // Pretend the session was last used 2 hours ago; a request pushes it back to 8h.
  await conn.query('UPDATE sessions SET expires = expires - 7200 WHERE session_id = ?', [sid]);
  const res = await b.get('/admin');
  assert.equal(res.status, 200);
  await res.text(); // express-session finishes the touch before the last byte is sent
  const [[row2]] = await conn.query('SELECT expires FROM sessions WHERE session_id = ?', [sid]);
  assert.ok(row2.expires >= row1.expires - 5, 'expiry rolled forward');
});

test('AC4: an expired session is not accepted', async (t) => {
  captureLogs(t);
  await addUser('expired.user', 'expired password 1');
  const b = await loggedIn('expired.user', 'expired password 1');
  const sid = decodeURIComponent(b.cookie.split('=')[1]).slice(2).split('.')[0];
  await conn.query('UPDATE sessions SET expires = UNIX_TIMESTAMP() - 1 WHERE session_id = ?', [sid]);
  const res = await b.get('/admin');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/login');
});

test('AC4: a restarted app (new app + new pool) still accepts the session', async (t) => {
  captureLogs(t);
  await addUser('restart.user', 'restart password 1');
  const b = await loggedIn('restart.user', 'restart password 1');
  const pool2 = createPool(config.db);
  const srv2 = await startServer(createApp({ config, pool: pool2, authLimits: LIMITS }));
  try {
    const b2 = new Browser(srv2.url, { ip: nextIp() });
    b2.cookie = b.cookie;
    const res = await b2.get('/admin');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /restart\.user/);
  } finally {
    await srv2.close();
    await pool2.end();
  }
});

test('AC5: a new session id on every login (regenerate); the previous id stops working', async (t) => {
  captureLogs(t);
  await addUser('regen.user', 'regen password 12');
  const b = await loggedIn('regen.user', 'regen password 12');
  const first = b.cookie;
  const res = await b.login('regen.user', 'regen password 12');
  assert.equal(res.status, 302);
  assert.notEqual(b.cookie, first);
  const old = new Browser(srv.url, { ip: nextIp() });
  old.cookie = first;
  assert.equal((await old.get('/admin')).status, 302);
  // A cookie value planted before login is never adopted.
  const planted = browser();
  planted.cookie = 'lx.sid=s%3Aattacker-chosen-id.signature';
  await planted.login('regen.user', 'regen password 12');
  assert.ok(!planted.cookie.includes('attacker-chosen-id'));
});

test('AC4: COOKIE_SECURE=true → Secure cookie when nginx forwards https (trust proxy)', async (t) => {
  captureLogs(t);
  await addUser('secure.user', 'secure password 1');
  const secureConfig = { ...config, session: { ...config.session, cookieSecure: true } };
  const pool2 = createPool(config.db);
  const srv2 = await startServer(createApp({ config: secureConfig, pool: pool2, authLimits: LIMITS }));
  try {
    const host = new URL(srv2.url).host;
    const b = new Browser(srv2.url, { ip: nextIp() });
    const res = await b.login('secure.user', 'secure password 1', {
      headers: { 'x-forwarded-proto': 'https' },
      origin: `https://${host}`,
    });
    assert.equal(res.status, 302);
    const c = b.setCookies.find((x) => x.startsWith('lx.sid='));
    assert.match(c, /; Secure/i);
  } finally {
    await srv2.close();
    await pool2.end();
  }
});

// ---------------------------------------------------------------- AC5 failures

test('AC5: wrong password, unknown user and blank fields all → 401 with the same message', async (t) => {
  const logs = captureLogs(t);
  await addUser('real.user', 'the real password');
  const cases = [
    ['real.user', 'wrong password'],
    ['no.such.user', 'whatever password'],
    ['', ''],
    ['real.user', ''],
    ['', 'the real password'],
    ['x'.repeat(500), 'long username'],
  ];
  for (const [u, p] of cases) {
    const b = browser();
    const res = await b.login(u, p);
    assert.equal(res.status, 401, `${u}/${p}`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    assert.match(html, new RegExp(`<p class="alert" role="alert">${MSG.badLogin}</p>`));
    assert.deepEqual(b.setCookies, [], 'no session for a failed login');
  }
  const failed = logs.filter((l) => l.startsWith('[auth] login failed ip='));
  assert.equal(failed.length, cases.length);
  assert.ok(failed.every((l) => /^\[auth\] login failed ip=203\.0\.113\.\d+ proto=http secure=false$/.test(l)),
    `req.ip from X-Forwarded-For, plus proto/secure: ${failed[0]}`);
  assert.ok(!logs.some((l) => /the real password|wrong password/.test(l)), 'passwords never logged');
});

test('AC5: an unknown username takes about as long as a wrong password (dummy hash)', async (t) => {
  captureLogs(t);
  await addUser('timing.user', null, await hashPassword('timing password 1')); // real cost 12
  const time = async (u) => {
    const start = process.hrtime.bigint();
    const res = await browser().login(u, 'not the password');
    assert.equal(res.status, 401);
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  await time('warm.up.user'); // first call also builds the dummy hash
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const known = [];
  const unknown = [];
  for (let i = 0; i < 3; i++) {
    known.push(await time('timing.user'));
    unknown.push(await time(`ghost.${i}`));
  }
  const ratio = median(unknown) / median(known);
  assert.ok(ratio > 0.5 && ratio < 2, `unknown ${median(unknown)}ms vs wrong password ${median(known)}ms`);
  assert.ok(median(unknown) > 50, 'unknown user still runs a cost-12 compare');
});

// ---------------------------------------------------------------- AC6 throttle

test('AC6: 5 failures in 15 min for IP+username → 429, even with the right password; other IP fine', async (t) => {
  captureLogs(t);
  await addUser('locked.user', 'locked password 1');
  const ip = nextIp();
  const b = browser({ ip });
  for (let i = 1; i <= 4; i++) assert.equal((await b.login('locked.user', 'nope')).status, 401, `attempt ${i}`);
  const fifth = await b.login('LOCKED.user', 'nope'); // same key: lowercased
  assert.equal(fifth.status, 429);
  assert.match(await fifth.text(), new RegExp(MSG.locked));
  const right = await b.login('locked.user', 'locked password 1');
  assert.equal(right.status, 429);
  assert.match(await right.text(), new RegExp(MSG.locked));
  assert.equal(b.cookie, null);
  const row = await throttleRow(ip, 'locked.user');
  assert.equal(row.failures, 5);
  assert.ok(row.locked_until.getTime() - Date.now() > 14 * 60_000);
  // Another IP for the same user is not locked.
  await loggedIn('locked.user', 'locked password 1');
});

test('AC6: unknown usernames lock the same way (no hint whether the user exists)', async (t) => {
  captureLogs(t);
  const b = browser();
  for (let i = 1; i <= 4; i++) assert.equal((await b.login('ghost.user', 'nope')).status, 401);
  const res = await b.login('ghost.user', 'nope');
  assert.equal(res.status, 429);
  assert.match(await res.text(), new RegExp(MSG.locked));
});

test('AC6: the lock is in the database: a restarted app still refuses', async (t) => {
  captureLogs(t);
  await addUser('durable.user', 'durable password 1');
  const ip = nextIp();
  for (let i = 0; i < 5; i++) await browser({ ip }).login('durable.user', 'nope');
  const pool2 = createPool(config.db);
  const srv2 = await startServer(createApp({ config, pool: pool2, authLimits: LIMITS }));
  try {
    const res = await new Browser(srv2.url, { ip }).login('durable.user', 'durable password 1');
    assert.equal(res.status, 429);
  } finally {
    await srv2.close();
    await pool2.end();
  }
});

test('AC6: failures older than 15 minutes start a new window; an expired lock lets the right password in', async (t) => {
  captureLogs(t);
  await addUser('window.user', 'window password 1');
  const ip = nextIp();
  const b = browser({ ip });
  for (let i = 0; i < 4; i++) await b.login('window.user', 'nope');
  await conn.query(
    'UPDATE login_throttle SET first_failed_at = UTC_TIMESTAMP(3) - INTERVAL 16 MINUTE WHERE ip = ? AND username = ?',
    [ip, 'window.user'],
  );
  assert.equal((await b.login('window.user', 'nope')).status, 401, 'old failures no longer count');
  assert.equal((await throttleRow(ip, 'window.user')).failures, 1);

  for (let i = 0; i < 4; i++) await b.login('window.user', 'nope');
  assert.equal((await b.login('window.user', 'window password 1')).status, 429);
  await conn.query(
    'UPDATE login_throttle SET locked_until = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE ip = ? AND username = ?',
    [ip, 'window.user'],
  );
  assert.equal((await b.login('window.user', 'window password 1')).status, 302);
  assert.equal(await throttleRow(ip, 'window.user'), undefined, 'success clears the counter');
});

test('AC6: a successful login clears the counter for that key', async (t) => {
  captureLogs(t);
  await addUser('clear.user', 'clear password 12');
  const ip = nextIp();
  const b = browser({ ip });
  for (let i = 0; i < 3; i++) await b.login('clear.user', 'nope');
  assert.equal((await throttleRow(ip, 'clear.user')).failures, 3);
  assert.equal((await b.login('clear.user', 'clear password 12')).status, 302);
  assert.equal(await throttleRow(ip, 'clear.user'), undefined);
});

test('AC6: concurrent failures are all counted (row lock)', async (t) => {
  captureLogs(t);
  const ip = nextIp();
  await Promise.all(Array.from({ length: 4 }, () => browser({ ip }).login('race.user', 'nope')));
  assert.equal((await throttleRow(ip, 'race.user')).failures, 4);
});

// ---------------------------------------------------------------- AC8 CSRF

test('AC8: POST /admin/login needs a matching Origin, or a matching Referer when Origin is absent', async (t) => {
  captureLogs(t);
  await addUser('csrf.user', 'csrf password 12');
  const host = new URL(srv.url).host;
  const form = { username: 'csrf.user', password: 'csrf password 12' };
  const cases = [
    [{ origin: null }, 403], // neither header
    [{ origin: 'https://evil.example' }, 403],
    [{ origin: 'null' }, 403],
    [{ origin: `https://${host}` }, 403], // wrong scheme (no https proxy header)
    [{ origin: null, headers: { referer: 'https://evil.example/admin/login' } }, 403],
    [{ origin: null, headers: { referer: 'not a url' } }, 403],
    [{ origin: null, headers: { referer: `${srv.url}/admin/login` } }, 302],
    [{ origin: srv.url }, 302],
    [{ origin: `https://${host}`, headers: { 'x-forwarded-proto': 'https' } }, 302],
  ];
  for (const [opts, status] of cases) {
    const b = browser();
    const res = await b.post('/admin/login', form, opts);
    assert.equal(res.status, status, JSON.stringify(opts));
    if (status === 403) {
      assert.match(await res.text(), /<html lang="th">/);
      assert.equal(b.cookie, null);
    }
  }
});

test('AC8: logout, change password and API writes are refused without a matching Origin', async (t) => {
  captureLogs(t);
  await addUser('csrf2.user', 'csrf2 password 1');
  const b = await loggedIn('csrf2.user', 'csrf2 password 1');
  for (const p of ['/admin/logout', '/admin/password']) {
    const res = await b.post(p, { current_password: 'csrf2 password 1', new_password: 'x'.repeat(12), confirm_password: 'x'.repeat(12) },
      { origin: 'https://evil.example' });
    assert.equal(res.status, 403, p);
  }
  const api = await b.request('/api/admin/videos', { method: 'PUT', origin: null });
  assert.equal(api.status, 403);
  assert.deepEqual(await api.json(), { error: 'forbidden' });
  // Still logged in, password unchanged.
  assert.equal((await b.get('/admin')).status, 200);
  assert.equal((await browser().login('csrf2.user', 'csrf2 password 1')).status, 302);
});

// ---------------------------------------------------------------- AC7 invalidation

test('AC7: a deleted user is logged out', async (t) => {
  captureLogs(t);
  await addUser('deleted.user', 'deleted password 1');
  const b = await loggedIn('deleted.user', 'deleted password 1');
  await conn.query("DELETE FROM admin_users WHERE username = 'deleted.user'");
  const res = await b.get('/admin');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/login');
  assert.equal((await b.get('/api/admin/x')).status, 401);
});

test('AC7: a session that logged in before password_changed_at is logged out', async (t) => {
  captureLogs(t);
  await addUser('changed.user', 'changed password 1');
  const b = await loggedIn('changed.user', 'changed password 1');
  await conn.query("UPDATE admin_users SET password_changed_at = UTC_TIMESTAMP(3) + INTERVAL 1 SECOND WHERE username = 'changed.user'");
  assert.equal((await b.get('/admin')).status, 302);
});

// ---------------------------------------------------------------- AC10 change password

test('AC10: change password — validation messages in Thai', async (t) => {
  captureLogs(t);
  await addUser('pw.rules', 'old password 123');
  const b = await loggedIn('pw.rules', 'old password 123');
  const page = await b.get('/admin/password');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const form = await page.text();
  for (const name of ['current_password', 'new_password', 'confirm_password']) assert.match(form, new RegExp(`name="${name}"`));

  const tryChange = async (current, next, confirm) => {
    const res = await b.post('/admin/password', { current_password: current, new_password: next, confirm_password: confirm });
    return { status: res.status, html: await res.text() };
  };
  const wrong = await tryChange('not my password', 'brand new password', 'brand new password');
  assert.equal(wrong.status, 400);
  assert.match(wrong.html, new RegExp(MSG.badCurrent));
  const short = await tryChange('old password 123', 'short1234', 'short1234');
  assert.equal(short.status, 400);
  assert.match(short.html, new RegExp(MSG.tooShort));
  const thai = await tryChange('old password 123', 'รหัสไทยสั้น', 'รหัสไทยสั้น'); // 11 characters
  assert.notEqual(thai.status, 400, 'length counts characters, not bytes');
  // thai succeeded → the password is now 'รหัสไทยสั้น'
  const same = await tryChange('รหัสไทยสั้น', 'รหัสไทยสั้น', 'รหัสไทยสั้น');
  assert.equal(same.status, 400);
  assert.match(same.html, new RegExp(MSG.sameAsOld));
  const mismatch = await tryChange('รหัสไทยสั้น', 'another password 1', 'another password 2');
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.html, new RegExp(MSG.mismatch));
});

test('AC10/AC12: success → cost-12 hash, this browser stays in, other sessions are logged out', async (t) => {
  const logs = captureLogs(t);
  await addUser('pw.change', 'first password 12');
  const a = await loggedIn('pw.change', 'first password 12');
  const other = await loggedIn('pw.change', 'first password 12');
  const before = await userRow('pw.change');

  const res = await a.post('/admin/password', {
    current_password: 'first password 12', new_password: 'second password 34', confirm_password: 'second password 34',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin?changed=1');

  const home = await a.get('/admin?changed=1');
  assert.equal(home.status, 200, 'the browser that changed it stays logged in');
  assert.match(await home.text(), new RegExp(MSG.changed));
  assert.equal((await other.get('/admin')).status, 302, 'other session logged out');

  const row = await userRow('pw.change');
  assert.match(row.password_hash, /^\$2[ab]\$12\$/, 'bcrypt cost 12');
  assert.ok(row.password_changed_at > before.password_changed_at);
  assert.equal((await browser().login('pw.change', 'first password 12')).status, 401);
  assert.equal((await browser().login('pw.change', 'second password 34')).status, 302);

  const all = logs.join('\n');
  assert.ok(!/first password|second password/.test(all), 'no password in logs');
  assert.ok(!all.includes(row.password_hash) && !all.includes('$2'), 'no hash in logs');
});

test('AC10: wrong current password counts toward the throttle (5 → 429)', async (t) => {
  captureLogs(t);
  await addUser('pw.throttle', 'throttle password 1');
  const ip = nextIp();
  const b = browser({ ip });
  assert.equal((await b.login('pw.throttle', 'throttle password 1')).status, 302);
  const attempt = () => b.post('/admin/password', {
    current_password: 'bad', new_password: 'new password 123', confirm_password: 'new password 123',
  });
  for (let i = 0; i < 4; i++) assert.equal((await attempt()).status, 400);
  assert.equal((await throttleRow(ip, 'pw.throttle')).failures, 4);
  const locked = await attempt();
  assert.equal(locked.status, 429);
  assert.match(await locked.text(), new RegExp(MSG.locked));
  const right = await b.post('/admin/password', {
    current_password: 'throttle password 1', new_password: 'new password 123', confirm_password: 'new password 123',
  });
  assert.equal(right.status, 429, 'locked even with the right current password');
});

// ---------------------------------------------------------------- round 2: races, caps, limits

// Counts real bcrypt evaluations (src/passwords.js calls bcrypt.compare on this object).
function spyCompare(t) {
  const calls = [];
  const original = bcrypt.compare;
  t.mock.method(bcrypt, 'compare', function (password, hash, ...rest) {
    calls.push(hash);
    return original.call(this, password, hash, ...rest);
  });
  return calls;
}

test('Q1: a parallel burst of wrong passwords evaluates at most 5 per IP+username', async (t) => {
  captureLogs(t);
  const hash = await hashPassword('burst password 12'); // cost 12: requests overlap
  await addUser('burst.user', null, hash);
  const calls = spyCompare(t);
  const ip = nextIp();
  const statuses = await Promise.all(Array.from({ length: 12 }, (_, i) => browser({ ip })
    .login('burst.user', `wrong ${i}`).then((r) => r.status)));
  const evaluated = calls.filter((h) => h === hash).length;
  assert.ok(evaluated <= 5, `bcrypt ran ${evaluated} times`);
  assert.ok(!statuses.includes(302) && !statuses.includes(500), statuses.join(','));
  assert.ok(statuses.filter((s) => s === 429).length >= 7, statuses.join(','));
  const row = await throttleRow(ip, 'burst.user');
  assert.equal(row.failures, 5);
  assert.ok(row.locked_until > new Date());
});

test('Q1: the right password sent while 5 wrong ones are still being checked is refused and clears nothing', async (t) => {
  captureLogs(t);
  await addUser('burst.right', null, await hashPassword('burst right pass 1'));
  const ip = nextIp();
  const wrong = Array.from({ length: 5 }, (_, i) => browser({ ip }).login('burst.right', `wrong ${i}`));
  await new Promise((r) => setTimeout(r, 40)); // all 5 are reserved and inside bcrypt now
  const right = await browser({ ip }).login('burst.right', 'burst right pass 1');
  assert.equal(right.status, 429);
  assert.match(await right.text(), new RegExp(MSG.locked));
  const statuses = (await Promise.all(wrong)).map((r) => r.status);
  assert.ok(!statuses.includes(500), statuses.join(','));
  const row = await throttleRow(ip, 'burst.right');
  assert.ok(row && row.failures === 5 && row.locked_until > new Date(), 'counter kept, key locked');
  assert.equal((await browser({ ip }).login('burst.right', 'burst right pass 1')).status, 429);
});

test('Q1: 4 wrong passwords then the right one (sequential) still logs in on the 5th try', async (t) => {
  captureLogs(t);
  await addUser('fifth.try', 'fifth try password');
  const ip = nextIp();
  for (let i = 0; i < 4; i++) assert.equal((await browser({ ip }).login('fifth.try', 'nope')).status, 401);
  assert.equal((await browser({ ip }).login('fifth.try', 'fifth try password')).status, 302);
  assert.equal(await throttleRow(ip, 'fifth.try'), undefined);
});

test('R2: the per-username cap (any IP) defaults to 100 failures per 15 minutes', () => {
  assert.equal(DEFAULT_AUTH_LIMITS.usernameFailures, 100);
  assert.equal(DEFAULT_AUTH_LIMITS.keyFailures, 5);
});

test('R2: reaching the per-username cap from several IPs locks that username everywhere (same message)', async (t) => {
  captureLogs(t);
  // Same mechanism as the default 100, with a cap of 10 to keep the test short.
  const pool2 = createPool(config.db);
  const srv2 = await startServer(createApp({ config, pool: pool2, authLimits: { ...LIMITS, usernameFailures: 10 } }));
  const at = (ip) => new Browser(srv2.url, { ip });
  try {
    await addUser('spoofed.user', 'spoofed password 1');
    for (let n = 0; n < 2; n++) {
      const ip = nextIp(); // e.g. a spoofed X-Forwarded-For per batch
      for (let i = 0; i < 5; i++) await at(ip).login('spoofed.user', 'nope');
    }
    const fresh = await at(nextIp()).login('spoofed.user', 'spoofed password 1');
    assert.equal(fresh.status, 429);
    assert.match(await fresh.text(), new RegExp(MSG.locked));
    // An unknown username behaves exactly the same.
    for (let n = 0; n < 2; n++) {
      const ip = nextIp();
      for (let i = 0; i < 5; i++) await at(ip).login('spoofed.ghost', 'nope');
    }
    const ghost = await at(nextIp()).login('spoofed.ghost', 'whatever');
    assert.equal(ghost.status, 429);
    assert.match(await ghost.text(), new RegExp(MSG.locked));
  } finally {
    await srv2.close();
    await pool2.end();
  }
});

test('R2: with the default cap, 20 failures from 4 IPs do not lock the username', async (t) => {
  captureLogs(t);
  await addUser('not.capped', 'not capped password');
  for (let n = 0; n < 4; n++) {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) await browser({ ip }).login('not.capped', 'nope');
  }
  assert.equal((await browser().login('not.capped', 'not capped password')).status, 302);
});

test('Q5: login with a password over 72 bytes → generic 401, counted, no bcrypt', async (t) => {
  captureLogs(t);
  await addUser('long.login', 'long login pass 1');
  const calls = spyCompare(t);
  const ip = nextIp();
  const res = await browser({ ip }).login('long.login', 'ก'.repeat(25)); // 75 bytes
  assert.equal(res.status, 401);
  assert.match(await res.text(), new RegExp(MSG.badLogin));
  assert.equal(calls.length, 0);
  assert.equal((await throttleRow(ip, 'long.login')).failures, 1);
});

test('Q5: change password refuses > 72 bytes in Thai; exactly 72 bytes works; huge forms get a Thai error, not 413', async (t) => {
  captureLogs(t);
  await addUser('long.change', 'long change pass 1');
  const b = await loggedIn('long.change', 'long change pass 1');
  const change = (next) => b.post('/admin/password',
    { current_password: 'long change pass 1', new_password: next, confirm_password: next });

  const thai = await change('ก'.repeat(25)); // 25 characters, 75 bytes
  assert.equal(thai.status, 400);
  assert.ok((await thai.text()).includes(MSG.tooLong));

  const huge = await change('x'.repeat(20_000));
  assert.equal(huge.status, 400);
  const hugeHtml = await huge.text();
  assert.ok(hugeHtml.includes(MSG.formTooLarge));
  assert.match(hugeHtml, /<html lang="th">/);

  const ok = await change('a'.repeat(72));
  assert.equal(ok.status, 302);
  assert.equal((await browser().login('long.change', 'a'.repeat(72))).status, 302);

  // Oversized login form: Thai form error (400), not a password check, not counted.
  const ip = nextIp();
  const hugeLogin = await browser({ ip }).post('/admin/login', { username: 'long.change', password: 'y'.repeat(20_000) });
  assert.equal(hugeLogin.status, 400);
  const hugeLoginHtml = await hugeLogin.text();
  assert.ok(hugeLoginHtml.includes(MSG.formTooLarge));
  assert.match(hugeLoginHtml, /<form method="post" action="\/admin\/login">/);
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM login_throttle WHERE ip = ?', [ip]);
  assert.equal(Number(n), 0, 'not counted toward the throttle');
});

test('Q4: PUBLIC_ORIGIN=https://… — Secure cookie without X-Forwarded-Proto; CSRF compares with PUBLIC_ORIGIN', async (t) => {
  const logs = captureLogs(t);
  await addUser('public.origin', 'public origin pass');
  const publicConfig = {
    ...config,
    publicOrigin: 'https://wjasmin.example',
    session: { ...config.session, cookieSecure: true },
  };
  const pool2 = createPool(config.db);
  const srv2 = await startServer(createApp({ config: publicConfig, pool: pool2, authLimits: LIMITS }));
  try {
    const form = { username: 'public.origin', password: 'public origin pass' };
    // The request's own origin no longer counts: only PUBLIC_ORIGIN does.
    assert.equal((await new Browser(srv2.url, { ip: nextIp() }).post('/admin/login', form)).status, 403);
    assert.equal((await new Browser(srv2.url, { ip: nextIp() })
      .post('/admin/login', form, { origin: 'https://evil.example' })).status, 403);

    const b = new Browser(srv2.url, { ip: nextIp() });
    const res = await b.post('/admin/login', form, { origin: 'https://wjasmin.example' }); // no X-Forwarded-Proto
    assert.equal(res.status, 302);
    assert.match(b.setCookies.find((c) => c.startsWith('lx.sid=')), /; Secure/i);
    assert.equal((await b.get('/admin')).status, 200);
    assert.ok(logs.some((l) => /^\[auth\] login ok ip=203\.0\.113\.\d+ proto=https secure=true$/.test(l)), logs.join('\n'));

    const viaReferer = new Browser(srv2.url, { ip: nextIp() });
    const r2 = await viaReferer.post('/admin/login', form,
      { origin: null, headers: { referer: 'https://wjasmin.example/admin/login' } });
    assert.equal(r2.status, 302);
  } finally {
    await srv2.close();
    await pool2.end();
  }
});

test('Q4: without PUBLIC_ORIGIN, a Secure cookie needs X-Forwarded-Proto (documents the failure mode)', async (t) => {
  captureLogs(t);
  await addUser('no.public', 'no public origin 1');
  const pool2 = createPool(config.db);
  const srv2 = await startServer(createApp({
    config: { ...config, session: { ...config.session, cookieSecure: true } }, pool: pool2, authLimits: LIMITS,
  }));
  try {
    const b = new Browser(srv2.url, { ip: nextIp() });
    const res = await b.login('no.public', 'no public origin 1');
    assert.equal(res.status, 302);
    assert.equal(b.cookie, null, 'login "does not stick": no cookie over plain http');
  } finally {
    await srv2.close();
    await pool2.end();
  }
});

test('success is logged with ip, proto and secure', async (t) => {
  const logs = captureLogs(t);
  await addUser('log.ok', 'log ok password 1');
  await loggedIn('log.ok', 'log ok password 1');
  assert.ok(logs.some((l) => /^\[auth\] login ok ip=203\.0\.113\.\d+ proto=http secure=false$/.test(l)), logs.join('\n'));
});

test('Q3: database lock errors in the throttle answer 429 "try again", never 500', async (t) => {
  captureLogs(t);
  await addUser('deadlock.user', 'deadlock password');
  // Pool whose transactions always hit a deadlock on the throttle insert.
  const flaky = {
    query: (...a) => pool.query(...a),
    on() {},
    async getConnection() {
      const c = await pool.getConnection();
      return new Proxy(c, {
        get(target, prop) {
          if (prop === 'query') {
            return async (sql, ...rest) => {
              if (/INSERT INTO login_throttle/.test(sql)) {
                throw Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });
              }
              return target.query(sql, ...rest);
            };
          }
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
  const srv2 = await startServer(createApp({ config, pool: flaky, authLimits: LIMITS }));
  try {
    const res = await new Browser(srv2.url, { ip: nextIp() }).login('deadlock.user', 'deadlock password');
    assert.equal(res.status, 429);
    assert.ok((await res.text()).includes(MSG.busy));
  } finally {
    await srv2.close();
  }
});
