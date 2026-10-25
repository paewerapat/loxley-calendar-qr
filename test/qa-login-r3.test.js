// QA (task 03, rounds 2–3): independent verification of the login throttle with the
// in-memory guards (per-IP limit, bcrypt semaphore) lifted so they cannot mask the
// DB throttle, plus the default in-memory limits, PUBLIC_ORIGIN, and the 72-byte
// password limit. In-process app (createApp) on the local test DB. Bursts stay
// small (<= 20 parallel requests). Holds the shared DB test lock.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { createPool, connectionOptions } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/passwords.js';
import { MSG, DEFAULT_AUTH_LIMITS } from '../src/admin-routes.js';
import {
  assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, startServer, Browser, makeTempStorage,
} from './helpers.js';

const config = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(config.db.database);

// In-memory guards out of the way; DB throttle keeps its real defaults (5 / 100).
const RAISED = { ipPerMinute: 100_000, maxConcurrentChecks: 100 };

let conn;
let pool;
let srv; // RAISED limits, default DB throttle
let storageDir;
const servers = [];

// Every response status seen by this file, and every password it ever sent.
const statuses = [];
const passwordsUsed = new Set();
// Everything the app logged (console is captured for the whole file).
const logs = [];
// bcrypt.compare calls, by hash (src/passwords.js calls compare on this object).
const compareCalls = [];

class QaBrowser extends Browser {
  async request(p, opts = {}) {
    for (const k of ['password', 'current_password', 'new_password', 'confirm_password']) {
      if (opts.form?.[k]) passwordsUsed.add(opts.form[k]);
    }
    const res = await super.request(p, opts);
    statuses.push({ status: res.status, path: p });
    return res;
  }
}

let ipSeq = 0;
const freshIp = () => `198.51.100.${++ipSeq}`;
const at = (server, ip = freshIp()) => new QaBrowser(server.url, { ip });

before(async () => {
  for (const m of ['log', 'warn', 'error', 'info']) {
    mock.method(console, m, (...args) => { logs.push(args.map(String).join(' ')); });
  }
  const original = bcrypt.compare;
  mock.method(bcrypt, 'compare', function (password, hash, ...rest) {
    compareCalls.push(hash);
    return original.call(this, password, hash, ...rest);
  });

  conn = await mysql.createConnection(connectionOptions(config.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(config.db);
  pool = createPool(config.db);
  srv = await startServer(createApp({ config, pool, authLimits: RAISED }));
  servers.push(srv);
  storageDir = await makeTempStorage();
});

after(async () => {
  for (const s of servers) await s.close();
  await pool?.end();
  await conn?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
  mock.restoreAll();
});

async function extraServer(cfg, authLimits) {
  const s = await startServer(createApp({ config: cfg, pool, authLimits }));
  servers.push(s);
  return s;
}

async function addUser(username, password, { cost = 12 } = {}) {
  passwordsUsed.add(password);
  const hash = cost === 12 ? await hashPassword(password) : bcrypt.hashSync(password, cost);
  await conn.query(
    'INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    [username, hash, new Date(Date.now() - 1000)],
  );
  return hash;
}

const throttleRow = async (ip, username) => (await conn.query(
  'SELECT failures, locked_until FROM login_throttle WHERE ip = ? AND username = ?', [ip, username],
))[0][0];
const throttleRowsFor = async (username) => (await conn.query(
  'SELECT ip, failures, locked_until FROM login_throttle WHERE username = ? ORDER BY ip', [username],
))[0];
const countBy = (arr, v) => arr.filter((x) => x === v).length;
const comparesSince = (start, hash) => compareCalls.slice(start).filter((h) => h === hash).length;

// ------------------------------------------------------------------ 1. one IP + username

test('1a: 20 parallel wrong passwords (one IP+username) evaluate at most 5; failures never exceed 5', { timeout: 60000 }, async (t) => {
  const user = 'qa3.burst';
  const hash = await addUser(user, 'Correct-Horse-qa3-burst');
  const ip = freshIp();
  const start = compareCalls.length;
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => at(srv, ip).login(user, `qa3-wrong-a-${i}`)));
  const codes = res.map((r) => r.status);

  assert.ok(!codes.includes(302) && !codes.includes(500), codes.join(','));
  assert.ok(countBy(codes, 401) <= 5, `401 count ${countBy(codes, 401)}: ${codes.join(',')}`);
  assert.equal(countBy(codes, 401) + countBy(codes, 429), 20, codes.join(','));
  const evaluated = comparesSince(start, hash);
  assert.ok(evaluated <= 5, `bcrypt evaluated ${evaluated} passwords`);
  assert.ok(evaluated >= 1, 'the bcrypt spy sees the app (otherwise the "0 compares" checks below are vacuous)');
  t.diagnostic(`evaluated ${evaluated}; codes ${codes.join(',')}`);
  const row = await throttleRow(ip, user);
  assert.ok(row, 'throttle row exists');
  assert.ok(row.failures <= 5, `failures = ${row.failures}`);
  assert.ok(row.locked_until && row.locked_until > new Date(), 'key locked');
  for (const r of res.filter((x) => x.status === 429)) assert.ok((await r.text()).includes(MSG.locked));
});

