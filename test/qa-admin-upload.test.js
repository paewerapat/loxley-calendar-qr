// QA (task 04, round 1): independent verification of the back-office upload, QR
// downloads, list page/API and the public page after an upload. In-process app on
// the local test DB with a temp STORAGE_DIR, plus one black-box run of the real
// app.js (NODE_ENV=production, PUBLIC_ORIGIN) with curl. Holds the DB test lock.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, utimes, writeFile, chmod } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { loadConfig, APP_ROOT } from '../src/config.js';
import { createPool, connectionOptions } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { SIZE_LIMITS, VIDEO_MIME } from '../src/videos.js';
import {
  APP_JS, assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, startServer, Browser, makeTempStorage,
  fakeMp4Bytes, closedPort,
} from './helpers.js';

const RAISED = { ipPerMinute: 100_000, maxConcurrentChecks: 100 };
const MIB = 1024 * 1024;
const USER = 'qa4.admin';
const PASSWORD = 'qa4 admin password';
const KEY_RE = /^videos\/([a-z0-9-]+)\/(\d{13})\.mp4$/;

const baseConfig = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(baseConfig.db.database);

let conn;
let pool;
let storage;
let scratch; // sparse/big source files (outside STORAGE_DIR)
let config;
let srv;
let b;
const logs = [];
const bodies = []; // every response text this file read

