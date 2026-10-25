// AC4, AC5, AC6 (DB up), AC2 (real app.js). Runs against the database in .env.test
// (loxley_test). DB test files hold a shared lock so they never run at the same
// time. Every test starts from empty tables (beforeEach) and migrates itself when it
// needs data, so each test passes on its own (--test-name-pattern) and in any order.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { loadConfig, APP_ROOT } from '../src/config.js';
import { createPool, connectionOptions } from '../src/db.js';
import { runMigrations, listMigrationFiles } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, startServer, runNode, APP_JS } from './helpers.js';

const config = loadConfig(process.env);
assertTestDatabase(config.db.database);

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

let conn;

const ALL_MIGRATIONS = ['001_create_videos.sql', '002_seed_videos.sql', '003_create_auth.sql'];

before(async () => {
  conn = await mysql.createConnection(connectionOptions(config.db));
  await acquireDbSuiteLock(conn); // other DB test files run in parallel processes
});

beforeEach(async () => {
  await resetTestDatabase(conn);
});

after(async () => {
  await conn?.end();
});

// Bring the empty database up to date (the state a deployed DB is in).
async function migrated() {
  assert.deepEqual(await runMigrations(config.db), ALL_MIGRATIONS);
}

async function videoRows() {
  const [rows] = await conn.query('SELECT * FROM videos ORDER BY sort_order');
  return rows;
}

test('migrations are numbered .sql files in order', async () => {
  const files = await listMigrationFiles();
  assert.deepEqual(files, ALL_MIGRATIONS);
});

test('first run creates schema_migrations + videos and records every file', async () => {
  const [beforeTables] = await conn.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('videos', 'schema_migrations')",
  );
  assert.equal(beforeTables.length, 0, 'starts from an empty database');
  const applied = await runMigrations(config.db);
  assert.deepEqual(applied, ALL_MIGRATIONS);
  const [rows] = await conn.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((r) => r.version), applied);
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM videos');
  assert.equal(Number(n), 14);
});

test('tables use utf8mb4 / utf8mb4_unicode_ci', async () => {
  await migrated();
  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS name, TABLE_COLLATION AS coll FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('videos', 'schema_migrations') ORDER BY TABLE_NAME`,
  );
  assert.deepEqual(tables.map((t) => [t.name, t.coll]), [
    ['schema_migrations', 'utf8mb4_unicode_ci'],
    ['videos', 'utf8mb4_unicode_ci'],
  ]);
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME AS name, COLLATION_NAME AS coll FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'videos' AND COLLATION_NAME IS NOT NULL`,
  );
  for (const c of cols) assert.equal(c.coll, 'utf8mb4_unicode_ci', c.name);
});

test('seed: 14 rows m01–m12 + ecard-lee + ecard-loxley, files NULL', async () => {
  await migrated();
  const rows = await videoRows();
  assert.equal(rows.length, 14);
  for (let i = 0; i < 12; i++) {
    const r = rows[i];
    assert.equal(r.slug, `m${String(i + 1).padStart(2, '0')}`);
    assert.equal(r.title, `${THAI_MONTHS[i]} 2570`);
    assert.equal(r.kind, 'monthly');
    assert.equal(r.sort_order, i + 1);
  }
  assert.deepEqual(rows.slice(12).map((r) => [r.slug, r.title, r.kind, r.sort_order]), [
    ['ecard-lee', 'e-card ปีใหม่ Lee', 'ecard', 13],
    ['ecard-loxley', 'e-card ปีใหม่ LOXLEY', 'ecard', 14],
  ]);
  for (const r of rows) {
    assert.equal(r.r2_key, null);
    assert.equal(r.poster_key, null);
    assert.equal(r.size_bytes, null);
    assert.equal(r.updated_at, null);
    assert.equal(r.updated_by, null);
  }
});

test('kind is restricted to monthly / ecard', async () => {
  await migrated();
  await assert.rejects(
    conn.query("INSERT INTO videos (slug, title, kind, sort_order) VALUES ('bad', 'x', 'other', 99)"),
  );
});

test('second run applies nothing and changes nothing', async () => {
  await migrated();
  const before14 = await videoRows();
  assert.deepEqual(await runMigrations(config.db), []);
  assert.deepEqual(await videoRows(), before14);
});

test('re-running every migration file (history wiped) does not error, duplicate, or overwrite edits', async () => {
  await migrated();
  await conn.query(
    "UPDATE videos SET title = 'ชื่อที่ลูกค้าแก้', r2_key = 'videos/m01/1.mp4', updated_by = 'client' WHERE slug = 'm01'",
  );
  await conn.query('DELETE FROM schema_migrations');
  assert.deepEqual(await runMigrations(config.db), ALL_MIGRATIONS);
  const rows = await videoRows();
  assert.equal(rows.length, 14);
  assert.equal(rows[0].title, 'ชื่อที่ลูกค้าแก้');
  assert.equal(rows[0].r2_key, 'videos/m01/1.mp4');
  assert.equal(rows[0].updated_by, 'client');
});

test('npm run migrate (scripts/migrate.js) works on an empty DB and is idempotent', async () => {
  const script = path.join(APP_ROOT, 'scripts', 'migrate.js');
  const first = await runNode(script, { env: process.env });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /applied 3 migration\(s\)/);
  const second = await runNode(script, { env: process.env });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /already up to date/);
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM videos');
  assert.equal(Number(n), 14);
});

test('two migrate runs at the same time do not collide', async () => {
  const [a, b] = await Promise.all([runMigrations(config.db), runMigrations(config.db)]);
  assert.equal(a.length + b.length, ALL_MIGRATIONS.length);
  const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM videos');
  assert.equal(Number(n), 14);
});