test('1b: 19 wrong + the correct password last, in parallel (3 rounds): never logs in, key stays locked', { timeout: 90000 }, async (t) => {
  const user = 'qa3.race';
  const password = 'Correct-Horse-qa3-race';
  const hash = await addUser(user, password);
  for (let round = 0; round < 3; round++) {
    const ip = freshIp();
    const start = compareCalls.length;
    const wrong = Array.from({ length: 19 }, (_, i) => at(srv, ip).login(user, `qa3-wrong-b${round}-${i}`));
    const rightB = at(srv, ip);
    const right = rightB.login(user, password);
    const [rightRes, ...wrongRes] = await Promise.all([right, ...wrong]); // right was sent last
    const codes = wrongRes.map((r) => r.status);
    t.diagnostic(`round ${round}: right=${rightRes.status} evaluated=${comparesSince(start, hash)} wrong=${codes.join(',')}`);
    assert.notEqual(rightRes.status, 302, `round ${round}: logged in during a locked burst (${codes.join(',')})`);
    assert.equal(rightRes.status, 429, `round ${round}`);
    assert.equal(rightB.cookie, null, 'no session cookie');
    assert.ok(!codes.includes(500) && !codes.includes(302), codes.join(','));
    assert.ok(countBy(codes, 401) <= 5, codes.join(','));
    assert.ok(comparesSince(start, hash) <= 5, `round ${round}: bcrypt ran ${comparesSince(start, hash)} times`);
    const row = await throttleRow(ip, user);
    assert.ok(row, `round ${round}: throttle row survived`);
    assert.ok(row.failures <= 5, `round ${round}: failures = ${row.failures}`);
    assert.ok(row.locked_until > new Date(), `round ${round}: locked`);

    // Still locked afterwards, even with the right password, sent alone.
    const again = await at(srv, ip).login(user, password);
    assert.equal(again.status, 429);
    assert.ok((await again.text()).includes(MSG.locked));
  }
  // The lock is per IP + username: a fresh IP logs in, and that success does not
  // clear the locked keys of the other IPs.
  const lockedBefore = (await throttleRowsFor(user)).filter((r) => r.locked_until > new Date()).length;
  const ok = at(srv);
  assert.equal((await ok.login(user, password)).status, 302);
  assert.ok(ok.cookie);
  const lockedAfter = (await throttleRowsFor(user)).filter((r) => r.locked_until > new Date()).length;
  assert.equal(lockedAfter, lockedBefore);
});

