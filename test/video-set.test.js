// Task 02 AC7 (`npm run video:set`) and the /v + /media flow against the real test
// database (loxley_test) with a temp STORAGE_DIR. Holds the shared DB test lock.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { loadConfig, APP_ROOT } from '../src/config.js';
import { createPool, connectionOptions } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { setVideo, VideoSetError } from '../src/video-set.js';
import { createApp } from '../src/app.js';
import {
  assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, makeTempStorage, fakeMp4Bytes, writeStorageFile, startServer, runNode,
} from './helpers.js';

const SCRIPT = path.join(APP_ROOT, 'scripts', 'video-set.js');
const MB = 1024 * 1024;

const baseConfig = loadConfig(process.env, { requirePort: false });
assertTestDatabase(baseConfig.db.database);

let conn;
let pool;
let storage;

before(async () => {
  conn = await mysql.createConnection(connectionOptions(baseConfig.db));
  await acquireDbSuiteLock(conn);
  pool = createPool(baseConfig.db);
});

beforeEach(async () => {
  await resetTestDatabase(conn);
  await runMigrations(baseConfig.db);
  if (storage) await rm(storage, { recursive: true, force: true });
  storage = await makeTempStorage();
});

after(async () => {
  await pool?.end();
  await conn?.end();
  if (storage) await rm(storage, { recursive: true, force: true });
});

async function row(slug) {
  const [rows] = await conn.query('SELECT * FROM videos WHERE slug = ?', [slug]);
  return rows[0];
}

