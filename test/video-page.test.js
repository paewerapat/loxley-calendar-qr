// Task 02 AC1–AC4: the QR landing page /v/<slug>. Uses an in-memory stand-in for
// the videos table and a temp STORAGE_DIR, so no real database is needed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { playerAssetUrls, contentHash } from '../src/assets.js';
import { loadConfig, APP_ROOT } from '../src/config.js';
import { makeTempStorage, fakeMp4Bytes, writeStorageFile, fakePool, startServer } from './helpers.js';

const KEY = 'videos/ecard-lee/1792832980.mp4';
const ROWS = [
  { slug: 'ecard-lee', title: 'e-card ปีใหม่ Lee', kind: 'ecard', r2_key: KEY },
  { slug: 'm01', title: 'มกราคม 2570', kind: 'monthly', r2_key: null },
  { slug: 'ecard-loxley', title: 'e-card ปีใหม่ LOXLEY', kind: 'ecard', r2_key: null },
  { slug: 'm02', title: 'กุมภาพันธ์ 2570', kind: 'monthly', r2_key: 'videos/m02/1792832981.mp4' }, // file missing
  { slug: 'm03', title: '<script>alert("x")</script> & \'q\'', kind: 'monthly', r2_key: 'videos/m03/1792832982.mp4' },
];

let storage;
let srv;

before(async () => {
  storage = await makeTempStorage();
  await writeStorageFile(storage, KEY, fakeMp4Bytes(2000));
  await writeStorageFile(storage, 'videos/m03/1792832982.mp4', fakeMp4Bytes(100));
  const config = loadConfig({
    NODE_ENV: 'production', PORT: '0', DB_HOST: '127.0.0.1', DB_NAME: 'unused_test',
    DB_USERNAME: 'x', DB_PASSWORD: 'x', STORAGE_DIR: storage, SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  });
  srv = await startServer(createApp({ config, pool: fakePool(ROWS) }));
});

after(async () => {
  await srv?.close();
  if (storage) await rm(storage, { recursive: true, force: true });
});

const get = (p, init) => fetch(`${srv.url}${p}`, { redirect: 'manual', ...init });

test('AC1: /v/ecard-lee and /v/ecard-lee/ both → 200 with the same page, no redirect', async () => {
  const a = await get('/v/ecard-lee');
  const b = await get('/v/ecard-lee/');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.headers.get('location'), null);
  assert.equal(b.headers.get('location'), null);
  const [ha, hb] = [await a.text(), await b.text()];
  assert.equal(ha, hb);
  assert.match(ha, /<video id="v"/);
});

test('AC1: trailing slash works for a slug without video too', async () => {
  const res = await get('/v/m01/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /มกราคม 2570/);
});

for (const p of ['/v/nope', '/v/nope/', '/v/M01', '/v/m01_x', '/v/a.b', `/v/${'a'.repeat(41)}`,
  '/v/m01/extra', '/v/', '/v', '/assets', '/assets/']) {
  test(`AC1: ${p} → Thai 404 page`, async () => {
    const res = await get(p);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('location'), null);
    const html = await res.text();
    assert.match(html, /<html lang="th">/);
    assert.match(html, /ไม่พบหน้า/);
  });
}

