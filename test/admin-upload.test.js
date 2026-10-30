// Task 04: back-office list, upload/replace, QR downloads — end to end against the
// real test database with a temp STORAGE_DIR and real cookies. Holds the DB lock.
// Fake MP4s are generated here (tiny, or sparse for the oversize cases).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat, utimes, writeFile, chmod } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { loadConfig, APP_ROOT } from '../src/config.js';
import { createPool, connectionOptions } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { contentHash } from '../src/assets.js';
import { SIZE_LIMITS } from '../src/videos.js';
import { cleanupStaleTmp } from '../src/upload.js';
import {
  assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, startServer, Browser, makeTempStorage, fakeMp4Bytes, writeStorageFile,
} from './helpers.js';

const LIMITS = { ipPerMinute: 100_000, maxConcurrentChecks: 100 };
const MIB = 1024 * 1024;
const USER = 'upload.admin';
const PASSWORD = 'upload admin pass';

const baseConfig = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(baseConfig.db.database);

let conn;
let pool;
let storage;
let config;
let srv;
let b; // logged-in browser

before(async () => {
  conn = await mysql.createConnection(connectionOptions(baseConfig.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(baseConfig.db);
  await conn.query(
    'INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    [USER, bcrypt.hashSync(PASSWORD, 4), new Date(Date.now() - 1000)],
  );
  storage = await makeTempStorage();
  config = { ...baseConfig, storageDir: storage };
  pool = createPool(config.db);
  srv = await startServer(createApp({ config, pool, authLimits: LIMITS }));
  b = new Browser(srv.url, { ip: '198.51.100.40' });
  const res = await b.login(USER, PASSWORD);
  assert.equal(res.status, 302);
});

after(async () => {
  await srv?.close();
  await pool?.end();
  await conn?.end();
  if (storage) await rm(storage, { recursive: true, force: true });
});

// Every test starts from sets without videos and an empty storage.
beforeEach(async () => {
  await conn.query('UPDATE videos SET r2_key = NULL, size_bytes = NULL, updated_at = NULL, updated_by = NULL');
  await rm(path.join(storage, 'videos'), { recursive: true, force: true });
  await rm(path.join(storage, 'tmp'), { recursive: true, force: true });
});

const row = async (slug) => (await conn.query('SELECT * FROM videos WHERE slug = ?', [slug]))[0][0];
const mp4 = (size = 2000) => new Blob([fakeMp4Bytes(size)], { type: 'video/mp4' });
const filesIn = async (...parts) => readdir(path.join(storage, ...parts)).catch(() => []);
const upload = (slug, blob, name = 'clip.mp4', opts) => b.upload(`/api/admin/videos/${slug}`, [{ blob, name }], opts);

// Sparse file (cheap on disk) exposed as a lazily-read Blob: oversized uploads.
async function sparseBlob(size, type = 'video/mp4') {
  const dir = path.join(storage, '..', `${path.basename(storage)}-sparse`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${size}.mp4`);
  const fh = await open(file, 'w');
  await fh.write(fakeMp4Bytes(16), 0, 16, 0);
  await fh.truncate(size);
  await fh.close();
  return { blob: await fs.openAsBlob(file, { type }), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function assertNothingStored(slug) {
  assert.deepEqual(await filesIn('tmp'), [], 'no temp file left');
  assert.deepEqual(await filesIn('videos', slug), [], 'nothing moved into videos/');
  assert.equal((await row(slug)).r2_key, null, 'database unchanged');
}

// ---------------------------------------------------------------- AC1 page

test('AC1: /admin lists the 14 sets in sort_order with status, size, links, QR and upload', async () => {
  await writeStorageFile(storage, 'videos/m02/1792832980123.mp4', fakeMp4Bytes(100)); // the file must exist
  await conn.query(
    "UPDATE videos SET r2_key = 'videos/m02/1792832980123.mp4', size_bytes = 7654321, updated_at = '2026-10-25 10:00:00', updated_by = 'client' WHERE slug = 'm02'",
  );
  const res = await b.get('/admin');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /upload\.admin/);
  assert.match(html, /href="\/admin\/password"/);
  assert.match(html, /<form method="post" action="\/admin\/logout">/);

  const slugs = [...html.matchAll(/<li class="video" data-slug="([^"]+)"/g)].map((m) => m[1]);
  const [dbOrder] = await conn.query('SELECT slug FROM videos ORDER BY sort_order');
  assert.deepEqual(slugs, dbOrder.map((r) => r.slug));
  assert.equal(slugs.length, 14);

  const card = (slug) => html.split('<li class="video"').find((c) => c.startsWith(` data-slug="${slug}"`));
  const m01 = card('m01');
  // Task 05: set titles are <h3> under the "วีดีโอรายเดือน" / "e-card" <h2> groups,
  // and the view link reads "ดูวีดีโอ" with an icon in front.
  assert.match(m01, /<h3>มกราคม 2570<\/h3>/);
  assert.match(m01, /ยังไม่มีวีดีโอ/);
  assert.match(m01, new RegExp(`data-limit-bytes="${SIZE_LIMITS.monthly}" data-limit-label="40 MB"`));
  assert.match(m01, /<a class="btn" href="\/v\/m01" target="_blank" rel="noopener"><svg[^>]*>.*?<\/svg>ดูวีดีโอ<\/a>/);
  assert.match(m01, new RegExp(`data-action="copy" data-url="${srv.url}/v/m01"`));
  assert.match(m01, /href="\/admin\/qr\/m01\.png" download/);
  assert.match(m01, /href="\/admin\/qr\/m01\.svg" download/);
  assert.match(m01, /<input type="file"[^>]*accept="video\/mp4,\.mp4"[^>]*data-action="upload">/);
  assert.match(m01, /อัปโหลดวีดีโอ/);
  assert.match(m01, /<progress max="100"/);
  assert.match(m01, /data-action="cancel">ยกเลิก/);

  const m02 = card('m02');
  assert.match(m02, /มีวีดีโอแล้ว/);
  assert.match(m02, /7\.3 MB/);
  // 10:00 UTC = 17:00 in Bangkok
  assert.match(m02, /<dd data-field="updated">25 ต\.ค\. 2569 17:00 น\. โดย client<\/dd>/);
  assert.match(m02, /เปลี่ยนวีดีโอ/);
  assert.match(card('ecard-lee'), new RegExp(`data-limit-bytes="${SIZE_LIMITS.ecard}" data-limit-label="100 MB"`));
  assert.ok(!html.includes(storage) && !html.includes('1792832980123'), 'no storage path or key on the page');
});

test('AC2: admin.css / admin.js are served with ?v=<content hash> like the player', async () => {
  const html = await (await b.get('/admin')).text();
  for (const name of ['admin.css', 'admin.js']) {
    const content = await readFile(path.join(APP_ROOT, 'public', 'assets', name));
    const v = contentHash(content);
    assert.ok(html.includes(`/assets/${name}?v=${v}`), name);
    const res = await b.get(`/assets/${name}?v=${v}`);
    assert.equal(res.status, 200);
  }
  assert.match(html, /<main class="admin" id="admin" data-mime="video\/mp4">/);
});

// ---------------------------------------------------------------- AC6 list API

test('AC6: GET /api/admin/videos returns the 14 sets without internal paths', async () => {
  await writeStorageFile(storage, 'videos/m01/1792832980123.mp4', fakeMp4Bytes(1000));
  await conn.query("UPDATE videos SET r2_key = 'videos/m01/1792832980123.mp4', size_bytes = 1000, updated_at = UTC_TIMESTAMP(), updated_by = 'x' WHERE slug = 'm01'");
  const res = await b.get('/api/admin/videos');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { videos } = await res.json();
  assert.equal(videos.length, 14);
  assert.deepEqual(Object.keys(videos[0]).sort(), [
    'fileMissing', 'hasVideo', 'kind', 'limitBytes', 'limitLabel', 'publicUrl', 'qrPng', 'qrSvg', 'sizeBytes', 'sizeLabel', 'slug',
    'sortOrder', 'statusLabel', 'title', 'updatedAt', 'updatedAtLabel', 'updatedBy', 'updatedText', 'viewPath',
  ]);
  const text = JSON.stringify(videos);
  assert.ok(!text.includes('1792832980123') && !text.includes(storage) && !text.includes('r2_key'));
  assert.equal(videos[0].slug, 'm01');
  assert.equal(videos[0].hasVideo, true);
  assert.equal(videos[0].limitBytes, SIZE_LIMITS.monthly);
  const anon = await new Browser(srv.url).get('/api/admin/videos');
  assert.equal(anon.status, 401);
});

// ---------------------------------------------------------------- AC3/AC7/AC9 end to end

test('end to end: upload → /v shows it → replace → old file deleted, /media old key 404', async (t) => {
  t.mock.method(console, 'log', () => {});
  const first = fakeMp4Bytes(3000);
  const res1 = await upload('m01', new Blob([first], { type: 'video/mp4' }), 'มกราคม.mp4');
  assert.equal(res1.status, 200);
  const { video: v1 } = await res1.json();
  assert.equal(v1.slug, 'm01');
  assert.equal(v1.hasVideo, true);
  assert.equal(v1.sizeBytes, 3000);
  assert.equal(v1.updatedBy, USER);
  assert.match(v1.updatedText, /น\. โดย upload\.admin$/);
  assert.equal(v1.statusLabel, 'มีวีดีโอแล้ว');

  const r1 = await row('m01');
  assert.match(r1.r2_key, /^videos\/m01\/\d{13}\.mp4$/);
  assert.equal(Number(r1.size_bytes), 3000);
  assert.equal(r1.updated_by, USER);
  assert.ok(Math.abs(r1.updated_at.getTime() - Date.now()) < 5 * 60_000);
  assert.ok((await readFile(path.join(storage, r1.r2_key))).equals(first));
  assert.deepEqual(await filesIn('tmp'), []);

  const page = await (await fetch(`${srv.url}/v/m01/`)).text();
  assert.match(page, new RegExp(`<video[^>]*src="/media/${r1.r2_key}"`));
  const ranged = await fetch(`${srv.url}/media/${r1.r2_key}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.ok(Buffer.from(await ranged.arrayBuffer()).equals(first.subarray(0, 100)));

  // Replace.
  await new Promise((r) => setTimeout(r, 5)); // distinct millisecond name
  const second = fakeMp4Bytes(4000);
  const res2 = await upload('m01', new Blob([second], { type: 'video/mp4' }));
  assert.equal(res2.status, 200);
  const r2 = await row('m01');
  assert.notEqual(r2.r2_key, r1.r2_key);
  assert.deepEqual(await filesIn('videos', 'm01'), [path.basename(r2.r2_key)], 'old file deleted after commit');
  assert.equal((await fetch(`${srv.url}/media/${r1.r2_key}`)).status, 404);
  assert.equal((await fetch(`${srv.url}/media/${r2.r2_key}`)).status, 200);
  const page2 = await (await fetch(`${srv.url}/v/m01`)).text();
  assert.match(page2, new RegExp(`src="/media/${r2.r2_key}"`));
});

test('AC3: e-card accepts more than the monthly limit (40 MiB + 1 byte)', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { blob, cleanup } = await sparseBlob(40 * MIB + 1);
  try {
    const res = await upload('ecard-lee', blob);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).video.sizeBytes, 40 * MIB + 1);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------- AC3 errors

test('AC3: monthly over 40 MiB → 413 too_large (Thai), nothing stored', async () => {
  const { blob, cleanup } = await sparseBlob(40 * MIB + 1);
  try {
    const res = await upload('m03', blob);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.code, 'too_large');
    assert.match(body.message, /ไฟล์ใหญ่เกิน 40 MB/);
    await assertNothingStored('m03');
  } finally {
    await cleanup();
  }
});

test('AC3: a declared body far over the limit is refused up front', async () => {
  const res = await new Promise((resolve, reject) => {
    const { port } = new URL(srv.url);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/admin/videos/m03',
      headers: {
        cookie: b.cookie, origin: srv.url, 'x-forwarded-for': '198.51.100.41',
        'content-type': 'multipart/form-data; boundary=x', 'content-length': String(200 * MIB),
      },
    }, (r) => {
      let text = '';
      r.on('data', (c) => { text += c; });
      r.on('end', () => resolve({ status: r.statusCode, text }));
    });
    req.on('error', reject);
    req.write('--x\r\n'); // a little of the body, then give up
    setTimeout(() => req.destroy(), 300);
  }).catch((e) => ({ status: 0, error: e }));
  if (res.status) {
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.text).code, 'too_large');
  }
  await new Promise((r) => setTimeout(r, 100));
  await assertNothingStored('m03');
});