test('1c: 20 parallel wrong current passwords on /admin/password evaluate at most 5', { timeout: 60000 }, async () => {
  const user = 'qa3.chg';
  const password = 'Correct-Horse-qa3-chg';
  const hash = await addUser(user, password);
  const ip = freshIp();
  const b = at(srv, ip);
  assert.equal((await b.login(user, password)).status, 302);
  const start = compareCalls.length;
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => b.post('/admin/password', {
    current_password: `qa3-wrong-c-${i}`, new_password: 'qa3 new password 1', confirm_password: 'qa3 new password 1',
  })));
  const codes = res.map((r) => r.status);
  assert.ok(!codes.includes(500) && !codes.includes(302), codes.join(','));
  assert.ok(countBy(codes, 400) <= 5, codes.join(','));
  assert.ok(comparesSince(start, hash) <= 5, `bcrypt ran ${comparesSince(start, hash)} times`);
  const row = await throttleRow(ip, user);
  assert.ok(row && row.failures <= 5 && row.locked_until > new Date(), JSON.stringify(row));
  const [[u]] = await conn.query('SELECT password_hash FROM admin_users WHERE username = ?', [user]);
  assert.equal(u.password_hash, hash, 'password unchanged');
});

// ------------------------------------------------------------------ 2. one username, several IPs

test('2a: default cap (100): 4 IPs x burst of 10 → each key capped at 5, username not locked', { timeout: 60000 }, async () => {
  assert.equal(DEFAULT_AUTH_LIMITS.usernameFailures, 100);
  const user = 'qa3.spread';
  const password = 'Correct-Horse-qa3-spread';
  await addUser(user, password, { cost: 4 });
  for (let n = 0; n < 4; n++) {
    const ip = freshIp();
    const codes = (await Promise.all(Array.from({ length: 10 }, (_, i) => at(srv, ip).login(user, `qa3-wrong-d${n}-${i}`))))
      .map((r) => r.status);
    assert.ok(!codes.includes(500) && !codes.includes(302), codes.join(','));
    assert.ok(countBy(codes, 401) <= 5, codes.join(','));
  }
  const rows = await throttleRowsFor(user);
  assert.equal(rows.length, 4);
  for (const r of rows) assert.ok(r.failures <= 5, `${r.ip}: ${r.failures}`);
  const ok = at(srv);
  assert.equal((await ok.login(user, password)).status, 302, 'correct password from a fresh IP works');
  assert.ok(ok.cookie);
});

test('2b: usernameFailures=10: bursts from several IPs lock the username from a fresh IP; real and unknown usernames look the same', { timeout: 60000 }, async () => {
  const s = await extraServer(config, { ...RAISED, usernameFailures: 10 });
  const real = 'qa3.capped';
  const ghost = 'qa3.ghost';
  const password = 'Correct-Horse-qa3-capped';
  await addUser(real, password, { cost: 4 });

  const bodies = {};
  for (const user of [real, ghost]) {
    for (let n = 0; n < 4; n++) {
      const ip = freshIp();
      const codes = (await Promise.all(Array.from({ length: 10 }, (_, i) => at(s, ip).login(user, `qa3-wrong-e${n}-${i}`))))
        .map((r) => r.status);
      assert.ok(!codes.includes(500) && !codes.includes(302), `${user}: ${codes.join(',')}`);
    }
    const rows = await throttleRowsFor(user);
    for (const r of rows) assert.ok(r.failures <= 5, `${user} ${r.ip}: ${r.failures}`);
    const total = rows.reduce((a, r) => a + r.failures, 0);
    assert.ok(total <= 10, `${user}: ${total} passwords reserved across IPs (cap 10)`);

    const fresh = await at(s).login(user, user === real ? password : 'whatever-qa3');
    assert.equal(fresh.status, 429, user);
    bodies[user] = (await fresh.text()).replaceAll(user, 'USER');
    assert.ok(bodies[user].includes(MSG.locked), user);
  }
  assert.equal(bodies[real], bodies[ghost], 'locked page identical for real and unknown usernames');
});