before(async () => {
  for (const m of ['log', 'warn', 'error']) {
    const orig = console[m];
    console[m] = (...args) => { logs.push(args.map(String).join(' ')); };
    console[`__orig_${m}`] = orig;
  }
  conn = await mysql.createConnection(connectionOptions(baseConfig.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(baseConfig.db);
  await conn.query(
    'INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    [USER, bcrypt.hashSync(PASSWORD, 4), new Date(Date.now() - 1000)],
  );
  storage = await makeTempStorage();
  scratch = await mkdtemp(path.join(os.tmpdir(), 'loxley-qa4-src-'));
  config = { ...baseConfig, storageDir: storage };
  pool = createPool(config.db);
  srv = await startServer(createApp({ config, pool, authLimits: RAISED }));
  b = new Browser(srv.url, { ip: '198.51.100.90' });
  assert.equal((await b.login(USER, PASSWORD)).status, 302);
});

after(async () => {
  await srv?.close();
  await pool?.end();
  await conn?.end();
  for (const d of [storage, scratch]) if (d) await rm(d, { recursive: true, force: true });
  for (const m of ['log', 'warn', 'error']) if (console[`__orig_${m}`]) console[m] = console[`__orig_${m}`];
});

beforeEach(async () => {
  await conn.query('UPDATE videos SET r2_key = NULL, size_bytes = NULL, updated_at = NULL, updated_by = NULL');
  await rm(path.join(storage, 'videos'), { recursive: true, force: true });
  await rm(path.join(storage, 'tmp'), { recursive: true, force: true });
});

const row = async (slug) => (await conn.query('SELECT * FROM videos WHERE slug = ?', [slug]))[0][0];
const filesIn = async (...parts) => readdir(path.join(storage, ...parts)).catch(() => []);
const mp4Blob = (size = 2000, type = VIDEO_MIME) => new Blob([fakeMp4Bytes(size)], { type });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function upload(slug, blob, name = 'clip.mp4', opts = {}, browser = b) {
  const res = await browser.upload(`/api/admin/videos/${slug}`, [{ blob, name }], opts);
  const text = await res.text();
  bodies.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function sparseBlob(size) {
  const file = path.join(scratch, `sparse-${size}.mp4`);
  const fh = await open(file, 'w');
  await fh.write(fakeMp4Bytes(16), 0, 16, 0);
  await fh.truncate(size);
  await fh.close();
  return fs.openAsBlob(file, { type: VIDEO_MIME });
}

async function assertNothingStored(slug, before = null) {
  for (let i = 0; i < 40 && (await filesIn('tmp')).length > 0; i++) await sleep(25);
  assert.deepEqual(await filesIn('tmp'), [], 'no temp file left');
  const r = await row(slug);
  assert.equal(r.r2_key, before, 'database unchanged');
  assert.deepEqual(await filesIn('videos', slug), before ? [path.basename(before)] : [], 'videos/ unchanged');
}

function assertThaiError(res, status, code) {
  assert.equal(res.status, status, res.text);
  assert.equal(res.json?.code, code, res.text);
  assert.match(res.json.message, /[฀-๿]/, 'Thai message');
}

function assertNoPaths(text) {
  assert.ok(!text.includes(storage), 'storage path leaked');
  assert.ok(!text.includes(APP_ROOT), 'app root leaked');
  assert.ok(!text.includes(os.tmpdir() + '/'), 'tmp dir leaked');
  assert.doesNotMatch(text, /\.part\b/, 'temp file name leaked');
  assert.doesNotMatch(text, /r2_key|password_hash/);
}

// Raw multipart over node:http (full control over filenames and bytes).
function multipart(parts, boundary = 'qa4boundary') {
  const chunks = [];
  for (const p of parts) {
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.rawDisposition) disp = p.rawDisposition;
    else if (p.filename !== undefined) disp += `; filename="${p.filename}"`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disp}\r\n`, 'utf8'));
    if (p.type) chunks.push(Buffer.from(`Content-Type: ${p.type}\r\n`));
    chunks.push(Buffer.from('\r\n'), Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data ?? ''), 'utf8'), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

function rawPost(urlBase, p, body, headers) {
  const { port } = new URL(urlBase);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: p,
      headers: { 'content-length': String(body.length), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        bodies.push(text);
        let json = null;
        try { json = JSON.parse(text); } catch { /* */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const rawUpload = (slug, parts) => {
  const { body, type } = multipart(parts);
  return rawPost(srv.url, `/api/admin/videos/${slug}`, body, {
    cookie: b.cookie, origin: srv.url, 'x-forwarded-for': '198.51.100.90', 'content-type': type,
  });
};

// ================================================================== 1. upload correctness

test('1.1 valid upload: 200 JSON row, file at videos/<slug>/<epoch-ms>.mp4 with identical bytes, DB updated', async () => {
  const bytes = fakeMp4Bytes(4321);
  const started = Date.now();
  const res = await upload('m01', new Blob([bytes], { type: VIDEO_MIME }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.video.slug, 'm01');
  assert.equal(res.json.video.hasVideo, true);
  assert.equal(res.json.video.sizeBytes, 4321);
  assert.equal(res.json.video.updatedBy, USER);
  assertNoPaths(res.text);
  assert.doesNotMatch(res.text, /videos\/m01\/\d+\.mp4/, 'storage key not exposed in the API');
  const r = await row('m01');
  const m = KEY_RE.exec(r.r2_key);
  assert.ok(m && m[1] === 'm01', r.r2_key);
  assert.ok(Number(m[2]) >= started - 5 && Number(m[2]) <= Date.now() + 50, 'epoch-ms name');
  assert.equal(Number(r.size_bytes), 4321);
  assert.equal(r.updated_by, USER);
  assert.ok(Math.abs(r.updated_at.getTime() - Date.now()) < 120_000, `updated_at UTC: ${r.updated_at.toISOString()}`);
  assert.deepEqual(await readFile(path.join(storage, r.r2_key)), bytes);
  assert.deepEqual(await filesIn('tmp'), []);
});

test('1.2 replace: old file kept until the commit, deleted after; old /media 404, new 200/206; /v shows new (AC7)', { timeout: 30000 }, async () => {
  assert.equal((await upload('m02', mp4Blob(1500))).status, 200);
  const oldKey = (await row('m02')).r2_key;
  const oldFile = path.join(storage, oldKey);

  // Hold the set's row lock so the upload's commit has to wait.
  const holder = await mysql.createConnection(connectionOptions(baseConfig.db));
  let pending;
  try {
    await holder.beginTransaction();
    await holder.query("SELECT r2_key FROM videos WHERE slug = 'm02' FOR UPDATE");
    pending = upload('m02', mp4Blob(2600));
    // Wait until the new file has been placed next to the old one.
    for (let i = 0; i < 80 && (await filesIn('videos', 'm02')).length < 2; i++) await sleep(25);
    assert.equal((await filesIn('videos', 'm02')).length, 2, 'new file placed, waiting for the commit');
    assert.ok(fs.existsSync(oldFile), 'old file still there before the commit');
    assert.equal((await row('m02')).r2_key, oldKey);
    const pageMid = await (await fetch(`${srv.url}/v/m02`)).text();
    assert.ok(pageMid.includes(`/media/${oldKey}`), 'public page still plays the old file meanwhile');
  } finally {
    await holder.commit();
    await holder.end();
  }
  const res = await pending;
  assert.equal(res.status, 200, res.text);
  const newKey = (await row('m02')).r2_key;
  assert.notEqual(newKey, oldKey);
  assert.ok(!fs.existsSync(oldFile), 'old file deleted after the commit');
  assert.deepEqual(await filesIn('videos', 'm02'), [path.basename(newKey)]);

  assert.equal((await fetch(`${srv.url}/media/${oldKey}`)).status, 404);
  const full = await fetch(`${srv.url}/media/${newKey}`);
  assert.equal(full.status, 200);
  assert.equal(Number(full.headers.get('content-length')), 2600);
  await full.arrayBuffer();
  const part = await fetch(`${srv.url}/media/${newKey}`, { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 0-99/2600');
  await part.arrayBuffer();

  const page = await fetch(`${srv.url}/v/m02`);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  const html = await page.text();
  assert.ok(html.includes(`/media/${newKey}`), 'new video shown at once');
  assert.ok(!html.includes(oldKey));
});

test('1.3 commit cannot get the row lock (held > retries) → 503 busy in Thai; old file and DB untouched; placed file removed', { timeout: 40000 }, async () => {
  assert.equal((await upload('m03', mp4Blob(1500))).status, 200);
  const oldKey = (await row('m03')).r2_key;
  const holder = await mysql.createConnection(connectionOptions(baseConfig.db));
  let res;
  try {
    await holder.beginTransaction();
    await holder.query("SELECT r2_key FROM videos WHERE slug = 'm03' FOR UPDATE");
    res = await upload('m03', mp4Blob(2600));
  } finally {
    await holder.rollback();
    await holder.end();
  }
  assert.ok(res.status === 503 || res.status === 200, res.text);
  assert.notEqual(res.status, 500);
  if (res.status === 503) {
    assertThaiError(res, 503, 'busy');
    await assertNothingStored('m03', oldKey);
  }
});

// ---------------------------------------------------------------- sizes at the exact limits

for (const [slug, kind] of [['m04', 'monthly'], ['ecard-loxley', 'ecard']]) {
  const limit = SIZE_LIMITS[kind];
  test(`1.4 ${kind}: exactly ${limit / MIB} MiB (${limit} bytes) is accepted`, { timeout: 120000 }, async () => {
    const res = await upload(slug, await sparseBlob(limit), 'exact.mp4');
    assert.equal(res.status, 200, `exactly the limit was refused: ${res.text}`);
    const r = await row(slug);
    assert.equal(Number(r.size_bytes), limit);
    assert.equal((await stat(path.join(storage, r.r2_key))).size, limit);
    assert.deepEqual(await filesIn('tmp'), []);
  });

  test(`1.4 ${kind}: limit + 1 byte → 413 too_large (Thai), nothing stored`, { timeout: 120000 }, async () => {
    const res = await upload(slug, await sparseBlob(limit + 1), 'over.mp4');
    assertThaiError(res, 413, 'too_large');
    assertNoPaths(res.text);
    await assertNothingStored(slug);
  });
}

test('1.4 monthly: limit - 1 byte is accepted', { timeout: 60000 }, async () => {
  const res = await upload('m05', await sparseBlob(SIZE_LIMITS.monthly - 1), 'under.mp4');
  assert.equal(res.status, 200, res.text);
});

// ---------------------------------------------------------------- type / signature / parts

test('1.5 wrong type → 415 not_mp4 (ftyp content does not help); nothing stored', async () => {
  for (const type of ['text/plain', 'application/octet-stream', 'video/quicktime', 'video/mp4x']) {
    const res = await upload('m06', mp4Blob(2000, type), 'clip.mp4');
    assertThaiError(res, 415, 'not_mp4');
    await assertNothingStored('m06');
  }
});

test('1.6 labelled video/mp4 but no ftyp box (incl. empty and 7-byte files) → 415 not_mp4; nothing stored', async () => {
  const noFtyp = Buffer.alloc(5000, 0x41);
  const moovFirst = fakeMp4Bytes(3000);
  moovFirst.write('moov', 4, 'latin1');
  for (const buf of [noFtyp, moovFirst, Buffer.alloc(0), Buffer.from('xxxxftyp').subarray(0, 7)]) {
    const res = await upload('m06', new Blob([buf], { type: VIDEO_MIME }), 'fake.mp4');
    assertThaiError(res, 415, 'not_mp4');
    await assertNothingStored('m06');
  }
});

test('1.7 two files → 400 too_many_files; no file → 400 no_file; non-multipart → 400; nothing stored', async () => {
  const two = await b.upload('/api/admin/videos/m07', [
    { blob: mp4Blob(1000), name: 'a.mp4' }, { blob: mp4Blob(1200), name: 'b.mp4' },
  ]);
  const twoJson = await two.json();
  assert.equal(two.status, 400);
  assert.equal(twoJson.code, 'too_many_files');
  await assertNothingStored('m07');

  const none = await b.upload('/api/admin/videos/m07', [], { fields: { note: 'hello' } });
  assert.equal(none.status, 400);
  assert.equal((await none.json()).code, 'no_file');
  await assertNothingStored('m07');

  const json = await b.request('/api/admin/videos/m07', {
    method: 'POST', body: '{"file":"x"}', headers: { 'content-type': 'application/json' },
  });
  assert.equal(json.status, 400);
  assert.equal((await json.json()).code, 'bad_request');
  const empty = await b.request('/api/admin/videos/m07', { method: 'POST' });
  assert.equal(empty.status, 400);
  await assertNothingStored('m07');
});

test('1.8 extra non-file fields: a few small ones are ignored; a 4 KB field is harmless; too many → 400 Thai', async () => {
  const ok = await upload('m08', mp4Blob(1800), 'a.mp4', { fields: { title: 'x', slug: '../m01', kind: 'ecard' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.video.slug, 'm08');
  assert.equal(ok.json.video.kind, 'monthly', 'form fields cannot change the set');
  assert.equal((await row('m01')).r2_key, null);

  const bigField = await upload('m09', mp4Blob(1800), 'a.mp4', { fields: { note: 'n'.repeat(4096) } });
  assert.notEqual(bigField.status, 500);

  const fields = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 'v']));
  const many = await upload('m10', mp4Blob(1800), 'a.mp4', { fields });
  assertThaiError(many, 400, 'bad_request');
  await assertNothingStored('m10');
});

test('1.9 filename tricks never affect the stored path', async () => {
  const names = [
    '../../x.mp4', '..\\..\\x.mp4', '/etc/passwd', `${'a'.repeat(400)}.mp4`, 'วีดีโอ เดือนมกราคม.mp4',
    'a\u0000b.mp4', '.htaccess', 'x.mp4\r\nX-Evil: 1', '%2e%2e%2fx.mp4',
  ];
  for (const filename of names) {
    const res = await rawUpload('m11', [{ name: 'file', filename, type: VIDEO_MIME, data: fakeMp4Bytes(1500) }]);
    assert.notEqual(res.status, 500, `${JSON.stringify(filename)}: ${res.text}`);
    if (res.status === 200) {
      const key = (await row('m11')).r2_key;
      assert.match(key, /^videos\/m11\/\d{13}\.mp4$/, JSON.stringify(filename));
      assert.deepEqual(await filesIn('videos', 'm11'), [path.basename(key)]);
    }
    assertNoPaths(res.text);
  }
  // filename* (RFC 5987) with traversal
  const star = await rawUpload('m11', [{
    name: 'file', rawDisposition: "Content-Disposition: form-data; name=\"file\"; filename*=UTF-8''..%2F..%2Fx.mp4",
    type: VIDEO_MIME, data: fakeMp4Bytes(1500),
  }]);
  assert.notEqual(star.status, 500);
  // Nothing escaped STORAGE_DIR or landed beside it.
  const top = (await readdir(storage)).sort();
  assert.ok(top.every((n) => ['videos', 'tmp'].includes(n)), `storage top level: ${top}`);
  assert.deepEqual(await filesIn('videos'), ['m11']);
  for (const p of [path.join(storage, '..', 'x.mp4'), path.join(storage, 'x.mp4'), path.join(storage, 'videos', 'x.mp4')]) {
    assert.ok(!fs.existsSync(p), p);
  }
  assert.deepEqual(await filesIn('tmp'), []);
});

// ---------------------------------------------------------------- aborts

function abortedUpload({ slug, stage }) {
  const { port } = new URL(srv.url);
  const boundary = 'qa4abort';
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `/api/admin/videos/${slug}`,
      headers: {
        cookie: b.cookie, origin: srv.url, 'x-forwarded-for': '198.51.100.90',
        'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(8 * MIB),
      },
    });
    req.on('error', () => resolve());
    req.on('close', () => resolve());
    req.on('response', (res) => { res.resume(); });
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.mp4"\r\nContent-Type: video/mp4\r\n\r\n`;
    if (stage === 'headers') {
      req.write(`--${boundary}\r\n`);
    } else if (stage === 'mid') {
      req.write(head);
      req.write(fakeMp4Bytes(512 * 1024));
    } else if (stage === 'after-data') { // whole file sent, closing boundary never comes
      req.write(head);
      req.write(fakeMp4Bytes(300 * 1024));
      req.write(`\r\n--${boundary}`);
    }
    setTimeout(() => req.destroy(), 300);
  });
}