test('AC3: wrong type (text/plain) → 415 not_mp4', async () => {
  const res = await upload('m04', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  assert.equal(res.status, 415);
  const body = await res.json();
  assert.equal(body.code, 'not_mp4');
  assert.match(body.message, /ไม่ใช่วีดีโอ MP4/);
  await assertNothingStored('m04');
});

test('AC3: labelled video/mp4 but no ftyp box → 415 not_mp4', async () => {
  const res = await upload('m04', new Blob([Buffer.alloc(5000, 7)], { type: 'video/mp4' }), 'fake.mp4');
  assert.equal(res.status, 415);
  assert.equal((await res.json()).code, 'not_mp4');
  await assertNothingStored('m04');
});

test('AC3: no file → 400 no_file; two files → 400 too_many_files; not multipart → 400', async () => {
  const none = await b.upload('/api/admin/videos/m05', [], { fields: { note: 'x' } });
  assert.equal(none.status, 400);
  assert.equal((await none.json()).code, 'no_file');

  const two = await b.upload('/api/admin/videos/m05', [{ blob: mp4(), name: 'a.mp4' }, { blob: mp4(), name: 'b.mp4' }]);
  assert.equal(two.status, 400);
  const twoBody = await two.json();
  assert.equal(twoBody.code, 'too_many_files');
  assert.match(twoBody.message, /ครั้งละ 1 ไฟล์/);

  const json = await b.request('/api/admin/videos/m05', {
    method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' },
  });
  assert.equal(json.status, 400);
  assert.equal((await json.json()).code, 'bad_request');
  await assertNothingStored('m05');
});

test('AC3: unknown or malformed slug → 404 not_found', async () => {
  for (const slug of ['m13', 'BAD_SLUG']) {
    const res = await upload(slug, mp4());
    assert.equal(res.status, 404, slug);
    assert.equal((await res.json()).code, 'not_found');
  }
  assert.deepEqual(await filesIn('tmp'), []);
});

test('AC3: login and CSRF checks still apply to uploads', async () => {
  const anon = await new Browser(srv.url).upload('/api/admin/videos/m06', [{ blob: mp4(), name: 'a.mp4' }]);
  assert.equal(anon.status, 401);
  const forged = await upload('m06', mp4(), 'a.mp4', { origin: 'https://evil.example' });
  assert.equal(forged.status, 403);
  const noOrigin = await upload('m06', mp4(), 'a.mp4', { origin: null });
  assert.equal(noOrigin.status, 403);
  await assertNothingStored('m06');
});

// ---------------------------------------------------------------- AC4 robustness

test('AC4: client disconnects mid-upload → no temp file left, database unchanged', async () => {
  const { port } = new URL(srv.url);
  const boundary = 'lxboundary';
  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/admin/videos/m07',
      headers: {
        cookie: b.cookie, origin: srv.url, 'x-forwarded-for': '198.51.100.42',
        'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(5 * MIB),
      },
    });
    req.on('error', () => resolve());
    req.on('close', () => resolve());
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
    req.write(fakeMp4Bytes(256 * 1024));
    setTimeout(async () => {
      // The temp file exists while the upload is in progress...
      assert.equal((await filesIn('tmp')).length, 1, 'streaming into tmp/');
      req.destroy(); // ...then the client goes away.
    }, 300);
  });
  for (let i = 0; i < 40 && (await filesIn('tmp')).length > 0; i++) await new Promise((r) => setTimeout(r, 50));
  await assertNothingStored('m07');
});

