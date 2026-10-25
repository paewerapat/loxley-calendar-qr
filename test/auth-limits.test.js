// Task 03 round 2: the per-process guards with their DEFAULT values, on the real
// app.js running as its own process (like Passenger), plus throttle housekeeping.
// Holds the shared DB test lock.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { connectionOptions, createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { purgeOldThrottleRows } from '../src/throttle.js';
import { DEFAULT_AUTH_LIMITS, MSG } from '../src/admin-routes.js';
import {
  APP_JS, assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, closedPort, makeTempStorage, runNode,
} from './helpers.js';

const config = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(config.db.database);

let conn;
let proc;
let port;
let storageDir;

before(async () => {
  conn = await mysql.createConnection(connectionOptions(config.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(config.db);
  port = await closedPort();
  storageDir = await makeTempStorage();
  proc = await runNode(APP_JS, {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', COOKIE_SECURE: 'false', STORAGE_DIR: storageDir },
    waitFor: /listening on port/,
  });
  assert.ok(proc.match, `app did not start:\n${proc.stderr}`);
});

after(async () => {
  await proc?.kill?.();
  await conn?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

function request(method, path, { ip, form } = {}) {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const headers = { origin: `http://127.0.0.1:${port}` };
  if (ip) headers['x-forwarded-for'] = ip;
  if (body) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({
        status: res.statusCode, text, ms: Number(process.hrtime.bigint() - started) / 1e6,
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const login = (ip, username, password = 'nope') => request('POST', '/admin/login', { ip, form: { username, password } });

test('defaults: 10 password posts per minute per IP, then 429 "try again" (before bcrypt)', async () => {
  assert.equal(DEFAULT_AUTH_LIMITS.ipPerMinute, 10);
  const ip = '192.0.2.10';
  const statuses = [];
  // Different usernames, so the per-IP+username lock never kicks in.
  for (let i = 0; i < 12; i++) statuses.push((await login(ip, `ratelimit.${i}`)).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  const over = await login(ip, 'ratelimit.last');
  assert.equal(over.status, 429);
  assert.ok(over.text.includes(MSG.busy));
  assert.ok(over.text.includes('<html lang="th">'));
  // Another IP is not affected.
  assert.equal((await login('192.0.2.11', 'ratelimit.other')).status, 401);
});

test('a burst of 30 logins (random IPs + usernames) does not stall the public pages', { timeout: 60000 }, async () => {
  assert.equal(DEFAULT_AUTH_LIMITS.maxConcurrentChecks, 2);
  const warm = await request('GET', '/v/m01');
  assert.equal(warm.status, 200);

  const burst = Array.from({ length: 30 }, (_, i) => login(`198.18.${i}.1`, `flood.${i}`));
  // Sample the QR page while the burst is being processed.
  const samples = [];
  for (let i = 0; i < 8; i++) {
    samples.push(await request('GET', '/v/m01'));
    await new Promise((r) => setTimeout(r, 50));
  }
  const results = await Promise.all(burst);

  const statuses = results.map((r) => r.status);
  assert.ok(!statuses.includes(500), statuses.join(','));
  assert.ok(statuses.includes(429), 'excess concurrent checks are turned away');
  assert.ok(results.filter((r) => r.status === 429).every((r) => r.text.includes(MSG.busy)));
  assert.ok(samples.every((s) => s.status === 200));
  const worst = Math.max(...samples.map((s) => s.ms));
  // Unbounded bcrypt work froze this page for ~12 s; with the cap it stays well
  // under a second. 2.5 s leaves room for a busy CI machine.
  assert.ok(worst < 2500, `slowest /v/m01 during the burst: ${Math.round(worst)} ms`);
});

test('throttle housekeeping removes stale rows (runs from the background timer)', async () => {
  await conn.query(
    `INSERT INTO login_throttle (ip, username, failures, first_failed_at, locked_until) VALUES
     ('10.9.9.1', 'old.row', 3, UTC_TIMESTAMP(3) - INTERVAL 2 DAY, NULL),
     ('10.9.9.2', 'old.locked', 5, UTC_TIMESTAMP(3) - INTERVAL 2 DAY, UTC_TIMESTAMP(3) + INTERVAL 5 MINUTE),
     ('10.9.9.3', 'recent.row', 2, UTC_TIMESTAMP(3) - INTERVAL 1 HOUR, NULL)`,
  );
  const pool = createPool(config.db);
  try {
    assert.ok(await purgeOldThrottleRows(pool) >= 1);
  } finally {
    await pool.end();
  }
  const [rows] = await conn.query("SELECT username FROM login_throttle WHERE ip LIKE '10.9.9.%' ORDER BY username");
  assert.deepEqual(rows.map((r) => r.username), ['old.locked', 'recent.row']);
});

test('a throttle row stuck behind another lock answers 429 "try again" within ~15 s (no 500)', { timeout: 30000 }, async () => {
  const ip = '192.0.2.77';
  await conn.query(
    "INSERT INTO login_throttle (ip, username, failures, first_failed_at) VALUES (?, 'stuck.user', 1, UTC_TIMESTAMP(3))",
    [ip],
  );
  const holder = await mysql.createConnection(connectionOptions(config.db));
  try {
    await holder.beginTransaction();
    await holder.query("SELECT * FROM login_throttle WHERE ip = ? AND username = 'stuck.user' FOR UPDATE", [ip]);
    const started = Date.now();
    const res = await login(ip, 'stuck.user');
    const took = Date.now() - started;
    assert.equal(res.status, 429);
    assert.ok(res.text.includes(MSG.busy));
    assert.ok(took >= 4000, `waited on the lock (${took} ms)`);
    assert.ok(took < 16000, `gave up within ~15 s (${took} ms)`);
  } finally {
    await holder.rollback().catch(() => {});
    await holder.end();
  }
});

test('no 500s and no throttle errors were logged by the app process', () => {
  assert.doesNotMatch(proc.stderr, /\[error\]|ER_LOCK|TypeError/);
});