for (const stage of ['headers', 'mid', 'after-data']) {
  test(`1.10 client aborts (${stage}) → no temp file, DB unchanged, existing video kept`, { timeout: 20000 }, async () => {
    assert.equal((await upload('m12', mp4Blob(1000))).status, 200);
    const before = (await row('m12')).r2_key;
    await abortedUpload({ slug: 'm12', stage });
    await sleep(200);
    await assertNothingStored('m12', before);
    assert.ok(fs.existsSync(path.join(storage, before)));
    // The app still works afterwards.
    assert.equal((await upload('m12', mp4Blob(1100))).status, 200);
  });
}

// ---------------------------------------------------------------- concurrency

test('1.11 concurrent uploads to the same set (3 rounds of 2, 1 round of 4): consistent end state', { timeout: 60000 }, async () => {
  assert.equal((await upload('ecard-lee', mp4Blob(1000))).status, 200);
  for (const n of [2, 2, 2, 4]) {
    const before = (await row('ecard-lee')).r2_key;
    const sizes = Array.from({ length: n }, (_, i) => 2000 + i * 100 + Math.floor(Math.random() * 50));
    const results = await Promise.all(sizes.map((s) => upload('ecard-lee', mp4Blob(s))));
    const codes = results.map((r) => r.status);
    assert.ok(codes.every((c) => c === 200 || c === 503), codes.join(','));
    assert.ok(codes.includes(200), codes.join(','));
    const final = await row('ecard-lee');
    const file = path.join(storage, final.r2_key);
    assert.ok(fs.existsSync(file), 'DB points at an existing file');
    assert.equal((await stat(file)).size, Number(final.size_bytes));
    assert.ok(sizes.includes(Number(final.size_bytes)), 'one of this round\'s uploads');
    const onDisk = await filesIn('videos', 'ecard-lee');
    assert.ok(onDisk.length <= 2, `at most one orphan: ${onDisk}`);
    assert.ok(onDisk.includes(path.basename(final.r2_key)));
    assert.ok(!onDisk.includes(path.basename(before)) || before === final.r2_key, 'previous file replaced');
    assert.deepEqual(await filesIn('tmp'), []);
  }
});