// fetch() would normalise these to "/" before sending, so send them raw.
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(srv.url);
    const req = http.request({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

for (const p of ['/v/%2e%2e', '/v/%2E%2E', '/v/.%2e', '/v/..', '/v/%2e%2e/', '/assets/..%2f']) {
  test(`AC1: raw ${p} → Thai 404, no redirect`, async () => {
    const res = await rawGet(p);
    assert.equal(res.status, 404, `${p} → ${res.status}`);
    assert.equal(res.headers.location, undefined);
    assert.match(res.body, /<html lang="th">/);
    assert.match(res.body, /ไม่พบหน้า/);
  });
}

test('AC2: video page markup follows the approved e-card page', async () => {
  const res = await get('/v/ecard-lee');
  assert.match(res.headers.get('content-type'), /text\/html; charset=utf-8/);
  const html = await res.text();
  assert.match(html, /<title>e-card ปีใหม่ Lee<\/title>/);
  const videoTag = html.match(/<video[^>]*>/)[0];
  assert.match(videoTag, /\bplaysinline\b/);
  assert.match(videoTag, /preload="auto"/);
  assert.match(videoTag, new RegExp(`src="/media/${KEY}"`));
  assert.doesNotMatch(videoTag, /\bloop\b|\bcontrols\b|\bautoplay\b/);
  assert.match(html, /id="sound"[^>]*role="status"[^>]*aria-label="[^"]*[฀-๿][^"]*"/);
  assert.match(html, /<svg[^>]*viewBox="0 0 24 24"/);
  assert.match(html, /<button id="replay"[^>]*hidden>ดูอีกครั้ง<\/button>/);
  assert.match(html, /<p id="hint" class="hint" hidden>แตะหน้าจอหนึ่งครั้งเพื่อฟังเสียงบรรยาย<\/p>/);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/player\.css\?v=[0-9a-f]{10}">/);
  assert.match(html, /<script src="\/assets\/player\.js\?v=[0-9a-f]{10}" defer><\/script>/);
  // Nothing loaded from another origin.
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//);
});

test('AC2: shared player assets are served from public/ and load nothing external', async () => {
  for (const [p, type] of [['/assets/player.css', /text\/css/], ['/assets/player.js', /javascript/]]) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), type);
    const body = await res.text();
    assert.equal(body, await readFile(path.join(APP_ROOT, 'public', p), 'utf8'));
    assert.doesNotMatch(body, /https?:\/\/|@import|url\(/, p);
  }
});

test('cache busting: ?v= in the page is the sha256 prefix of the served file content', async () => {
  const html = await (await get('/v/ecard-lee')).text();
  for (const name of ['player.css', 'player.js']) {
    const v = html.match(new RegExp(`/assets/${name.replace('.', '\\.')}\\?v=([0-9a-f]+)`))[1];
    const content = await readFile(path.join(APP_ROOT, 'public', 'assets', name));
    assert.equal(v, createHash('sha256').update(content).digest('hex').slice(0, 10), name);
    const res = await get(`/assets/${name}?v=${v}`); // the versioned URL is served
    assert.equal(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(content));
  }
});

test('cache busting: the version changes when the file content changes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loxley-assets-'));
  try {
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'assets', 'player.css'), 'a{}');
    await writeFile(path.join(dir, 'assets', 'player.js'), 'void 0;');
    const first = playerAssetUrls(dir);
    assert.match(first.css, /^\/assets\/player\.css\?v=[0-9a-f]{10}$/);
    assert.equal(first.js, `/assets/player.js?v=${contentHash('void 0;')}`);
    await writeFile(path.join(dir, 'assets', 'player.js'), 'void 1;');
    const second = playerAssetUrls(dir);
    assert.notEqual(second.js, first.js);
    assert.equal(second.css, first.css, 'unchanged file keeps its version');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AC2: whole page without the video stays under ~20KB', async () => {
  const sizes = await Promise.all(['/v/ecard-lee', '/assets/player.css', '/assets/player.js']
    .map(async (p) => (await (await get(p)).arrayBuffer()).byteLength));
  const total = sizes.reduce((a, b) => a + b, 0);
  assert.ok(total <= 20 * 1024, `total ${total} bytes`);
});