test('GET /healthz → 200 {"ok":true,"db":true} when the DB is reachable', async () => {
  const pool = createPool(config.db);
  const srv = await startServer(createApp({ config, pool }));
  try {
    const res = await fetch(`${srv.url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, db: true });
  } finally {
    await srv.close();
    await pool.end();
  }
});

test('node app.js listens on process.env.PORT and serves /healthz', async () => {
  const proc = await runNode(APP_JS, {
    env: { ...process.env, PORT: '0' },
    waitFor: /listening on port (\d+)/,
  });
  assert.ok(proc.match, `app.js did not start: ${proc.stderr}`);
  try {
    const res = await fetch(`http://127.0.0.1:${proc.match[1]}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, db: true });
  } finally {
    await proc.kill();
  }
});

// Task 03 AC1: every connection works in UTC ------------------------------------

test('AC1: every pool connection runs SET time_zone = +00:00 (NOW() = UTC_TIMESTAMP())', async () => {
  const pool = createPool(config.db);
  try {
    // Hold several connections at once so several physical connections are opened.
    const conns = await Promise.all([pool.getConnection(), pool.getConnection(), pool.getConnection()]);
    try {
      for (const c of conns) {
        const [[row]] = await c.query(
          'SELECT @@session.time_zone AS tz, @@session.innodb_lock_wait_timeout AS lockWait, TIMESTAMPDIFF(SECOND, NOW(), UTC_TIMESTAMP()) AS diff',
        );
        assert.equal(row.tz, '+00:00');
        assert.equal(Number(row.lockWait), 5, 'row-lock waits give up after 5 s');
        assert.equal(Number(row.diff), 0);
      }
    } finally {
      for (const c of conns) c.release();
    }
    // Plain pool.query goes through the same connections.
    const [[row]] = await pool.query('SELECT @@session.time_zone AS tz');
    assert.equal(row.tz, '+00:00');
  } finally {
    await pool.end();
  }
});

test('AC1: migrations run in UTC; CURRENT_TIMESTAMP defaults read back as the real time', async () => {
  await migrated();
  const [[m]] = await conn.query('SELECT MAX(applied_at) AS at FROM schema_migrations');
  const pool = createPool(config.db);
  try {
    // Column DEFAULT CURRENT_TIMESTAMP written by an app connection.
    await pool.query("INSERT INTO admin_users (username, password_hash) VALUES ('tz.check', 'x')");
    const [[u]] = await pool.query("SELECT created_at, password_changed_at FROM admin_users WHERE username = 'tz.check'");
    // DATETIME values are read with timezone 'Z'; in UTC they match the JS clock.
    for (const d of [m.at, u.created_at, u.password_changed_at]) {
      assert.ok(d instanceof Date);
      assert.ok(Math.abs(d.getTime() - Date.now()) < 2 * 60_000, `${d.toISOString()} vs now`);
    }
  } finally {
    await pool.end();
  }
});

test('AC1: the migration connection itself is UTC', async () => {
  const { createConnection } = await import('../src/db.js');
  const c = await createConnection(config.db);
  try {
    const [[row]] = await c.query('SELECT @@session.time_zone AS tz, @@session.innodb_lock_wait_timeout AS lockWait');
    assert.equal(row.tz, '+00:00');
    assert.equal(Number(row.lockWait), 5);
  } finally {
    await c.end();
  }
});

// Task 03 AC2: auth tables ---------------------------------------------------------

test('AC2: migration 003 creates admin_users, login_throttle and sessions (utf8mb4) and is idempotent', async () => {
  await migrated();
  const [cols] = await conn.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLLATION_NAME AS coll
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('admin_users', 'login_throttle', 'sessions')
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  const byTable = (t) => cols.filter((x) => x.t === t).map((x) => x.c);
  assert.deepEqual(byTable('admin_users'),
    ['id', 'username', 'password_hash', 'created_at', 'last_login_at', 'password_changed_at']);
  assert.deepEqual(byTable('login_throttle'), ['ip', 'username', 'failures', 'first_failed_at', 'locked_until']);
  assert.deepEqual(byTable('sessions'), ['session_id', 'expires', 'data']);
  const col = (t, c) => cols.find((x) => x.t === t && x.c === c);
  assert.equal(col('admin_users', 'last_login_at').nullable, 'YES');
  assert.equal(col('admin_users', 'password_changed_at').type, 'datetime(3)');
  assert.equal(col('admin_users', 'username').coll, 'utf8mb4_unicode_ci');
  assert.equal(col('sessions', 'session_id').coll, 'utf8mb4_bin');

  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS t, TABLE_COLLATION AS coll FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('admin_users', 'login_throttle', 'sessions')`,
  );
  assert.equal(tables.length, 3);
  for (const t of tables) assert.equal(t.coll, 'utf8mb4_unicode_ci', t.t);

  // username is unique (case-insensitive collation)
  await conn.query("INSERT INTO admin_users (username, password_hash) VALUES ('uniq.user', 'x')");
  await assert.rejects(conn.query("INSERT INTO admin_users (username, password_hash) VALUES ('UNIQ.user', 'x')"), /Duplicate/);

  // Re-running every file keeps data and does not fail.
  await conn.query('DELETE FROM schema_migrations');
  assert.deepEqual(await runMigrations(config.db), ALL_MIGRATIONS);
  const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM admin_users WHERE username = 'uniq.user'");
  assert.equal(Number(n), 1);
});