test('2c: usernameFailures=10, IPs bursting at the same time (4 IPs x 5 = 20 parallel): per-key cap holds, username ends locked', { timeout: 60000 }, async (t) => {
  const s = await extraServer(config, { ...RAISED, usernameFailures: 10 });
  const user = 'qa3.parallel';
  const password = 'Correct-Horse-qa3-parallel';
  await addUser(user, password, { cost: 4 });
  const ips = [freshIp(), freshIp(), freshIp(), freshIp()];
  const codes = (await Promise.all(ips.flatMap((ip, n) => Array.from({ length: 5 },
    (_, i) => at(s, ip).login(user, `qa3-wrong-f${n}-${i}`))))).map((r) => r.status);
  assert.ok(!codes.includes(500) && !codes.includes(302), codes.join(','));
  const rows = await throttleRowsFor(user);
  for (const r of rows) assert.ok(r.failures <= 5, `${r.ip}: ${r.failures}`);
  const total = rows.reduce((a, r) => a + r.failures, 0);
  t.diagnostic(`username-wide reservations with 4 IPs in parallel: ${total} (cap 10); codes ${codes.join(',')}`);
  const fresh = await at(s).login(user, password);
  assert.equal(fresh.status, 429, 'username locked from a fresh IP');
});

// ------------------------------------------------------------------ 3. default in-memory limits

test('3: default limits: 11th login POST/min from one IP → 429 Thai busy page, not counted; another IP unaffected', { timeout: 60000 }, async () => {
  assert.equal(DEFAULT_AUTH_LIMITS.ipPerMinute, 10);
  const s = await extraServer(config, undefined);
  const user = 'qa3.limited';
  const password = 'Correct-Horse-qa3-limited';
  await addUser(user, password, { cost: 4 });
  const ip = freshIp();
  for (let i = 0; i < 10; i++) {
    const r = await at(s, ip).login(`qa3.rl${i}`, `qa3-wrong-g-${i}`);
    assert.equal(r.status, 401, `request ${i + 1}`);
  }
  const over = await at(s, ip).login('qa3.rl-over', 'qa3-wrong-g-over');
  assert.equal(over.status, 429);
  const html = await over.text();
  assert.match(html, /<html lang="th">/);
  assert.ok(html.includes(MSG.busy));
  assert.ok(!html.includes(MSG.badLogin) && !html.includes(MSG.locked));
  assert.equal(await throttleRow(ip, 'qa3.rl-over'), undefined, 'busy request not counted');

  // Even the right password is turned away (before any check) and not counted.
  const start = compareCalls.length;
  const rightB = at(s, ip);
  const right = await rightB.login(user, password);
  assert.equal(right.status, 429);
  assert.ok((await right.text()).includes(MSG.busy));
  assert.equal(rightB.cookie, null);
  assert.equal(compareCalls.length - start, 0, 'no bcrypt work for a rate-limited request');
  assert.equal(await throttleRow(ip, user), undefined);
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM login_throttle WHERE ip = ?', [ip]);
  assert.equal(Number(n), 10, 'only the 10 allowed attempts were counted');

  // Another IP is unaffected.
  const other = at(s);
  assert.equal((await other.login('qa3.rl-other', 'qa3-wrong-g-other')).status, 401);
  assert.equal((await other.login(user, password)).status, 302);
});

// ------------------------------------------------------------------ 4. PUBLIC_ORIGIN

function prodConfig(extra) {
  return loadConfig({
    ...process.env, PORT: '0', NODE_ENV: 'production', COOKIE_SECURE: '', STORAGE_DIR: storageDir, ...extra,
  });
}