test('AC3: no video yet (r2_key NULL) → 200 coming-soon page, monthly wording, no <video>', async () => {
  const res = await get('/v/m01');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>มกราคม 2570<\/title>/);
  assert.match(html, /<h1>มกราคม 2570<\/h1>/);
  assert.match(html, /วีดีโอเดือนนี้จะเปิดให้ชมเร็ว ๆ นี้/);
  assert.match(html, /background: #000/);
  assert.match(html, /color: #d4af37/);
  assert.doesNotMatch(html, /<video/);
});

test('AC3: e-card without video → e-card wording', async () => {
  const html = await (await get('/v/ecard-loxley')).text();
  assert.match(html, /e-card นี้จะเปิดให้ชมเร็ว ๆ นี้/);
  assert.doesNotMatch(html, /<video/);
});

test('AC3: r2_key set but file missing on disk → coming-soon page, no <video>', async () => {
  const res = await get('/v/m02');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /วีดีโอเดือนนี้จะเปิดให้ชมเร็ว ๆ นี้/);
  assert.doesNotMatch(html, /<video|1792832981/);
});

test('AC4: /v/* pages are no-cache and noindex (video, coming soon and 404)', async () => {
  for (const p of ['/v/ecard-lee', '/v/m01', '/v/nope']) {
    const res = await get(p);
    assert.equal(res.headers.get('cache-control'), 'no-cache', p);
    assert.match(await res.text(), /<meta name="robots" content="noindex">/, p);
  }
});

test('AC4: title is escaped everywhere', async () => {
  const html = await (await get('/v/m03')).text();
  assert.ok(!html.includes('<script>alert'));
  assert.match(html, /<title>&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;q&#39;<\/title>/);
});

test('a database error on /v → 500 Thai page, no details', async (t) => {
  t.mock.method(console, 'error', () => {});
  const config = loadConfig({
    NODE_ENV: 'production', PORT: '0', DB_HOST: 'h', DB_NAME: 'n_test', DB_USERNAME: 'u', DB_PASSWORD: 'p', STORAGE_DIR: storage, SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  });
  const broken = { query: async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); } };
  const s = await startServer(createApp({ config, pool: broken }));
  try {
    const res = await fetch(`${s.url}/v/m01`);
    assert.equal(res.status, 500);
    const html = await res.text();
    assert.match(html, /ระบบขัดข้อง/);
    assert.doesNotMatch(html, /db down|ECONNREFUSED/);
  } finally {
    await s.close();
  }
});

// Task 03 AC13: missing player assets must not stop the app.
test('missing assets: logs "[assets] missing ..." without the full path and falls back to plain URLs', () => {
  const lines = [];
  const urls = playerAssetUrls(path.join(os.tmpdir(), 'loxley-no-such-public-dir'), { log: (l) => lines.push(l) });
  assert.deepEqual(urls, { css: '/assets/player.css', js: '/assets/player.js' });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[assets\] missing assets\/player\.css/);
  assert.match(lines[1], /^\[assets\] missing assets\/player\.js/);
  assert.ok(lines.every((l) => !l.includes(os.tmpdir())), 'no full path in the log');
});

test('missing assets: the app still starts and the video page uses URLs without ?v=', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...a) => logs.push(a.join(' ')));
  const emptyPublic = await mkdtemp(path.join(os.tmpdir(), 'loxley-empty-public-'));
  try {
    const base = loadConfig({
      NODE_ENV: 'production', PORT: '0', DB_HOST: '127.0.0.1', DB_NAME: 'unused_test', DB_USERNAME: 'x',
      DB_PASSWORD: 'x', STORAGE_DIR: storage, SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    });
    const s = await startServer(createApp({ config: { ...base, publicDir: emptyPublic }, pool: fakePool(ROWS) }));
    try {
      const html = await (await fetch(`${s.url}/v/ecard-lee`)).text();
      assert.match(html, /<link rel="stylesheet" href="\/assets\/player\.css">/);
      assert.match(html, /<script src="\/assets\/player\.js" defer><\/script>/);
    } finally {
      await s.close();
    }
    assert.ok(logs.some((l) => l.startsWith('[assets] missing assets/player.js')));
    assert.ok(logs.every((l) => !l.includes(emptyPublic)));
  } finally {
    await rm(emptyPublic, { recursive: true, force: true });
  }
});