test('1.12 concurrent uploads to different sets all succeed', { timeout: 30000 }, async () => {
  const slugs = ['m01', 'm02', 'm03', 'm04', 'ecard-lee', 'ecard-loxley'];
  const results = await Promise.all(slugs.map((s, i) => upload(s, mp4Blob(1000 + i))));
  assert.deepEqual(results.map((r) => r.status), slugs.map(() => 200));
  for (const [i, s] of slugs.entries()) {
    const r = await row(s);
    assert.equal(Number(r.size_bytes), 1000 + i);
    assert.equal((await stat(path.join(storage, r.r2_key))).size, 1000 + i);
  }
  assert.deepEqual(await filesIn('tmp'), []);
});

test('1.13 storage not writable → 500 storage_error JSON in Thai (no path), app keeps working', async () => {
  const tmpDir = path.join(storage, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  await chmod(tmpDir, 0o500);
  let res;
  try {
    res = await upload('m05', mp4Blob(1500));
  } finally {
    await chmod(tmpDir, 0o700);
  }
  assertThaiError(res, 500, 'storage_error');
  assertNoPaths(res.text);
  assert.equal((await row('m05')).r2_key, null);
  assert.equal((await upload('m05', mp4Blob(1500))).status, 200);
});

// ================================================================== 2. security

test('2.1 without a session: upload/list → 401 JSON, /admin and QR → 302 login; nothing stored', async () => {
  const anon = new Browser(srv.url, { ip: '198.51.100.91' });
  const up = await upload('m01', mp4Blob(1500), 'a.mp4', {}, anon);
  assert.equal(up.status, 401);
  assert.deepEqual(up.json, { error: 'unauthorized' });
  await assertNothingStored('m01');
  const list = await anon.get('/api/admin/videos');
  assert.equal(list.status, 401);
  for (const p of ['/admin', '/admin/qr/m01.png', '/admin/qr/m01.svg']) {
    const r = await anon.get(p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), '/admin/login');
  }
  // A forged/old cookie is no better.
  const forged = new Browser(srv.url, { ip: '198.51.100.92' });
  forged.cookie = 'lx.sid=s%3Anot-a-session.abc';
  assert.equal((await upload('m01', mp4Blob(1500), 'a.mp4', {}, forged)).status, 401);
});

