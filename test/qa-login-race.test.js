// QA (task 03, round 1): parallel password guessing must not get past the
// 5-failures lock (AC6). The lock is checked before bcrypt but a failure is only
// recorded after bcrypt, so requests sent together all pass the check, every
// guess is evaluated, and a correct guess inside the burst logs in (and clears
// the counter). The app runs as a separate process (like production) so the
// client is not slowed down by the server's bcrypt work. Holds the DB test lock.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { connectionOptions } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import {
  APP_JS, assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, closedPort, makeTempStorage, runNode,
} from './helpers.js';

const config = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(config.db.database);

const USER = 'qa-race';
const PASSWORD = 'correct-horse-battery';

let conn;
let proc;
let port;
let storageDir;

before(async () => {
  conn = await mysql.createConnection(connectionOptions(config.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(config.db);
  await conn.query(
    'INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    [USER, bcrypt.hashSync(PASSWORD, 12), new Date(Date.now() - 1000)],
  );
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

// Server-side errors ([error] lines) logged by the app process so far.
const serverErrors = () => (proc?.stderr ?? '').split('\n').filter((l) => /\[error\]|Error:|code:/.test(l)).slice(0, 8).join('\n');

// Plain node:http (own socket per request), like a simple attack script.
function attempt(ip, password) {
  const body = new URLSearchParams({ username: USER, password }).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/admin/login',
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        origin: `http://127.0.0.1:${port}`,
        'x-forwarded-for': ip,
      },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

// A success clears the counter (DELETE) while other requests of the same burst are
// between their INSERT IGNORE and SELECT ... FOR UPDATE in recordFailure(): the
// row is gone and the request crashes. Race, so retried a few times.
test('wrong + right passwords sent together never answer 500', { timeout: 120000 }, async () => {
  for (let round = 0; round < 3; round++) {
    const ip = `198.51.100.${20 + round}`;
    const burst = [...Array.from({ length: 19 }, (_, i) => attempt(ip, `nope-${i}`)), attempt(ip, PASSWORD)];
    const statuses = await Promise.all(burst);
    assert.ok(!statuses.includes(500), `round ${round}: statuses ${statuses.join(',')}\nserver log:\n${serverErrors()}`);
  }
});

test('a burst of 19 wrong passwords + the right one from one IP: the right one is refused (AC6)', { timeout: 60000 }, async () => {
  const ip = '198.51.100.7';
  const wrong = Array.from({ length: 19 }, (_, i) => attempt(ip, `wrong-guess-${i}`));
  const right = attempt(ip, PASSWORD); // sent last
  const [rightStatus, ...wrongStatuses] = await Promise.all([right, ...wrong]);

  assert.notEqual(rightStatus, 302,
    `the correct password logged in after 19 wrong guesses sent just before it (wrong: ${wrongStatuses.join(',')})`);
  assert.equal(rightStatus, 429);

  const [[row]] = await conn.query(
    'SELECT failures FROM login_throttle WHERE ip = ? AND username = ?', [ip, USER],
  );
  assert.ok(row, 'throttle row still exists (a login inside the burst must not clear it)');
  assert.equal(await attempt(ip, PASSWORD), 429, 'IP + username still locked after the burst');
});