test('AC4: two uploads of the same set at once → DB points at an existing file, no orphans', async (t) => {
  t.mock.method(console, 'log', () => {});
  // An existing video that both uploads replace.
  await upload('m08', mp4(1000));
  const original = (await row('m08')).r2_key;
  const [a, c] = await Promise.all([upload('m08', mp4(2000)), upload('m08', mp4(3000))]);
  assert.equal(a.status, 200);
  assert.equal(c.status, 200);
  const final = await row('m08');
  const onDisk = await filesIn('videos', 'm08');
  assert.deepEqual(onDisk, [path.basename(final.r2_key)], `only the current file remains: ${onDisk}`);
  assert.notEqual(final.r2_key, original);
  assert.equal((await stat(path.join(storage, final.r2_key))).size, Number(final.size_bytes));
  assert.deepEqual(await filesIn('tmp'), []);
});

test('AC4: disk full (ENOSPC) → 507 storage_full in Thai, no crash, nothing left behind', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
  const realCreate = fs.createWriteStream;
  t.mock.method(fs, 'createWriteStream', (file, opts) => {
    const ws = realCreate(file, opts);
    let n = 0;
    const origWrite = ws._write.bind(ws);
    ws._write = (chunk, enc, cb) => {
      n += 1;
      if (n > 1) return cb(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
      return origWrite(chunk, enc, cb);
    };
    return ws;
  });
  const res = await upload('m09', mp4(512 * 1024));
  assert.equal(res.status, 507);
  const body = await res.json();
  assert.equal(body.code, 'storage_full');
  assert.match(body.message, /พื้นที่เก็บไฟล์บนเซิร์ฟเวอร์เต็ม/);
  assert.ok(errors.some((l) => l.includes('ENOSPC')));
  await assertNothingStored('m09');
  // The app keeps working.
  assert.equal((await b.get('/api/admin/videos')).status, 200);
});