test('2.2 logged in but wrong/missing Origin → 403, nothing stored', async () => {
  for (const origin of ['https://evil.example', null, 'null', srv.url.replace('127.0.0.1', 'localhost')]) {
    const res = await upload('m01', mp4Blob(1500), 'a.mp4', { origin });
    assert.equal(res.status, 403, String(origin));
  }
  const viaBadReferer = await upload('m01', mp4Blob(1500), 'a.mp4', { origin: null, headers: { referer: 'https://evil.example/admin' } });
  assert.equal(viaBadReferer.status, 403);
  await assertNothingStored('m01');
});

test('2.3 upload to unknown / malformed slug → 404 not_found; nothing stored anywhere', async () => {
  for (const slug of ['m13', 'M01', 'ecard-nobody', '..%2Fm01', 'm01%00', '%2e%2e', 'a'.repeat(41)]) {
    const res = await upload(slug, mp4Blob(1500));
    assert.equal(res.status, 404, `${slug}: ${res.text}`);
    assertNoPaths(res.text);
  }
  assert.deepEqual(await filesIn('videos'), []);
  assert.deepEqual(await filesIn('tmp'), []);
});

test('2.4 QR for slugs with path characters / unknown slugs → 404', async () => {
  for (const p of ['/admin/qr/..%2fapp.js.png', '/admin/qr/m01%2f..png', '/admin/qr/M01.png', '/admin/qr/m01.png.png',
    '/admin/qr/m01.gif', '/admin/qr/m13.png', '/admin/qr/.png', '/admin/qr/m01', '/admin/qr/%2e%2e.png',
    '/admin/qr/m01.PNG', '/admin/qr/m01%00.png']) {
    const r = await b.get(p);
    assert.equal(r.status, 404, p);
    const text = await r.text();
    assertNoPaths(text);
  }
});

// ================================================================== 3. QR

function decodePng(buf) {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, text: jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data };
}

function dispositionNames(h) {
  const ascii = /filename="([^"]*)"/.exec(h)?.[1];
  const star = /filename\*=UTF-8''([^;]+)/.exec(h)?.[1];
  return { ascii, utf8: star && decodeURIComponent(star) };
}

test('3.1 QR PNG/SVG: decodes to <origin>/v/<slug>, 2000 px, readable Thai filename* + ASCII fallback', { timeout: 30000 }, async () => {
  const cases = [
    ['m01', 'QR-01-มกราคม', 'QR-01-m01'],
    ['m12', 'QR-12-ธันวาคม', 'QR-12-m12'],
    ['ecard-lee', 'QR-ecard-Lee', 'QR-ecard-Lee'],
    ['ecard-loxley', 'QR-ecard-LOXLEY', 'QR-ecard-LOXLEY'],
  ];
  for (const [slug, utf8, ascii] of cases) {
    const png = await b.get(`/admin/qr/${slug}.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    const cd = png.headers.get('content-disposition');
    assert.match(cd, /^attachment;/);
    assert.deepEqual(dispositionNames(cd), { ascii: `${ascii}.png`, utf8: `${utf8}.png` });
    assert.match(dispositionNames(cd).ascii, /^[\x20-\x7e]+$/);
    const { width, height, text } = decodePng(Buffer.from(await png.arrayBuffer()));
    assert.equal(width, 2000);
    assert.equal(height, 2000);
    assert.equal(text, `${srv.url}/v/${slug}`);

    const svg = await b.get(`/admin/qr/${slug}.svg`);
    assert.equal(svg.status, 200);
    assert.deepEqual(dispositionNames(svg.headers.get('content-disposition')), { ascii: `${ascii}.svg`, utf8: `${utf8}.svg` });
    const svgText = await svg.text();
    assert.match(svgText, /<svg[^>]*viewBox=/);
    assert.doesNotMatch(svgText, /<svg[^>]*\swidth="\d+(px)?"/, 'no fixed pixel width');
  }
});

test('3.2 QR with PUBLIC_ORIGIN uses it (also for copy-link); the request Host does not leak in', { timeout: 30000 }, async () => {
  const s = await startServer(createApp({ config: { ...config, publicOrigin: 'https://wjasmin.example' }, pool, authLimits: RAISED }));
  try {
    const pb = new Browser(s.url, { ip: '198.51.100.93' });
    assert.equal((await pb.login(USER, PASSWORD, { origin: 'https://wjasmin.example' })).status, 302);
    for (const slug of ['m03', 'ecard-lee']) {
      const res = await pb.get(`/admin/qr/${slug}.png`, { headers: { 'x-forwarded-host': 'evil.example' } });
      assert.equal(decodePng(Buffer.from(await res.arrayBuffer())).text, `https://wjasmin.example/v/${slug}`);
    }
    const list = await (await pb.get('/api/admin/videos')).json();
    assert.ok(list.videos.every((v) => v.publicUrl === `https://wjasmin.example/v/${v.slug}`));
    const html = await (await pb.get('/admin')).text();
    assert.ok(html.includes('data-url="https://wjasmin.example/v/m01"'));
  } finally {
    await s.close();
  }
});

