// QA (task 04, round 2): exact size limits agree across browser / CLI / server,
// customer-facing "MB" wording, production QR without PUBLIC_ORIGIN, JSON errors
// under /api/admin, server timeouts and the "saving" message. In-process app on the
// local test DB with a temp STORAGE_DIR. Holds the DB test lock.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
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
  fakeMp4Bytes, runNode,
} from './helpers.js';

const RAISED = { ipPerMinute: 100_000, maxConcurrentChecks: 100 };
const MIB = 1024 * 1024;
const USER = 'qa4r2.admin';
const PASSWORD = 'qa4r2 admin password';

const baseConfig = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(baseConfig.db.database);

let conn;
let pool;
let storage;
let scratch;
let config;
let srv;
let b;
const servers = [];
const origConsole = {};

before(async () => {
  for (const m of ['log', 'warn', 'error']) { origConsole[m] = console[m]; console[m] = () => {}; }
  conn = await mysql.createConnection(connectionOptions(baseConfig.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(baseConfig.db);
  await conn.query(
    'INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    [USER, bcrypt.hashSync(PASSWORD, 4), new Date(Date.now() - 1000)],
  );
  storage = await makeTempStorage();
  scratch = await mkdtemp(path.join(os.tmpdir(), 'loxley-qa4r2-src-'));
  config = { ...baseConfig, storageDir: storage };
  pool = createPool(config.db);
  srv = await startServer(createApp({ config, pool, authLimits: RAISED }));
  servers.push(srv);
  b = new Browser(srv.url, { ip: '198.51.100.120' });
  assert.equal((await b.login(USER, PASSWORD)).status, 302);
});

after(async () => {
  for (const s of servers) await s.close();
  await pool?.end();
  await conn?.end();
  for (const d of [storage, scratch]) if (d) await rm(d, { recursive: true, force: true });
  Object.assign(console, origConsole);
});

beforeEach(async () => {
  await conn.query('UPDATE videos SET r2_key = NULL, size_bytes = NULL, updated_at = NULL, updated_by = NULL');
  await rm(path.join(storage, 'videos'), { recursive: true, force: true });
  await rm(path.join(storage, 'tmp'), { recursive: true, force: true });
});

const row = async (slug) => (await conn.query('SELECT * FROM videos WHERE slug = ?', [slug]))[0][0];
const filesIn = async (...parts) => readdir(path.join(storage, ...parts)).catch(() => []);

async function sparseFile(file, size) {
  await mkdir(path.dirname(file), { recursive: true });
  const fh = await open(file, 'w');
  await fh.write(fakeMp4Bytes(16), 0, 16, 0);
  await fh.truncate(size);
  await fh.close();
  return file;
}
const sparseBlob = async (size) => fs.openAsBlob(await sparseFile(path.join(scratch, `s-${size}.mp4`), size), { type: VIDEO_MIME });

async function upload(slug, blob, browser = b) {
  const res = await browser.upload(`/api/admin/videos/${slug}`, [{ blob, name: 'clip.mp4' }]);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, text, json, type: res.headers.get('content-type') };
}

// ---------------------------------------------------------------- admin.js in a vm (like admin-js.test.js)

const ADMIN_JS = await readFile(path.join(APP_ROOT, 'public', 'assets', 'admin.js'), 'utf8');

function runAdminJs(limitLabel) {
  const el = (extra = {}) => {
    const listeners = {};
    return {
      textContent: '', className: '', hidden: false, disabled: false, value: 0, onclick: null,
      setAttribute() {}, addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
      fire(t) { for (const fn of listeners[t] ?? []) fn({ target: this, currentTarget: this }); },
      ...extra,
    };
  };
  const make = (slug, kind) => {
    const fields = {};
    for (const f of ['status', 'size', 'updated', 'upload-text', 'upload-label', 'progress', 'bar', 'percent', 'message']) fields[f] = el();
    const actions = { upload: el(), copy: el({ dataset: { url: `https://x/v/${slug}` } }), cancel: el() };
    return {
      dataset: { slug, limitBytes: String(SIZE_LIMITS[kind]), limitLabel: limitLabel[kind] },
      fields, actions,
      querySelector(sel) {
        let m = /^\[data-field="([^"]+)"\]$/.exec(sel);
        if (m) return fields[m[1]];
        m = /^\[data-action="([^"]+)"\]$/.exec(sel);
        if (m) return actions[m[1]];
        throw new Error(sel);
      },
    };
  };
  const cards = [make('m01', 'monthly'), make('ecard-lee', 'ecard')];
  const xhrs = [];
  class FakeXHR {
    constructor() { this.upload = {}; xhrs.push(this); }
    open(method, url) { this.url = url; }
    send(body) { this.body = body; }
    abort() { this.onabort?.(); }
  }
  vm.runInNewContext(ADMIN_JS, {
    document: { getElementById: () => ({ dataset: { mime: VIDEO_MIME }, querySelectorAll: () => cards }) },
    XMLHttpRequest: FakeXHR,
    FormData: class { append() {} },
    fetch: async () => ({ status: 200 }),
    navigator: { clipboard: { writeText: async () => {} } },
    window: { prompt() {} },
    encodeURIComponent,
  });
  const pick = async (card, size) => {
    card.actions.upload.files = [{ name: 'a.mp4', type: VIDEO_MIME, size, slice: () => ({}) }];
    card.actions.upload.fire('change');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { cards, xhrs, pick };
}