test('AC4: storage not writable → 500 storage_error in Thai', async (t) => {
  t.mock.method(console, 'error', () => {});
  const tmpDir = path.join(storage, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  await chmod(tmpDir, 0o500);
  try {
    const res = await upload('m10', mp4());
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, 'storage_error');
    assert.match(body.message, /บันทึกไฟล์ไม่สำเร็จ/);
  } finally {
    await chmod(tmpDir, 0o700);
  }
  await assertNothingStored('m10');
});

test('AC3: the old file is deleted only after commit; a failed delete is logged, not fatal', async (t) => {
  t.mock.method(console, 'log', () => {});
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
  await upload('m11', mp4(1000));
  const old = (await row('m11')).r2_key;
  const realUnlink = fs.promises.unlink;
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (String(file).endsWith(path.basename(old))) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realUnlink(file);
  });
  const res = await upload('m11', mp4(2000));
  assert.equal(res.status, 200);
  const now = (await row('m11')).r2_key;
  assert.notEqual(now, old);
  assert.ok(errors.some((l) => l.includes(`could not delete old file ${old}`) && l.includes('EBUSY')), errors.join('\n'));
  assert.equal((await filesIn('videos', 'm11')).length, 2, 'old file kept when it cannot be deleted');
});

test('AC4: a failed commit removes the placed file (no orphan) and leaves the database unchanged', async (t) => {
  t.mock.method(console, 'error', () => {});
  await conn.query('ALTER TABLE videos ADD CONSTRAINT test_block_m12 CHECK (slug <> \'m12\' OR r2_key IS NULL)');
  try {
    const res = await upload('m12', mp4());
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { code: 'internal', message: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง' });
  } finally {
    await conn.query('ALTER TABLE videos DROP CHECK test_block_m12');
  }
  await assertNothingStored('m12');
});

// ---------------------------------------------------------------- round 2

// A pool that behaves like the real one except where `hooks` intercept.
function hookedPool({ commit, query } = {}) {
  return {
    on() {},
    query: (sql, ...rest) => (query ? query(sql, rest, () => pool.query(sql, ...rest)) : pool.query(sql, ...rest)),
    async getConnection() {
      const c = await pool.getConnection();
      return new Proxy(c, {
        get(target, prop) {
          if (prop === 'commit' && commit) return () => commit(target);
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
}

test('QB1: a monthly file of exactly 40 MiB (41,943,040 bytes) is accepted', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { blob, cleanup } = await sparseBlob(SIZE_LIMITS.monthly);
  try {
    const res = await upload('m01', blob);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).video.sizeBytes, SIZE_LIMITS.monthly);
    assert.equal(Number((await row('m01')).size_bytes), SIZE_LIMITS.monthly);
  } finally {
    await cleanup();
  }
});

test('U1: commit reports an error but did commit → the placed file is kept (DB never points at nothing)', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
  t.mock.method(console, 'log', () => {});
  const p = hookedPool({
    commit: async (target) => {
      await target.commit();
      throw Object.assign(new Error('connection lost during COMMIT'), { code: 'PROTOCOL_CONNECTION_LOST' });
    },
  });
  const s = await startServer(createApp({ config, pool: p, authLimits: LIMITS }));
  try {
    const sb = new Browser(s.url, { ip: '198.51.100.44' });
    sb.cookie = b.cookie;
    const res = await sb.upload('/api/admin/videos/m02', [{ blob: mp4(1500), name: 'a.mp4' }]);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'internal');
  } finally {
    await s.close();
  }
  const r = await row('m02');
  assert.ok(r.r2_key, 'the commit went through');
  assert.equal((await stat(path.join(storage, r.r2_key))).size, 1500, 'file the DB points at still exists');
  assert.ok(errors.some((l) => l.includes('keeping')), errors.join('\n'));
});

test('U1: if the re-check after a failed commit cannot read the DB, the file is kept and logged', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
  const p = hookedPool({
    commit: async () => { throw Object.assign(new Error('commit failed'), { code: 'ER_UNKNOWN' }); },
    query: (sql, rest, real) => {
      if (/^SELECT r2_key FROM videos WHERE slug = \?$/.test(sql)) {
        return Promise.reject(Object.assign(new Error('db gone'), { code: 'ECONNRESET' }));
      }
      return real();
    },
  });
  const s = await startServer(createApp({ config, pool: p, authLimits: LIMITS }));
  try {
    const sb = new Browser(s.url, { ip: '198.51.100.45' });
    sb.cookie = b.cookie;
    const res = await sb.upload('/api/admin/videos/m03', [{ blob: mp4(1500), name: 'a.mp4' }]);
    assert.equal(res.status, 500);
  } finally {
    await s.close();
  }
  assert.equal((await filesIn('videos', 'm03')).length, 1, 'kept: an orphan beats a missing file');
  assert.ok(errors.some((l) => l.includes('could not re-check') && l.includes('ECONNRESET')), errors.join('\n'));
});