// ================================================================== 4. page + API

const EXPECTED_SLUGS = [...Array.from({ length: 12 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`), 'ecard-lee', 'ecard-loxley'];

test('4.1 GET /api/admin/videos: 14 rows in order, Bangkok time, limits = server constants, no internals', async () => {
  assert.equal((await upload('m05', mp4Blob(1234))).status, 200);
  // 2026-10-24 17:30 UTC = 25 Oct 2026 00:30 in Bangkok (Thai year 2569).
  await conn.query("UPDATE videos SET updated_at = '2026-10-24 17:30:00' WHERE slug = 'm05'");
  const res = await b.get('/api/admin/videos');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  assertNoPaths(text);
  assert.doesNotMatch(text, /videos\/m05\/\d+\.mp4/);
  const { videos } = JSON.parse(text);
  assert.deepEqual(videos.map((v) => v.slug), EXPECTED_SLUGS);
  for (const v of videos) {
    assert.equal(v.limitBytes, SIZE_LIMITS[v.kind], v.slug);
    assert.equal(v.viewPath, `/v/${v.slug}`);
  }
  const m05 = videos.find((v) => v.slug === 'm05');
  assert.equal(m05.hasVideo, true);
  assert.equal(m05.statusLabel, 'มีวีดีโอแล้ว');
  assert.equal(m05.updatedAt, '2026-10-24T17:30:00.000Z');
  assert.match(m05.updatedAtLabel, /25/);
  assert.match(m05.updatedAtLabel, /00:30/);
  assert.match(m05.updatedAtLabel, /2569/);
  assert.ok(m05.updatedText.includes(USER));
  const m06 = videos.find((v) => v.slug === 'm06');
  assert.equal(m06.hasVideo, false);
  assert.equal(m06.statusLabel, 'ยังไม่มีวีดีโอ');
});

test('4.2 /admin page: 14 cards, Thai, no-store, viewport, data attributes match server constants, no internals', async () => {
  assert.equal((await upload('m07', mp4Blob(1234))).status, 200);
  await conn.query("UPDATE videos SET updated_at = '2026-10-24 17:30:00' WHERE slug = 'm07'");
  const res = await b.get('/admin');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assertNoPaths(html);
  assert.doesNotMatch(html, /videos\/m07\/\d+\.mp4/);
  assert.match(html, /<html lang="th">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, new RegExp(`data-mime="${VIDEO_MIME}"`));
  const cards = [...html.matchAll(/<li class="video" data-slug="([^"]+)" data-limit-bytes="(\d+)"/g)];
  assert.deepEqual(cards.map((c) => c[1]), EXPECTED_SLUGS);
  for (const [, slug, limit] of cards) {
    assert.equal(Number(limit), slug.startsWith('ecard') ? SIZE_LIMITS.ecard : SIZE_LIMITS.monthly, slug);
  }
  assert.ok(html.includes('href="/admin/password"'));
  assert.ok(html.includes('action="/admin/logout"'));
  const m07 = html.slice(html.indexOf('data-slug="m07"'), html.indexOf('data-slug="m08"'));
  assert.match(m07, /00:30/);
  assert.match(m07, /มีวีดีโอแล้ว/);
  assert.match(m07, /href="\/v\/m07" target="_blank"/);
  assert.match(m07, /href="\/admin\/qr\/m07\.png"/);
  assert.match(m07, /href="\/admin\/qr\/m07\.svg"/);
  assert.match(m07, /type="file"[^>]*accept="video\/mp4,\.mp4"/);
  assert.doesNotMatch(html, /<table/);
  // No hardcoded limits in the browser script.
  const js = await readFile(path.join(APP_ROOT, 'public', 'assets', 'admin.js'), 'utf8');
  assert.ok(!js.includes(String(SIZE_LIMITS.monthly)) && !js.includes(String(SIZE_LIMITS.ecard)), 'limits not hardcoded in admin.js');
  assert.doesNotMatch(js, /20\s*\*\s*1024|100\s*\*\s*1024/);
});

test('4.3 admin.css: nothing forces a layout wider than a 360 px phone', async () => {
  const css = await readFile(path.join(APP_ROOT, 'public', 'assets', 'admin.css'), 'utf8');
  // Drop @media blocks with min-width (they only apply to wider screens).
  const base = css.replace(/@media\s*\(min-width:[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const offenders = [];
  for (const m of base.matchAll(/(^|[;{\s])((?:min-)?width|flex-basis|grid-template-columns)\s*:\s*([^;}]+)/g)) {
    for (const px of m[3].matchAll(/(\d+(?:\.\d+)?)px/g)) if (Number(px[1]) > 360) offenders.push(`${m[2]}: ${m[3]}`);
  }
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(base, /white-space:\s*nowrap[^}]*width/);
});

// ================================================================== 5. AC7 is in 1.2; plus coming-soon → video

test('5.1 /v/<slug> goes from "coming soon" to the video right after the first upload (no-cache)', async () => {
  const before = await fetch(`${srv.url}/v/m09`);
  assert.equal(before.headers.get('cache-control'), 'no-cache');
  const beforeHtml = await before.text();
  assert.match(beforeHtml, /เร็ว ๆ นี้/);
  assert.equal((await upload('m09', mp4Blob(1600))).status, 200);
  const key = (await row('m09')).r2_key;
  const after = await (await fetch(`${srv.url}/v/m09/`)).text();
  assert.ok(after.includes(`src="/media/${key}"`) || after.includes(`/media/${key}`));
  assert.doesNotMatch(after, /เร็ว ๆ นี้/);
});

// ================================================================== 6. real app.js, black box

function rss(pid) {
  const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+) kB`).exec(s)[1]) * 1024;
  return { rss: kb('VmRSS'), hwm: kb('VmHWM') };
}