// ================================================================== 1. QB1: limits agree everywhere

test('1. exact limit accepted / +1 refused by browser (admin.js), CLI (video:set) and server alike', { timeout: 180000 }, async () => {
  const labels = { monthly: '40 MB', ecard: '100 MB' };
  for (const [slug, kind, cardIdx] of [['m06', 'monthly', 0], ['ecard-loxley', 'ecard', 1]]) {
    const limit = SIZE_LIMITS[kind];

    // Browser.
    const js = runAdminJs(labels);
    await js.pick(js.cards[cardIdx], limit);
    assert.equal(js.xhrs.length, 1, `${kind}: admin.js sends a file of exactly the limit`);
    const js2 = runAdminJs(labels);
    await js2.pick(js2.cards[cardIdx], limit + 1);
    assert.equal(js2.xhrs.length, 0, `${kind}: admin.js refuses limit + 1`);
    assert.match(js2.cards[cardIdx].fields.message.textContent, new RegExp(`ไฟล์ใหญ่เกิน ${labels[kind]}`));

    // Server.
    const ok = await upload(slug, await sparseBlob(limit));
    assert.equal(ok.status, 200, `${kind} exact: ${ok.text}`);
    assert.equal(ok.json.video.sizeBytes, limit);
    const over = await upload(slug, await sparseBlob(limit + 1));
    assert.equal(over.status, 413, over.text);
    assert.equal(over.json.code, 'too_large');
    assert.deepEqual(await filesIn('tmp'), []);

    // CLI.
    const cliEnv = { ...process.env, STORAGE_DIR: storage };
    const exactKey = `videos/${slug}/1792800000001.mp4`;
    const overKey = `videos/${slug}/1792800000002.mp4`;
    await sparseFile(path.join(storage, exactKey), limit);
    await sparseFile(path.join(storage, overKey), limit + 1);
    const cliOk = await runNode(path.join(APP_ROOT, 'scripts', 'video-set.js'), { env: cliEnv, args: [slug, exactKey], timeoutMs: 30000 });
    assert.equal(cliOk.code, 0, cliOk.stderr + cliOk.stdout);
    assert.equal((await row(slug)).r2_key, exactKey);
    const cliOver = await runNode(path.join(APP_ROOT, 'scripts', 'video-set.js'), { env: cliEnv, args: [slug, overKey], timeoutMs: 30000 });
    assert.equal(cliOver.code, 1);
    assert.equal((await row(slug)).r2_key, exactKey, 'CLI refusal leaves the DB alone');
  }
});

// ================================================================== 2. "MB" for customers