test('U5: committed but re-reading the row fails → still 200 JSON with the committed state', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  let committed = false;
  const p = hookedPool({
    commit: async (target) => { await target.commit(); committed = true; },
    query: (sql, rest, real) => (committed && /FROM videos WHERE slug = \?$/.test(sql) && sql.includes('sort_order')
      ? Promise.reject(Object.assign(new Error('read failed'), { code: 'ECONNRESET' }))
      : real()),
  });
  const s = await startServer(createApp({ config, pool: p, authLimits: LIMITS }));
  try {
    const sb = new Browser(s.url, { ip: '198.51.100.46' });
    sb.cookie = b.cookie;
    const res = await sb.upload('/api/admin/videos/m04', [{ blob: mp4(1700), name: 'a.mp4' }]);
    assert.equal(res.status, 200);
    const { video } = await res.json();
    assert.equal(video.slug, 'm04');
    assert.equal(video.hasVideo, true);
    assert.equal(video.sizeBytes, 1700);
    assert.equal(video.updatedBy, USER);
  } finally {
    await s.close();
  }
  assert.equal(Number((await row('m04')).size_bytes), 1700);
});

test('U5: unexpected errors under /api/admin are JSON, not the HTML 500 page', async (t) => {
  t.mock.method(console, 'error', () => {});
  const p = hookedPool({
    query: (sql, rest, real) => (/ORDER BY sort_order/.test(sql)
      ? Promise.reject(Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }))
      : real()),
  });
  const s = await startServer(createApp({ config, pool: p, authLimits: LIMITS }));
  try {
    const sb = new Browser(s.url, { ip: '198.51.100.47' });
    sb.cookie = b.cookie;
    const res = await sb.get('/api/admin/videos');
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, 'internal');
    assert.doesNotMatch(JSON.stringify(body), /ECONNREFUSED|db down/);
  } finally {
    await s.close();
  }
});