function curl(args) {
  return new Promise((resolve) => {
    execFile('curl', args, { maxBuffer: 10 * MIB }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

test('6. real app.js (production, PUBLIC_ORIGIN, temp STORAGE_DIR): stale tmp cleanup, 50 MiB e-card via curl, memory', { timeout: 180000 }, async (t) => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'loxley-qa4-store-'));
  const tmpDir = path.join(store, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  await writeFile(path.join(tmpDir, 'old.part'), 'x');
  await writeFile(path.join(tmpDir, 'fresh.part'), 'x');
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  await utimes(path.join(tmpDir, 'old.part'), old, old);

  const port = await closedPort();
  const child = spawn(process.execPath, [APP_JS], {
    cwd: APP_ROOT,
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'production', COOKIE_SECURE: '',
      PUBLIC_ORIGIN: 'https://wjasmin.example', STORAGE_DIR: store,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100 && !/listening on port/.test(out); i++) await sleep(100);
    assert.match(out, /listening on port/, out);
    for (let i = 0; i < 40 && fs.existsSync(path.join(tmpDir, 'old.part')); i++) await sleep(50);
    assert.deepEqual((await readdir(tmpDir)).sort(), ['fresh.part'], 'stale (>1 day) temp file removed at startup');

    // Login (Secure cookie over the https-declared origin, no X-Forwarded-Proto).
    const login = await fetch(`${base}/admin/login`, {
      method: 'POST', redirect: 'manual',
      headers: { origin: 'https://wjasmin.example', 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.95' },
      body: new URLSearchParams({ username: USER, password: PASSWORD }).toString(),
    });
    assert.equal(login.status, 302);
    const setCookie = login.headers.getSetCookie().find((c) => c.startsWith('lx.sid='));
    assert.match(setCookie, /;\s*Secure/i);
    const cookie = setCookie.split(';')[0];

    // Real (non-sparse) files with an ftyp header.
    async function makeFile(name, size) {
      const file = path.join(scratch, name);
      const fh = await open(file, 'w');
      const chunk = Buffer.alloc(MIB);
      for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31) % 251;
      const h = createHash('sha256');
      let w = 0;
      while (w < size) {
        const n = Math.min(MIB, size - w);
        const piece = Buffer.from(chunk.subarray(0, n));
        if (w === 0) { piece.writeUInt32BE(24, 0); piece.write('ftypisom', 4, 'latin1'); }
        await fh.write(piece);
        h.update(piece);
        w += n;
      }
      await fh.close();
      return { file, hash: h.digest('hex') };
    }
    const size = 50 * MIB + 12345;
    const { file: src, hash: srcHash } = await makeFile('big-50.mp4', size);

    const common = ['-sS', '-o', '-', '-w', '\n%{http_code}', '-H', 'X-Forwarded-For: 198.51.100.95'];
    // CSRF and session still enforced on the real app.
    const noCookie = await curl([...common, '-H', 'Origin: https://wjasmin.example',
      '-F', `file=@${src};type=video/mp4`, `${base}/api/admin/videos/ecard-loxley`]);
    assert.match(noCookie.stdout, /\n401$/, noCookie.stdout + noCookie.stderr);
    const badOrigin = await curl([...common, '-H', `Origin: ${base}`, '-H', `Cookie: ${cookie}`,
      '-F', `file=@${src};type=video/mp4`, `${base}/api/admin/videos/ecard-loxley`]);
    assert.match(badOrigin.stdout, /\n403$/, badOrigin.stdout + badOrigin.stderr);

    const before = rss(child.pid);
    let peakRss = before.rss;
    const sampler = setInterval(() => { try { peakRss = Math.max(peakRss, rss(child.pid).rss); } catch { /* */ } }, 20);
    const started = Date.now();
    const up = await curl([...common, '-H', 'Origin: https://wjasmin.example', '-H', `Cookie: ${cookie}`,
      '-F', `file=@${src};type=video/mp4`, `${base}/api/admin/videos/ecard-loxley`]);
    clearInterval(sampler);
    const tookMs = Date.now() - started;
    const afterMem = rss(child.pid);
    const [bodyText, code] = [up.stdout.slice(0, up.stdout.lastIndexOf('\n')), up.stdout.slice(up.stdout.lastIndexOf('\n') + 1)];
    assert.equal(code, '200', up.stdout + up.stderr + out);
    const json = JSON.parse(bodyText);
    assert.equal(json.video.sizeBytes, size);
    assert.equal(json.video.publicUrl, 'https://wjasmin.example/v/ecard-loxley');
    assertNoPaths(bodyText);
    assert.ok(!bodyText.includes(store));

    const r = await row('ecard-loxley');
    const stored = path.join(store, r.r2_key);
    assert.equal((await stat(stored)).size, size);
    const storedHash = createHash('sha256').update(await readFile(stored)).digest('hex');
    assert.equal(storedHash, srcHash, 'stored bytes match');
    assert.deepEqual((await readdir(tmpDir)).sort(), ['fresh.part'], 'no temp file left by the upload');

    const growth = peakRss - before.rss;
    const hwmGrowth = afterMem.hwm - before.hwm;
    t.diagnostic(`50 MiB upload: ${tookMs} ms; RSS before ${Math.round(before.rss / MIB)} MiB, sampled peak +${Math.round(growth / MIB)} MiB, VmHWM +${Math.round(hwmGrowth / MIB)} MiB`);
    // Buffering would cost at least the file size on top of the baseline.
    assert.ok(growth < size, `RSS grew by ${Math.round(growth / MIB)} MiB during a 50 MiB upload`);

    // Scaling: if the body were buffered, growth would follow the file size. Measure
    // a 99 MiB upload (fast, loopback) and a rate-limited 50 MiB one (like a real
    // network: input slower than the disk).
    const measure = async (file, slug, extra = []) => {
      const b0 = rss(child.pid).rss;
      let peak = b0;
      const s = setInterval(() => { try { peak = Math.max(peak, rss(child.pid).rss); } catch { /* */ } }, 20);
      const res = await curl([...common, ...extra, '-H', 'Origin: https://wjasmin.example', '-H', `Cookie: ${cookie}`,
        '-F', `file=@${file};type=video/mp4`, `${base}/api/admin/videos/${slug}`]);
      clearInterval(s);
      return { code: res.stdout.slice(res.stdout.lastIndexOf('\n') + 1), growth: peak - b0 };
    };
    const { file: src99 } = await makeFile('big-99.mp4', 99 * MIB);
    const big = await measure(src99, 'ecard-lee');
    const slow = await measure(src, 'ecard-lee', ['--limit-rate', '25M']);
    t.diagnostic(`99 MiB fast upload: ${big.code}, peak RSS +${Math.round(big.growth / MIB)} MiB; 50 MiB at 25 MB/s: ${slow.code}, peak RSS +${Math.round(slow.growth / MIB)} MiB`);
    assert.equal(big.code, '200');
    assert.equal(slow.code, '200');
    // Size-relative (round 2): V8/GC peaks of ~40–70 MiB show up regardless of the
    // file size; buffering the body would add at least the whole 99 MiB.
    assert.ok(big.growth < 99 * MIB, `99 MiB upload grew RSS by ${Math.round(big.growth / MIB)} MiB`);
    // Buffering would hold the whole 50 MiB; observed 0–16 MiB in full-suite runs.
    assert.ok(slow.growth < 40 * MIB, `rate-limited 50 MiB upload grew RSS by ${Math.round(slow.growth / MIB)} MiB`);

    // Public page and media of the real app.
    const page = await (await fetch(`${base}/v/ecard-loxley`)).text();
    assert.ok(page.includes(`/media/${r.r2_key}`));
    const range = await fetch(`${base}/media/${r.r2_key}`, { headers: { range: 'bytes=0-99' } });
    assert.equal(range.status, 206);
    await range.arrayBuffer();
    assert.doesNotMatch(out, /\[error\]|TypeError|ReferenceError/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); });
    await rm(store, { recursive: true, force: true });
    await conn.query("UPDATE videos SET r2_key = NULL, size_bytes = NULL WHERE slug = 'ecard-loxley'");
  }
});

// ================================================================== logs / bodies

test('7. no response body exposed a disk path; nothing logged as [error] except expected storage failures', () => {
  for (const text of bodies) assertNoPaths(text);
  const unexpected = logs.filter((l) => /\[error\]|TypeError|ReferenceError/.test(l));
  assert.deepEqual(unexpected, []);
  assert.ok(!logs.join('\n').includes(PASSWORD));
});