test('2. customer-facing sizes say MB (API, page, admin.js, too_large JSON, README guide); never MiB/KiB', { timeout: 60000 }, async () => {
  // 7.3 MiB file → "7.3 MB".
  const up = await upload('m01', await sparseBlob(Math.round(7.3 * MIB)));
  assert.equal(up.status, 200);
  assert.equal(up.json.video.sizeLabel, '7.3 MB');
  assert.equal(up.json.video.limitLabel, '40 MB');

  const apiText = await (await b.get('/api/admin/videos')).text();
  assert.doesNotMatch(apiText, /MiB|KiB/);
  const { videos } = JSON.parse(apiText);
  for (const v of videos) assert.equal(v.limitLabel, v.kind === 'ecard' ? '100 MB' : '40 MB', v.slug);

  const page = await (await b.get('/admin')).text();
  assert.doesNotMatch(page, /MiB|KiB/);
  assert.match(page, /ไม่เกิน 40 MB/);
  assert.match(page, /ไม่เกิน 100 MB/);
  assert.match(page, /7\.3 MB/);

  assert.doesNotMatch(ADMIN_JS, /MiB|KiB/);

  // Streaming over-limit (monthly) and declared-too-large (ecard) both say MB.
  const over = await upload('m02', await sparseBlob(SIZE_LIMITS.monthly + 1));
  assert.equal(over.status, 413);
  assert.match(over.json.message, /40 MB/);
  assert.doesNotMatch(over.json.message, /MiB|KiB|bytes/);
  const declared = await new Promise((resolve, reject) => {
    const { port } = new URL(srv.url);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/admin/videos/ecard-lee',
      headers: {
        cookie: b.cookie, origin: srv.url, 'x-forwarded-for': '198.51.100.120',
        'content-type': 'multipart/form-data; boundary=x', 'content-length': String(300 * MIB),
      },
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, json: JSON.parse(t) }); });
    });
    req.on('error', reject);
    req.write('--x\r\n');
  });
  assert.equal(declared.status, 413);
  assert.match(declared.json.message, /100 MB/);
  assert.doesNotMatch(declared.json.message, /MiB|KiB|bytes/);

  const readme = await readFile(path.join(APP_ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('## คู่มือสำหรับลูกค้า');
  assert.ok(start >= 0, 'customer guide section exists');
  const end = readme.indexOf('\n## ', start + 5);
  const guide = readme.slice(start, end < 0 ? undefined : end);
  assert.doesNotMatch(guide, /MiB|KiB/);
  assert.match(guide, /40 MB/);
  assert.match(guide, /100 MB/);
});

// ================================================================== 3. U3: production QR needs PUBLIC_ORIGIN