test('4a: PUBLIC_ORIGIN=https://wjasmin.example, production, COOKIE_SECURE unset', { timeout: 60000 }, async () => {
  const cfg = prodConfig({ PUBLIC_ORIGIN: 'https://wjasmin.example' });
  assert.equal(cfg.session.cookieSecure, true);
  assert.equal(cfg.publicOrigin, 'https://wjasmin.example');
  const s = await extraServer(cfg, RAISED);
  const user = 'qa3.public';
  const password = 'Correct-Horse-qa3-public';
  await addUser(user, password, { cost: 4 });
  const form = { username: user, password };

  const logStart = logs.length;
  const b = at(s);
  const res = await b.post('/admin/login', form, { origin: 'https://wjasmin.example' }); // no X-Forwarded-Proto
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin');
  const sid = b.setCookies.find((c) => c.startsWith('lx.sid='));
  assert.ok(sid, 'lx.sid set');
  assert.match(sid, /;\s*Secure/i);
  assert.match(sid, /;\s*HttpOnly/i);
  assert.match(sid, /;\s*SameSite=Lax/i);
  assert.ok(logs.slice(logStart).some((l) => /\[auth\] login ok .*proto=https secure=true/.test(l)), logs.slice(logStart).join('\n'));

  // Replay the cookie.
  const home = await b.get('/admin');
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes(user));
  assert.equal((await b.get('/api/admin/anything')).status, 404, 'authenticated API (no endpoints yet)');
  const cookie = b.cookie;
  const out = await b.post('/admin/logout', {}, { origin: 'https://wjasmin.example' });
  assert.equal(out.status, 302);
  const replay = new QaBrowser(s.url, { ip: freshIp() });
  replay.cookie = cookie;
  assert.equal((await replay.get('/admin')).status, 302, 'old cookie dead after logout');

  // Every other origin is refused, before any password check.
  const start = compareCalls.length;
  for (const origin of [s.url, 'https://evil.example', 'https://www.wjasmin.example', 'http://wjasmin.example',
    'https://wjasmin.example.evil.test', 'null']) {
    const ip = freshIp();
    const bad = at(s, ip);
    const r = await bad.post('/admin/login', form, { origin });
    assert.equal(r.status, 403, origin);
    assert.equal(bad.cookie, null, origin);
    assert.equal(await throttleRow(ip, user), undefined, `${origin}: not counted`);
  }
  // Referer fallback with the wrong scheme / host.
  for (const referer of [`${s.url}/admin/login`, 'https://www.wjasmin.example/admin/login']) {
    const r = await at(s).post('/admin/login', form, { origin: null, headers: { referer } });
    assert.equal(r.status, 403, referer);
  }
  assert.equal(compareCalls.length - start, 0);
});