test('U2: without hard links the file is copied with COPYFILE_EXCL (never overwrites)', async (t) => {
  t.mock.method(console, 'log', () => {});
  const copies = [];
  const realCopy = fs.promises.copyFile;
  t.mock.method(fs.promises, 'link', async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); });
  t.mock.method(fs.promises, 'copyFile', async (src, dest, mode) => { copies.push(mode); return realCopy(src, dest, mode); });
  const res = await upload('m05', mp4(1800));
  assert.equal(res.status, 200);
  assert.deepEqual(copies, [fs.constants.COPYFILE_EXCL]);
  const r = await row('m05');
  assert.equal((await stat(path.join(storage, r.r2_key))).size, 1800);
  assert.deepEqual(await filesIn('tmp'), [], 'temp file removed after the copy');
});

test('U3: production without PUBLIC_ORIGIN — QR refused with a Thai explanation, warning on /admin', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const prod = { ...config, nodeEnv: 'production', publicOrigin: null };
  const s = await startServer(createApp({ config: prod, pool, authLimits: LIMITS }));
  try {
    const pb = new Browser(s.url, { ip: '198.51.100.48' });
    pb.cookie = b.cookie;
    for (const ext of ['png', 'svg']) {
      const res = await pb.get(`/admin/qr/m01.${ext}`);
      assert.equal(res.status, 500, ext);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.equal(res.headers.get('content-disposition'), null);
      const html = await res.text();
      assert.match(html, /<html lang="th">/);
      assert.match(html, /PUBLIC_ORIGIN=https:\/\/wjasmin\.site/);
    }
    const page = await (await pb.get('/admin')).text();
    assert.match(page, /<p class="warning" role="alert">ยังไม่ได้ตั้งค่า PUBLIC_ORIGIN/);
  } finally {
    await s.close();
  }
  // Dev/test (and production with PUBLIC_ORIGIN) show no warning.
  assert.doesNotMatch(await (await b.get('/admin')).text(), /class="warning"/);
});