// Sparse file of `size` bytes starting with an ftyp box (cheap even at 100MB).
async function writeSparseMp4(key, size) {
  const file = path.join(storage, ...key.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  const fh = await open(file, 'w');
  try {
    await fh.write(fakeMp4Bytes(16), 0, 16, 0);
    await fh.truncate(size);
  } finally {
    await fh.close();
  }
}

const cliEnv = () => ({ ...process.env, STORAGE_DIR: storage });

test('sets r2_key, size_bytes, updated_at, updated_by=cli', async () => {
  const key = 'videos/ecard-lee/1792832980.mp4';
  await writeStorageFile(storage, key, fakeMp4Bytes(1234));
  const result = await setVideo({ pool, storageDir: storage, slug: 'ecard-lee', key });
  assert.deepEqual(result, { slug: 'ecard-lee', key, size: 1234, previousKey: null });
  const r = await row('ecard-lee');
  assert.equal(r.r2_key, key);
  assert.equal(Number(r.size_bytes), 1234);
  assert.equal(r.updated_by, 'cli');
  assert.ok(r.updated_at instanceof Date);
  // Written with UTC_TIMESTAMP() and read back with timezone 'Z' → matches now.
  assert.ok(Math.abs(Date.now() - r.updated_at.getTime()) < 5 * 60 * 1000, String(r.updated_at));
});

test('CLI: replacing a video prints the old path and keeps the old file', async () => {
  const oldKey = 'videos/m01/1792832980.mp4';
  const newKey = 'videos/m01/1792839999.mp4';
  await writeStorageFile(storage, oldKey, fakeMp4Bytes(100));
  await writeStorageFile(storage, newKey, fakeMp4Bytes(200));

  const usage = await runNode(SCRIPT, { env: cliEnv() });
  assert.equal(usage.code, 1, 'no args → usage error');
  assert.match(usage.stderr, /วิธีใช้/);

  const set1 = await runNodeArgs([SCRIPT, 'm01', oldKey]);
  assert.equal(set1.code, 0, set1.stderr);
  assert.match(set1.stdout, /m01 → videos\/m01\/1792832980\.mp4 \(100 bytes\)/);
  assert.doesNotMatch(set1.stdout, /ไฟล์เก่า/);

  const set2 = await runNodeArgs([SCRIPT, 'm01', newKey]);
  assert.equal(set2.code, 0, set2.stderr);
  assert.match(set2.stdout, /ไฟล์เก่ายังอยู่ \(ไม่ได้ลบ\): videos\/m01\/1792832980\.mp4/);
  assert.equal((await row('m01')).r2_key, newKey);
  await stat(path.join(storage, 'videos', 'm01', '1792832980.mp4')); // still there
});

// node scripts/video-set.js <args...> with STORAGE_DIR pointing at the temp storage.
function runNodeArgs([script, ...args]) {
  return runNode(script, { env: cliEnv(), args });
}

const FAILURES = [
  ['unknown slug', 'm13', 'videos/m13/1792832980.mp4', /ไม่พบชุด m13/],
  ['bad slug format', 'M01', 'videos/m01/1792832980.mp4', /slug ไม่ถูกรูปแบบ/],
  ['path not matching the pattern', 'm01', 'm01/1792832980.mp4', /videos\/<slug>\/<epoch>\.mp4/],
  ['traversal in path', 'm01', 'videos/m01/../../../etc/passwd', /videos\/<slug>\/<epoch>\.mp4/],
  ['absolute path', 'm01', '/tmp/videos/m01/1792832980.mp4', /videos\/<slug>\/<epoch>\.mp4/],
  ['path of another slug', 'm01', 'videos/m02/1792832980.mp4', /videos\/m01\//],
  ['missing file', 'm01', 'videos/m01/1792800000.mp4', /ไม่พบไฟล์/],
  ['directory instead of file', 'm01', 'videos/m01/1792811111.mp4', /ไม่พบไฟล์/],
  ['not an MP4 (no ftyp)', 'm01', 'videos/m01/1792822222.mp4', /ไม่ใช่ MP4/],
  // Exact bytes for both numbers (no "20.0MB over 20.0MB").
  ['monthly over 20MB', 'm01', 'videos/m01/1792833333.mp4',
    /ใหญ่เกินกำหนด: 20,971,521 bytes \(ชุด monthly รับได้ไม่เกิน 20,971,520 bytes = 20MB\)/],
  ['e-card over 100MB', 'ecard-lee', 'videos/ecard-lee/1792844444.mp4',
    /ใหญ่เกินกำหนด: 104,857,601 bytes \(ชุด ecard รับได้ไม่เกิน 104,857,600 bytes = 100MB\)/],
];

async function prepareFailureFiles() {
  await writeStorageFile(storage, 'videos/m02/1792832980.mp4', fakeMp4Bytes(100));
  await mkdir(path.join(storage, 'videos', 'm01', '1792811111.mp4'), { recursive: true });
  await writeStorageFile(storage, 'videos/m01/1792822222.mp4', Buffer.from('this is not a video at all'));
  await writeSparseMp4('videos/m01/1792833333.mp4', 20 * MB + 1);
  await writeSparseMp4('videos/ecard-lee/1792844444.mp4', 100 * MB + 1);
}

for (const [label, slug, key, message] of FAILURES) {
  test(`rejects ${label} without changing the database`, async () => {
    await prepareFailureFiles();
    const [before] = await conn.query('SELECT * FROM videos ORDER BY slug');
    await assert.rejects(setVideo({ pool, storageDir: storage, slug, key }), (err) => {
      assert.ok(err instanceof VideoSetError, err.stack);
      assert.match(err.message, message);
      return true;
    });
    const [afterRows] = await conn.query('SELECT * FROM videos ORDER BY slug');
    assert.deepEqual(afterRows, before);
  });
}

test('CLI: a failed check exits 1 with the reason', async () => {
  await prepareFailureFiles();
  const res = await runNodeArgs([SCRIPT, 'm01', 'videos/m01/1792833333.mp4']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /ใหญ่เกินกำหนด/);
  assert.equal((await row('m01')).r2_key, null);
});

test('size limits: monthly exactly 20MB and e-card 20MB+1 are accepted', async () => {
  await writeSparseMp4('videos/m01/1792855555.mp4', 20 * MB);
  await writeSparseMp4('videos/ecard-lee/1792866666.mp4', 20 * MB + 1);
  await setVideo({ pool, storageDir: storage, slug: 'm01', key: 'videos/m01/1792855555.mp4' });
  await setVideo({ pool, storageDir: storage, slug: 'ecard-lee', key: 'videos/ecard-lee/1792866666.mp4' });
  assert.equal(Number((await row('m01')).size_bytes), 20 * MB);
  assert.equal(Number((await row('ecard-lee')).size_bytes), 20 * MB + 1);
});

test('end to end with the real DB: video:set → /v/ecard-lee/ plays /media/<key> with Range', async () => {
  const key = 'videos/ecard-lee/1792832980.mp4';
  const bytes = fakeMp4Bytes(3000);
  await writeStorageFile(storage, key, bytes);
  await setVideo({ pool, storageDir: storage, slug: 'ecard-lee', key });

  const config = loadConfig({ ...process.env, STORAGE_DIR: storage, PORT: '0' });
  const appPool = createPool(config.db);
  const srv = await startServer(createApp({ config, pool: appPool }));
  try {
    const page = await fetch(`${srv.url}/v/ecard-lee/`, { redirect: 'manual' });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>e-card ปีใหม่ Lee<\/title>/);
    assert.match(html, new RegExp(`<video[^>]*src="/media/${key}"`));

    const media = await fetch(`${srv.url}/media/${key}`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(media.status, 206);
    assert.equal(media.headers.get('content-range'), 'bytes 0-99/3000');
    assert.ok(Buffer.from(await media.arrayBuffer()).equals(bytes.subarray(0, 100)));

    const soon = await (await fetch(`${srv.url}/v/m01`)).text();
    assert.match(soon, /วีดีโอเดือนนี้จะเปิดให้ชมเร็ว ๆ นี้/);
    assert.doesNotMatch(soon, /<video/);
  } finally {
    await srv.close();
    await appPool.end();
  }
});