test('4b: without PUBLIC_ORIGIN (production, COOKIE_SECURE unset) the previous behaviour holds', { timeout: 60000 }, async () => {
  const cfg = prodConfig({ PUBLIC_ORIGIN: '' });
  assert.equal(cfg.publicOrigin, null);
  assert.equal(cfg.session.cookieSecure, true);
  const s = await extraServer(cfg, RAISED);
  const user = 'qa3.nopublic';
  const password = 'Correct-Horse-qa3-nopublic';
  await addUser(user, password, { cost: 4 });
  const form = { username: user, password };
  const httpsOwn = s.url.replace('http://', 'https://');

  assert.equal((await at(s).post('/admin/login', form, { origin: 'https://wjasmin.example' })).status, 403);
  assert.equal((await at(s).post('/admin/login', form, {
    origin: 'https://wjasmin.example', headers: { 'x-forwarded-proto': 'https' },
  })).status, 403);

  // Proxy says https, Origin matches the request's own https origin: Secure cookie.
  const b = at(s);
  const res = await b.post('/admin/login', form, { origin: httpsOwn, headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(res.status, 302);
  assert.match(b.setCookies.find((c) => c.startsWith('lx.sid=')) ?? '', /;\s*Secure/i);
  assert.equal((await b.get('/admin', { headers: { 'x-forwarded-proto': 'https' } })).status, 200);

  // No X-Forwarded-Proto: own http origin passes CSRF but the Secure cookie is not sent.
  const plain = at(s);
  const r2 = await plain.post('/admin/login', form);
  assert.equal(r2.status, 302);
  assert.equal(plain.cookie, null);
});

// ------------------------------------------------------------------ 5. 72-byte limit

test('5a: login: exactly 72 bytes works; 73 bytes (72 correct + 1) → generic 401, counted, no bcrypt', { timeout: 60000 }, async () => {
  const user = 'qa3.long';
  const password = `qa3-${'x'.repeat(68)}`;
  assert.equal(Buffer.byteLength(password), 72);
  await addUser(user, password, { cost: 4 });
  assert.equal((await at(srv).login(user, password)).status, 302);

  const ip = freshIp();
  const start = compareCalls.length;
  const longer = `${password}Z`;
  passwordsUsed.add(longer);
  const r = await at(srv, ip).login(user, longer);
  assert.equal(r.status, 401, 'bcrypt truncation is not usable');
  assert.ok((await r.text()).includes(MSG.badLogin));
  assert.equal(compareCalls.length - start, 0);
  assert.equal((await throttleRow(ip, user))?.failures, 1);

  // 25 Thai characters (75 bytes) for an unknown user: same generic answer.
  const ip2 = freshIp();
  const r2 = await at(srv, ip2).login('qa3.nobody', 'ก'.repeat(25));
  assert.equal(r2.status, 401);
  assert.ok((await r2.text()).includes(MSG.badLogin));
  assert.equal((await throttleRow(ip2, 'qa3.nobody'))?.failures, 1);
});

test('5b: Thai passwords: 24 chars (72 bytes) log in; change to 25 Thai chars → 400 Thai message; change to 24 works', { timeout: 60000 }, async () => {
  const user = 'qa3.thai';
  const password = 'กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธ';
  assert.equal([...password].length, 24);
  assert.equal(Buffer.byteLength(password), 72);
  await addUser(user, password, { cost: 4 });
  const b = at(srv);
  assert.equal((await b.login(user, password)).status, 302);

  const tooLong = 'ภ'.repeat(25);
  const r = await b.post('/admin/password', { current_password: password, new_password: tooLong, confirm_password: tooLong });
  assert.equal(r.status, 400);
  const html = await r.text();
  assert.ok(html.includes(MSG.tooLong), 'Thai too-long message');
  assert.match(html, /<html lang="th">/);

  const next = 'นบปผฝพฟภมยรลวศษสหฬอฮกขคง';
  assert.equal(Buffer.byteLength(next), 72);
  const ok = await b.post('/admin/password', { current_password: password, new_password: next, confirm_password: next });
  assert.equal(ok.status, 302);
  assert.equal((await b.get('/admin')).status, 200, 'this browser stays logged in');
  assert.equal((await at(srv).login(user, next)).status, 302);
  assert.equal((await at(srv).login(user, password)).status, 401, 'old password gone');
});

test('5c: oversized login form (~20 KB) → 400 Thai message, no throttle row, no login even with the right password', { timeout: 60000 }, async () => {
  const user = 'qa3.bigform';
  const password = 'Correct-Horse-qa3-bigform';
  await addUser(user, password, { cost: 4 });
  const ip = freshIp();
  const start = compareCalls.length;
  for (const form of [
    { username: user, password: 'p'.repeat(20_000) },
    { username: user, password, pad: 'x'.repeat(20_000) },
  ]) {
    const b = at(srv, ip);
    const r = await b.post('/admin/login', form);
    assert.equal(r.status, 400);
    const html = await r.text();
    assert.ok(html.includes(MSG.formTooLarge));
    assert.match(html, /<html lang="th">/);
    assert.equal(b.cookie, null);
  }
  assert.equal(compareCalls.length - start, 0);
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM login_throttle WHERE ip = ?', [ip]);
  assert.equal(Number(n), 0);
});

// ------------------------------------------------------------------ 6. no 500s, no passwords in logs

test('6: no response in this file was a 500, and the app never logged a password', () => {
  assert.ok(statuses.length > 200, `requests made: ${statuses.length}`);
  const fivehundreds = statuses.filter((s) => s.status >= 500);
  assert.deepEqual(fivehundreds, []);
  assert.ok(logs.some((l) => l.startsWith('[auth] login failed ip=')), 'failures are logged');
  const text = logs.join('\n');
  assert.doesNotMatch(text, /\[error\]|ER_LOCK|TypeError/);
  for (const p of passwordsUsed) {
    if (p.length < 6) continue;
    assert.ok(!text.includes(p.slice(0, 60)), `a password appears in the app log: ${p.slice(0, 12)}…`);
  }
  assert.doesNotMatch(text, /\$2[aby]\$\d\d\$/, 'no bcrypt hash in the log');
});