// ---------------------------------------------------------------- round 3: log hygiene (V1)

function captureAllLogs(t) {
  const lines = [];
  for (const m of ['log', 'warn', 'error', 'info']) {
    t.mock.method(console, m, (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, Object.getOwnPropertyNames(a ?? {})))).join(' ')));
  }
  return lines;
}

test('V1: a DB error whose SQL contains a bcrypt hash never reaches the log (HTML error handler)', async (t) => {
  const logs = captureAllLogs(t);
  // Make the real UPDATE fail on the server: mysql2 then attaches the
  // interpolated statement (with the new hash) as err.sql.
  const p = hookedPool({
    query: (sql, rest, real) => (sql.startsWith('UPDATE admin_users SET password_hash = ?')
      ? pool.query(sql.replace('password_hash = ?', 'no_such_column = ?'), ...rest)
      : real()),
  });
  const s = await startServer(createApp({ config: { ...config, showErrorDetails: true }, pool: p, authLimits: LIMITS }));
  try {
    const sb = new Browser(s.url, { ip: '198.51.100.49' });
    sb.cookie = b.cookie;
    const res = await sb.post('/admin/password', {
      current_password: PASSWORD, new_password: 'a brand new password', confirm_password: 'a brand new password',
    });
    assert.equal(res.status, 500);
    await res.text();
  } finally {
    await s.close();
  }
  const all = logs.join('\n');
  assert.match(all, /\[error\] Error \[ER_BAD_FIELD_ERROR\]: Unknown column 'no_such_column'/, all);
  assert.doesNotMatch(all, /\$2[aby]\$/, 'no bcrypt hash in the log');
  assert.doesNotMatch(all, /\bsql\b|UPDATE admin_users|sqlMessage/i, 'no SQL in the log');
  // The password was not changed.
  const [[u]] = await conn.query('SELECT password_hash FROM admin_users WHERE username = ?', [USER]);
  assert.ok(await bcrypt.compare(PASSWORD, u.password_hash));
});

test('V1: same for the /api/admin JSON error handler', async (t) => {
  const logs = captureAllLogs(t);
  const fakeHash = `$2b$12$${'a'.repeat(53)}`;
  const p = hookedPool({
    query: (sql, rest, real) => (/ORDER BY sort_order/.test(sql)
      ? pool.query('SELECT ? AS h FROM no_such_table_v1', [fakeHash])
      : real()),
  });
  const s = await startServer(createApp({ config, pool: p, authLimits: LIMITS }));
  try {
    const sb = new Browser(s.url, { ip: '198.51.100.50' });
    sb.cookie = b.cookie;
    const res = await sb.get('/api/admin/videos');
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'internal');
  } finally {
    await s.close();
  }
  const all = logs.join('\n');
  assert.match(all, /\[api\] Error \[ER_NO_SUCH_TABLE\]/, all);
  assert.ok(!all.includes(fakeHash) && !/\$2b\$/.test(all), 'no hash in the log');
  assert.doesNotMatch(all, /\bsql\b|no_such_table_v1'? AS|SELECT/i, 'no SQL in the log');
  assert.doesNotMatch(all, /\n\s+at /, 'no stack outside development');
});