function rawGet(base, p, headers) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('3. production without PUBLIC_ORIGIN: QR → Thai warning page (never built from Host); /admin banner; with PUBLIC_ORIGIN QR works', { timeout: 60000 }, async () => {
  const prodEnv = { ...process.env, PORT: '0', NODE_ENV: 'production', COOKIE_SECURE: '', STORAGE_DIR: storage };
  const noOrigin = loadConfig({ ...prodEnv, PUBLIC_ORIGIN: '' });
  assert.equal(noOrigin.publicOrigin, null);
  const s = await startServer(createApp({ config: noOrigin, pool, authLimits: RAISED }));
  servers.push(s);
  const httpsOwn = s.url.replace('http://', 'https://');
  const pb = new Browser(s.url, { ip: '198.51.100.121' });
  const login = await pb.login(USER, PASSWORD, { origin: httpsOwn, headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(login.status, 302);
  assert.ok(pb.cookie, 'session cookie');

  for (const ext of ['png', 'svg']) {
    for (const host of [undefined, 'evil.example']) {
      const headers = { cookie: pb.cookie, 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.121' };
      if (host) headers.host = host;
      const r = await rawGet(s.url, `/admin/qr/m01.${ext}`, headers);
      const html = r.body.toString('utf8');
      assert.match(r.headers['content-type'], /^text\/html/, `${ext} ${host}`);
      assert.equal(r.headers['content-disposition'], undefined);
      assert.match(html, /<html lang="th">/);
      assert.match(html, /PUBLIC_ORIGIN/);
      assert.match(html, /[฀-๿]{5}/);
      assert.ok(!html.includes('evil.example'));
      assert.notEqual(r.body.subarray(0, 4).toString('latin1'), '\x89PNG');
      assert.ok(r.status >= 400, `status ${r.status}`);
    }
  }
  assert.equal((await rawGet(s.url, '/admin/qr/m13.png', { cookie: pb.cookie, 'x-forwarded-proto': 'https' })).status, 404);
  const page = await (await pb.get('/admin', { headers: { 'x-forwarded-proto': 'https' } })).text();
  assert.match(page, /class="warning" role="alert"[^>]*>[^<]*PUBLIC_ORIGIN/);

  // With PUBLIC_ORIGIN in production: QR as before, no banner.
  const withOrigin = loadConfig({ ...prodEnv, PUBLIC_ORIGIN: 'https://wjasmin.example' });
  const s2 = await startServer(createApp({ config: withOrigin, pool, authLimits: RAISED }));
  servers.push(s2);
  const pb2 = new Browser(s2.url, { ip: '198.51.100.122' });
  assert.equal((await pb2.login(USER, PASSWORD, { origin: 'https://wjasmin.example' })).status, 302);
  const qr = await rawGet(s2.url, '/admin/qr/ecard-lee.png', { cookie: pb2.cookie, host: 'evil.example' });
  assert.equal(qr.status, 200);
  assert.match(qr.headers['content-disposition'], /filename="QR-ecard-Lee\.png"/);
  const png = PNG.sync.read(qr.body);
  assert.equal(png.width, 2000);
  assert.equal(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data, 'https://wjasmin.example/v/ecard-lee');
  assert.doesNotMatch(await (await pb2.get('/admin')).text(), /class="warning"/);
});

// ================================================================== 4. U5: JSON errors under /api/admin

function failingPool(pattern) {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'query') {
        return (sql, ...rest) => (pattern.test(String(sql))
          ? Promise.reject(Object.assign(new Error('qa: db down /secret/path'), { code: 'ECONNREFUSED' }))
          : target.query(sql, ...rest));
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

test('4. unexpected errors under /api/admin are JSON {code:"internal"} with no details; nothing left in tmp', async () => {
  // List query fails.
  const s = await startServer(createApp({ config, pool: failingPool(/ORDER BY sort_order/), authLimits: RAISED }));
  servers.push(s);
  const sb = new Browser(s.url, { ip: '198.51.100.123' });
  sb.cookie = b.cookie;
  const list = await sb.get('/api/admin/videos');
  assert.equal(list.status, 500);
  assert.match(list.headers.get('content-type'), /application\/json/);
  const body = await list.text();
  assert.equal(JSON.parse(body).code, 'internal');
  assert.match(JSON.parse(body).message, /[฀-๿]/);
  assert.doesNotMatch(body, /ECONNREFUSED|db down|secret|<html/i);

  // Slug lookup before the upload fails.
  const s2 = await startServer(createApp({
    config, pool: failingPool(/SELECT slug, title, kind, r2_key, size_bytes FROM videos WHERE slug/), authLimits: RAISED,
  }));
  servers.push(s2);
  const sb2 = new Browser(s2.url, { ip: '198.51.100.124' });
  sb2.cookie = b.cookie;
  const up = await upload('m03', new Blob([fakeMp4Bytes(1500)], { type: VIDEO_MIME }), sb2);
  assert.equal(up.status, 500, up.text);
  assert.match(up.type, /application\/json/);
  assert.equal(up.json.code, 'internal');
  assert.doesNotMatch(up.text, /ECONNREFUSED|secret|<html/i);
  assert.deepEqual(await filesIn('tmp'), []);
  assert.equal((await row('m03')).r2_key, null);

  // Unknown API route: JSON 404 (not the HTML page).
  const nf = await b.get('/api/admin/nope');
  assert.equal(nf.status, 404);
  assert.match(nf.headers.get('content-type'), /application\/json/);
});

// ================================================================== 5. U4: timeouts + "saving" message

test('5a. real app.js: server.requestTimeout ≈ 30 min, headersTimeout ≤ 60 s', { timeout: 30000 }, async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'loxley-qa4r2-store-'));
  try {
    const code = `import(${JSON.stringify(APP_JS)}).then((m) => { console.log('TIMEOUTS ' + m.server.requestTimeout + ' ' + m.server.headersTimeout); process.exit(0); });`;
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        cwd: APP_ROOT, env: { ...process.env, PORT: '0', STORAGE_DIR: store }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let o = '';
      child.stdout.on('data', (d) => { o += d; });
      child.stderr.on('data', (d) => { o += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      child.on('exit', () => { clearTimeout(timer); resolve(o); });
    });
    const m = /TIMEOUTS (\d+) (\d+)/.exec(out);
    assert.ok(m, out);
    const [requestTimeout, headersTimeout] = [Number(m[1]), Number(m[2])];
    assert.ok(requestTimeout >= 25 * 60 * 1000 && requestTimeout <= 35 * 60 * 1000, `requestTimeout ${requestTimeout}`);
    assert.ok(headersTimeout > 0 && headersTimeout <= 60_000, `headersTimeout ${headersTimeout}`);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test('5b. admin.js: progress shows %, and "กำลังบันทึก..." once 100% is sent', async () => {
  const js = runAdminJs({ monthly: '40 MB', ecard: '100 MB' });
  await js.pick(js.cards[0], 1000);
  const xhr = js.xhrs[0];
  assert.ok(xhr, 'upload started');
  xhr.upload.onprogress({ lengthComputable: true, loaded: 500, total: 1000 });
  assert.equal(js.cards[0].fields.percent.textContent, '50%');
  assert.notEqual(js.cards[0].fields.message.textContent, 'กำลังบันทึก...');
  xhr.upload.onprogress({ lengthComputable: true, loaded: 1000, total: 1000 });
  assert.equal(js.cards[0].fields.percent.textContent, '100%');
  assert.equal(js.cards[0].fields.message.textContent, 'กำลังบันทึก...');
});
