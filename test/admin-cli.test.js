// Task 03 AC11/AC12: `npm run admin:*` against the real test database.
// Holds the shared DB test lock.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { loadConfig, APP_ROOT } from '../src/config.js';
import { createPool, connectionOptions } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { USERNAME_RE } from '../src/admin-users.js';
import {
  assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, startServer, runNode, Browser,
} from './helpers.js';

const SCRIPT = path.join(APP_ROOT, 'scripts', 'admin.js');
const config = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(config.db.database);

// The CLI needs DB_* only: run it without SESSION_SECRET, STORAGE_DIR or PORT.
function cliEnv() {
  const env = { PATH: process.env.PATH };
  for (const k of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USERNAME', 'DB_PASSWORD', 'NODE_ENV']) env[k] = process.env[k];
  return env;
}
const admin = (...args) => runNode(SCRIPT, { env: cliEnv(), args, timeoutMs: 30000 });
const passwordFrom = (stdout) => stdout.match(/รหัสผ่าน \(แสดงครั้งเดียว[^)]*\): (\S+)/)?.[1];

let conn;
let pool;
let srv;

before(async () => {
  conn = await mysql.createConnection(connectionOptions(config.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(config.db);
  pool = createPool(config.db);
  srv = await startServer(createApp({ config, pool }));
});

after(async () => {
  await srv?.close();
  await pool?.end();
  await conn?.end();
});

const userRow = async (u) => (await conn.query('SELECT * FROM admin_users WHERE username = ?', [u]))[0][0];

test('admin:create prints a strong random password once and stores a cost-12 hash', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const res = await admin('create', 'Client.Owner');
  assert.equal(res.code, 0, res.stderr);
  const password = passwordFrom(res.stdout);
  assert.ok(password, res.stdout);
  assert.ok(password.length >= 16);
  assert.match(password, /^[A-Za-z0-9]+$/);
  assert.equal(res.stdout.split(password).length - 1, 1, 'printed exactly once');
  const row = await userRow('client.owner'); // stored lowercased
  assert.ok(row);
  assert.match(row.password_hash, /^\$2[ab]\$12\$/);
  assert.ok(!res.stdout.includes(row.password_hash) && !res.stdout.includes('$2'), 'hash never printed');
  assert.ok(await bcrypt.compare(password, row.password_hash));
  // The printed password works on the login page.
  const b = new Browser(srv.url, { ip: '198.51.100.1' });
  assert.equal((await b.login('client.owner', password)).status, 302);
});

test('admin:create: duplicate username → exit 1', async () => {
  assert.equal((await admin('create', 'dup.user')).code, 0);
  const again = await admin('create', 'DUP.user');
  assert.equal(again.code, 1);
  assert.match(again.stderr, /มี username dup\.user อยู่แล้ว/);
  const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM admin_users WHERE username = 'dup.user'");
  assert.equal(Number(n), 1);
});

test('admin:create: invalid usernames → exit 1, nothing stored', async () => {
  for (const bad of ['ab', 'a'.repeat(33), 'has space', 'ไทย', 'semi;colon', '']) {
    const res = await admin('create', bad);
    assert.equal(res.code, 1, bad);
    assert.match(res.stderr, /username ต้องเป็น/);
  }
  assert.ok(USERNAME_RE.test('a.b_c-1'));
  const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM admin_users WHERE username IN ('ab', 'has space')");
  assert.equal(Number(n), 0);
});

test('admin:* refuse a password (or anything) passed as an extra argument', async () => {
  const res = await admin('create', 'argv.user', 'MyPassword123');
  assert.equal(res.code, 1);
  assert.match(res.stderr, /ห้ามใส่รหัสผ่าน/);
  assert.ok(!res.stderr.includes('MyPassword123') && !res.stdout.includes('MyPassword123'));
  assert.equal(await userRow('argv.user'), undefined);
});

test('admin:reset-password: new password once, old password and old sessions stop working, lock cleared', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const created = await admin('create', 'forgetful');
  const oldPassword = passwordFrom(created.stdout);
  const b = new Browser(srv.url, { ip: '198.51.100.2' });
  assert.equal((await b.login('forgetful', oldPassword)).status, 302);
  assert.equal((await b.get('/admin')).status, 200);
  // Locked out from another IP.
  const locked = new Browser(srv.url, { ip: '198.51.100.3' });
  for (let i = 0; i < 5; i++) await locked.login('forgetful', 'wrong');
  assert.equal((await locked.login('forgetful', oldPassword)).status, 429);
  const before = await userRow('forgetful');

  const res = await admin('reset-password', 'Forgetful');
  assert.equal(res.code, 0, res.stderr);
  const newPassword = passwordFrom(res.stdout);
  assert.ok(newPassword && newPassword.length >= 16 && newPassword !== oldPassword);
  assert.match(res.stdout, /session เดิมทั้งหมดถูกออกจากระบบ/);

  const after = await userRow('forgetful');
  assert.ok(after.password_changed_at > before.password_changed_at);
  assert.match(after.password_hash, /^\$2[ab]\$12\$/);
  assert.equal((await b.get('/admin')).status, 302, 'old session logged out');
  assert.equal((await locked.login('forgetful', newPassword)).status, 302, 'lock cleared, new password works');
  assert.equal((await new Browser(srv.url, { ip: '198.51.100.4' }).login('forgetful', oldPassword)).status, 401);
});

test('admin:reset-password: unknown user → exit 1', async () => {
  const res = await admin('reset-password', 'nobody.here');
  assert.equal(res.code, 1);
  assert.match(res.stderr, /ไม่พบ username nobody\.here/);
});

test('admin:list shows username, created_at, last_login_at and never a hash', async () => {
  await admin('create', 'listed.user');
  const res = await admin('list');
  assert.equal(res.code, 0, res.stderr);
  const line = res.stdout.split('\n').find((l) => l.startsWith('listed.user\t'));
  assert.match(line, /^listed\.user\tcreated \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\tlast login -$/);
  assert.match(res.stdout, /^client\.owner\tcreated .* UTC\tlast login \d{4}-.* UTC$/m, 'last login after logging in');
  assert.doesNotMatch(res.stdout, /\$2[aby]\$/);
});

test('unknown command → exit 1 with usage', async () => {
  const res = await admin('delete', 'x');
  assert.equal(res.code, 1);
  assert.match(res.stderr, /create <username>, reset-password <username>, list/);
});

test('created_at / last_login_at are UTC (session time zone)', async () => {
  const row = await userRow('client.owner');
  assert.ok(Math.abs(row.created_at.getTime() - Date.now()) < 5 * 60_000, String(row.created_at));
  assert.ok(Math.abs(row.last_login_at.getTime() - Date.now()) < 5 * 60_000, String(row.last_login_at));
});