test('AC4: stale temp files (older than a day) are removed at startup', async (t) => {
  t.mock.method(console, 'log', () => {});
  const tmpDir = path.join(storage, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  await writeFile(path.join(tmpDir, 'old.part'), 'x');
  await writeFile(path.join(tmpDir, 'fresh.part'), 'x');
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  await utimes(path.join(tmpDir, 'old.part'), twoDaysAgo, twoDaysAgo);
  const s = await startServer(createApp({ config, pool, authLimits: LIMITS })); // "startup"
  try {
    for (let i = 0; i < 40 && (await filesIn('tmp')).includes('old.part'); i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(await filesIn('tmp'), ['fresh.part']);
  } finally {
    await s.close();
  }
  assert.equal(await cleanupStaleTmp(path.join(storage, 'missing')), 0, 'missing tmp dir is fine');
});

// ---------------------------------------------------------------- AC5 QR

function decodePng(buf) {
  const png = PNG.sync.read(buf);
  return { width: png.width, text: jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data };
}

test('AC5: QR PNG — 2000 px, error correction Q, decodes to <origin>/v/<slug>, readable file name', async (t) => {
  const calls = [];
  const real = QRCode.toBuffer;
  t.mock.method(QRCode, 'toBuffer', (text, opts) => { calls.push(opts); return real.call(QRCode, text, opts); });
  const res = await b.get('/admin/qr/m01.png');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(
    res.headers.get('content-disposition'),
    "attachment; filename=\"QR-01-m01.png\"; filename*=UTF-8''QR-01-%E0%B8%A1%E0%B8%81%E0%B8%A3%E0%B8%B2%E0%B8%84%E0%B8%A1.png",
  );
  const { width, text } = decodePng(Buffer.from(await res.arrayBuffer()));
  assert.equal(width, 2000);
  assert.equal(text, `${srv.url}/v/m01`);
  assert.equal(calls[0].errorCorrectionLevel, 'Q');
});

test('AC5: QR SVG — scalable, same URL; e-card file names', async () => {
  const svg = await b.get('/admin/qr/ecard-lee.svg');
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(svg.headers.get('content-disposition'), /filename="QR-ecard-Lee\.svg"; filename\*=UTF-8''QR-ecard-Lee\.svg$/);
  const text = await svg.text();
  assert.match(text, /<svg[^>]*viewBox="0 0 \d+ \d+"/);
  assert.equal(text, await QRCode.toString(`${srv.url}/v/ecard-lee`, { errorCorrectionLevel: 'Q', margin: 4, type: 'svg' }));
  const png = await b.get('/admin/qr/ecard-loxley.png');
  assert.match(png.headers.get('content-disposition'), /filename="QR-ecard-LOXLEY\.png"/);
});

test('AC5: with PUBLIC_ORIGIN the QR (and copy link) use it; unknown slug 404; login required', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const pubConfig = { ...config, publicOrigin: 'https://wjasmin.example' };
  const s = await startServer(createApp({ config: pubConfig, pool, authLimits: LIMITS }));
  try {
    const pb = new Browser(s.url, { ip: '198.51.100.43' });
    assert.equal((await pb.login(USER, PASSWORD, { origin: 'https://wjasmin.example' })).status, 302);
    const { text } = decodePng(Buffer.from(await (await pb.get('/admin/qr/m12.png')).arrayBuffer()));
    assert.equal(text, 'https://wjasmin.example/v/m12');
    const list = await (await pb.get('/api/admin/videos')).json();
    assert.equal(list.videos.find((v) => v.slug === 'm12').publicUrl, 'https://wjasmin.example/v/m12');
  } finally {
    await s.close();
  }
  assert.equal((await b.get('/admin/qr/m13.png')).status, 404);
  assert.equal((await b.get('/admin/qr/m01.gif')).status, 404);
  const anon = await new Browser(srv.url).get('/admin/qr/m01.png');
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get('location'), '/admin/login');
});

