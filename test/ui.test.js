// Task 05: polished login / change password / admin pages — check marks only on sets
// with a video, summary numbers, inline QR preview, self-hosted fonts, nothing loaded
// from other sites. Real DB + real cookies; holds the DB test lock.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import QRCode from 'qrcode';
import { loadConfig, APP_ROOT } from '../src/config.js';
import { createPool, connectionOptions } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { contentHash, SARABUN_FILES } from '../src/assets.js';
import { MSG } from '../src/admin-routes.js';
import {
  assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, startServer, Browser, makeTempStorage, writeStorageFile,
  fakeMp4Bytes,
} from './helpers.js';

const LIMITS = { ipPerMinute: 100_000, maxConcurrentChecks: 100 };
const USER = 'ui.admin';
const PASSWORD = 'ui admin password';
const baseConfig = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(baseConfig.db.database);

let conn;
let pool;
let storage;
let config;
let srv;
let b;

before(async () => {
  conn = await mysql.createConnection(connectionOptions(baseConfig.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(baseConfig.db);
  await conn.query('INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    [USER, bcrypt.hashSync(PASSWORD, 4), new Date(Date.now() - 1000)]);
  storage = await makeTempStorage();
  config = { ...baseConfig, storageDir: storage };
  pool = createPool(config.db);
  srv = await startServer(createApp({ config, pool, authLimits: LIMITS }));
  b = new Browser(srv.url, { ip: '198.51.100.60' });
  assert.equal((await b.login(USER, PASSWORD)).status, 302);
});

after(async () => {
  await srv?.close();
  await pool?.end();
  await conn?.end();
  if (storage) await rm(storage, { recursive: true, force: true });
});

beforeEach(async () => {
  await conn.query('UPDATE videos SET r2_key = NULL, size_bytes = NULL, updated_at = NULL, updated_by = NULL');
});

// A set "has a video" only when its file exists (task 05 round 2), so write one.
const setVideo = (slugs) => Promise.all(slugs.map(async (s) => {
  const key = `videos/${s}/1792832980123.mp4`;
  await writeStorageFile(storage, key, fakeMp4Bytes(1000));
  await conn.query(
    "UPDATE videos SET r2_key = ?, size_bytes = 1000, updated_at = UTC_TIMESTAMP(), updated_by = 'client' WHERE slug = ?",
    [key, s],
  );
}));

const cardsOf = (html) => Object.fromEntries(html.split('<li class="video"').slice(1)
  .map((c) => [c.match(/^ data-slug="([^"]+)"/)[1], c.slice(0, c.indexOf('</li>'))]));

function assertSummary(html, done) {
  assert.match(html, new RegExp(`มีวีดีโอแล้ว <strong id="summary-done">${done}</strong> / <span id="summary-total">14</span> ชุด`));
  assert.match(html, new RegExp(`<progress id="summary-bar" max="14" value="${done}"`));
}

for (const [label, withVideo] of [
  ['0 / 14', []],
  ['1 / 14 (production today: ecard-lee)', ['ecard-lee']],
  ['14 / 14', ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11', 'm12', 'ecard-lee', 'ecard-loxley']],
]) {
  test(`AC3/AC4 ${label}: summary count, check mark and green badge only on sets with a video`, async () => {
    await setVideo(withVideo);
    const html = await (await b.get('/admin')).text();
    assertSummary(html, withVideo.length);
    const cards = cardsOf(html);
    assert.equal(Object.keys(cards).length, 14);
    for (const [slug, card] of Object.entries(cards)) {
      const has = withVideo.includes(slug);
      assert.match(card, new RegExp(`data-has-video="${has}"`), slug);
      const check = card.match(/<span class="qr-check" data-field="qr-check"[^>]*>/)[0];
      assert.equal(/\shidden(>|\s)/.test(check), !has, `${slug}: check mark ${has ? 'shown' : 'hidden'}`);
      assert.match(card, has
        ? /<span class="status status-ok" data-field="status">มีวีดีโอแล้ว<\/span>/
        : /<span class="status status-none" data-field="status">ยังไม่มีวีดีโอ<\/span>/, slug);
      assert.match(card, has ? /เปลี่ยนวีดีโอ/ : /อัปโหลดวีดีโอ/);
    }
  });
}

test('AC3: two groups (12 monthly, 2 e-card), number badges, top bar with user and actions', async () => {
  const html = await (await b.get('/admin')).text();
  const monthly = html.slice(html.indexOf('<h2 id="group-monthly">'), html.indexOf('<h2 id="group-ecard">'));
  const ecard = html.slice(html.indexOf('<h2 id="group-ecard">'));
  assert.match(monthly, /^<h2 id="group-monthly">วีดีโอรายเดือน <span class="count">12 ชุด<\/span><\/h2>/);
  assert.match(ecard, /^<h2 id="group-ecard">e-card <span class="count">2 ชุด<\/span><\/h2>/);
  assert.equal((monthly.match(/<li class="video"/g) ?? []).length, 12);
  assert.equal((ecard.match(/<li class="video"/g) ?? []).length, 2);
  const cards = cardsOf(html);
  assert.match(cards.m01, /<span class="num">01<\/span>/);
  assert.match(cards.m12, /<span class="num">12<\/span>/);
  assert.match(cards['ecard-lee'], /<span class="num">e-card<\/span>/);
  assert.match(html, /<header class="topbar">/);
  assert.match(html, /ระบบจัดการวีดีโอ/);
  assert.match(html, /เข้าสู่ระบบในชื่อ <strong>ui\.admin<\/strong>/);
  assert.match(html, /<a class="btn btn-ghost" href="\/admin\/password" aria-label="เปลี่ยนรหัสผ่าน">/);
  assert.match(html, /<button type="submit" class="btn btn-ghost" aria-label="ออกจากระบบ">/);
  assert.match(html, /<div class="toast" id="toast" role="status" aria-live="polite" hidden><\/div>/);
  // Buttons carry icons and the labels the task asks for.
  for (const text of ['ดูวีดีโอ', 'คัดลอกลิงก์', 'ดาวน์โหลด QR']) assert.match(cards.m01, new RegExp(`<svg[^>]*>.*?</svg>${text}`));
});

test('AC4: the inline QR preview is the same QR as the download (same URL and options)', async () => {
  const html = await (await b.get('/admin')).text();
  const cards = cardsOf(html);
  for (const slug of ['m01', 'ecard-lee']) {
    const inline = cards[slug].match(/<div class="qr-code" role="img" aria-label="QR Code ของ [^"]+">(<svg[\s\S]*?<\/svg>)\n?<\/div>/)[1];
    const expected = (await QRCode.toString(`${srv.url}/v/${slug}`, { errorCorrectionLevel: 'Q', margin: 4, type: 'svg' }))
      .replace(' xmlns="http://www.w3.org/2000/svg"', '');
    assert.equal(inline.trim(), expected.trim(), slug);
    const download = await (await b.get(`/admin/qr/${slug}.svg`)).text();
    assert.equal(download.replace(' xmlns="http://www.w3.org/2000/svg"', '').trim(), inline.trim());
  }
});

test('AC4: the preview needs a login and is part of the page (no attachment)', async () => {
  const anon = await new Browser(srv.url).get('/admin');
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get('location'), '/admin/login');
  const res = await b.get('/admin');
  assert.equal(res.headers.get('content-disposition'), null);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('AC4: production without PUBLIC_ORIGIN shows no QR preview (same guard as the download) and keeps the warning', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const s = await startServer(createApp({ config: { ...config, nodeEnv: 'production', publicOrigin: null }, pool, authLimits: LIMITS }));
  try {
    const pb = new Browser(s.url, { ip: '198.51.100.61' });
    pb.cookie = b.cookie;
    const html = await (await pb.get('/admin')).text();
    assert.match(html, /<p class="warning" role="alert">ยังไม่ได้ตั้งค่า PUBLIC_ORIGIN/);
    assert.doesNotMatch(html, /class="qr-code"/);
    assert.equal((html.match(/class="qr-missing"/g) ?? []).length, 14);
    assert.doesNotMatch(html, /shape-rendering="crispEdges"/, 'no QR SVG at all');
  } finally {
    await s.close();
  }
  // With PUBLIC_ORIGIN the preview uses it.
  const s2 = await startServer(createApp({ config: { ...config, nodeEnv: 'production', publicOrigin: 'https://wjasmin.example' }, pool, authLimits: LIMITS }));
  try {
    const pb = new Browser(s2.url, { ip: '198.51.100.62' });
    assert.equal((await pb.login(USER, PASSWORD, { origin: 'https://wjasmin.example' })).status, 302);
    const html = await (await pb.get('/admin')).text();
    const expected = (await QRCode.toString('https://wjasmin.example/v/m01', { errorCorrectionLevel: 'Q', margin: 4, type: 'svg' }))
      .replace(' xmlns="http://www.w3.org/2000/svg"', '').trim();
    assert.ok(cardsOf(html).m01.includes(expected));
    assert.doesNotMatch(html, /class="warning"/);
  } finally {
    await s2.close();
  }
});

test('AC1: login page — brand header, labels, show-password button, busy label, alert box', async () => {
  const anon = new Browser(srv.url, { ip: '198.51.100.63' });
  const html = await (await anon.get('/admin/login')).text();
  assert.match(html, /<main class="auth-card">/);
  assert.match(html, /<span class="brand-name">ระบบจัดการวีดีโอ<\/span><span class="brand-sub">ปฏิทิน QR วีดีโอ<\/span>/);
  assert.doesNotMatch(html, /LOXLEY/i, 'no client logo / brand');
  assert.match(html, /<label for="username">ชื่อผู้ใช้<\/label>/);
  assert.match(html, /<label for="password">รหัสผ่าน<\/label>/);
  assert.match(html, /<button type="button" class="pw-toggle" data-toggle-password="password" aria-controls="password" aria-pressed="false" aria-label="แสดงรหัสผ่าน">/);
  assert.match(html, /<button type="submit" class="btn btn-primary btn-block" data-busy-text="กำลังเข้าสู่ระบบ...">เข้าสู่ระบบ<\/button>/);
  assert.match(html, /<script src="\/assets\/forms\.js\?v=[0-9a-f]{10}" defer><\/script>/);
  const failed = await (await anon.login(USER, 'wrong password')).text();
  assert.ok(failed.includes(`<p class="alert" role="alert">${MSG.badLogin}</p>`));
});

test('AC2: change-password page — same card, three show-password buttons, back link', async () => {
  const html = await (await b.get('/admin/password')).text();
  assert.match(html, /<main class="auth-card">/);
  for (const id of ['current_password', 'new_password', 'confirm_password']) {
    assert.match(html, new RegExp(`<input class="input" id="${id}" name="${id}" type="password"`));
    assert.match(html, new RegExp(`data-toggle-password="${id}"[^>]*aria-label="แสดงรหัสผ่าน"`));
  }
  assert.match(html, /data-busy-text="กำลังบันทึก...">บันทึกรหัสผ่านใหม่<\/button>/);
  assert.match(html, /<a href="\/admin"><svg[^>]*>.*?<\/svg>กลับหน้าหลังบ้าน<\/a>/);
});

test('AC5: nothing is loaded from other sites (pages and stylesheet)', async () => {
  const pages = [
    await (await new Browser(srv.url).get('/admin/login')).text(),
    await (await b.get('/admin/password')).text(),
    await (await b.get('/admin')).text(),
  ];
  for (const html of pages) {
    assert.doesNotMatch(html, /\s(src|href|action)="(https?:)?\/\//, 'no external src/href');
    assert.doesNotMatch(html, /url\(\s*["']?(https?:)?\/\//, 'no external url()');
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|cdn\./);
  }
  const css = await readFile(path.join(APP_ROOT, 'public', 'assets', 'admin.css'), 'utf8');
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)/g)) assert.match(m[1], /^data:/, `stylesheet url(): ${m[1].slice(0, 40)}`);
  assert.doesNotMatch(css, /@import/);
});

test('AC5: Sarabun is self-hosted (Thai + Latin, 400/600, swap) with ?v= hashes; the player page does not load it', async () => {
  const html = await (await b.get('/admin')).text();
  assert.equal(SARABUN_FILES.length, 4);
  for (const { rel, weight } of SARABUN_FILES) {
    const content = await readFile(path.join(APP_ROOT, 'public', 'assets', ...rel.split('/')));
    const url = `/assets/${rel}?v=${contentHash(content)}`;
    assert.ok(html.includes(`font-weight:${weight};font-display:swap;src:url("${url}") format("woff2")`), rel);
    const res = await b.get(url);
    assert.equal(res.status, 200, rel);
    assert.match(res.headers.get('content-type'), /font\/woff2/);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(content));
  }
  const license = await readFile(path.join(APP_ROOT, 'public', 'assets', 'fonts', 'OFL-Sarabun.txt'), 'utf8');
  assert.match(license, /SIL Open Font License/);
  // The public QR page stays as light as before: no web font, no admin assets.
  const player = await (await fetch(`${srv.url}/v/m01`)).text();
  assert.doesNotMatch(player, /@font-face|\/assets\/fonts\/|admin\.css|forms\.js/);
  assert.doesNotMatch(await readFile(path.join(APP_ROOT, 'public', 'assets', 'player.css'), 'utf8'), /@font-face|url\(/);
});

// ---------------------------------------------------------------- round 2: file missing on disk

test('r2_key set but the file is gone: warning state, no check mark, not counted, upload button (page)', async () => {
  await setVideo(['m01']);
  // m02 points at a file that is not on disk (deleted by hand, bad restore...).
  await conn.query("UPDATE videos SET r2_key = 'videos/m02/1792800000000.mp4', size_bytes = 5000, updated_at = UTC_TIMESTAMP(), updated_by = 'x' WHERE slug = 'm02'");
  const html = await (await b.get('/admin')).text();
  assertSummary(html, 1); // only m01 counts
  const cards = cardsOf(html);
  const m02 = cards.m02;
  assert.match(m02, /data-has-video="false" data-file-missing="true">/);
  assert.match(m02, /<p class="file-missing" data-field="file-missing">ไฟล์วีดีโอหาย กรุณาอัปโหลดใหม่<\/p>/);
  assert.match(m02, /<span class="qr-check" data-field="qr-check" title="มีวีดีโอแล้ว" hidden>/);
  assert.match(m02, /class="status status-none" data-field="status">ยังไม่มีวีดีโอ</);
  assert.match(m02, /<span data-field="upload-text">อัปโหลดวีดีโอ<\/span>/);
  assert.match(m02, /<dd data-field="size">-<\/dd>/);
  assert.doesNotMatch(m02, /1792800000000/);
  for (const [slug, card] of Object.entries(cards)) {
    if (slug === 'm02') continue;
    assert.match(card, /data-file-missing="false">/, slug);
    assert.match(card, /<p class="file-missing" data-field="file-missing" hidden>/, slug);
  }
  assert.match(cards.m01, /data-has-video="true"/);
  // /v agrees: no player for m02.
  assert.match(await (await fetch(`${srv.url}/v/m02`)).text(), /เร็ว ๆ นี้/);
  // The warning style exists.
  const css = await readFile(path.join(APP_ROOT, 'public', 'assets', 'admin.css'), 'utf8');
  assert.match(css, /\.video\[data-file-missing="true"\]/);
});

test('r2_key set but the file is gone: GET /api/admin/videos says fileMissing, hasVideo false, no path', async () => {
  await setVideo(['m01']);
  await conn.query("UPDATE videos SET r2_key = 'videos/m02/1792800000000.mp4', size_bytes = 5000, updated_at = UTC_TIMESTAMP(), updated_by = 'x' WHERE slug = 'm02'");
  const text = await (await b.get('/api/admin/videos')).text();
  assert.doesNotMatch(text, /1792800000000|videos\/m02\//);
  const { videos } = JSON.parse(text);
  const m02 = videos.find((v) => v.slug === 'm02');
  assert.equal(m02.hasVideo, false);
  assert.equal(m02.fileMissing, true);
  assert.equal(m02.sizeBytes, null);
  assert.equal(m02.sizeLabel, '-');
  const m01 = videos.find((v) => v.slug === 'm01');
  assert.deepEqual([m01.hasVideo, m01.fileMissing], [true, false]);
  const m03 = videos.find((v) => v.slug === 'm03');
  assert.deepEqual([m03.hasVideo, m03.fileMissing], [false, false]);
});

test('uploading to a set whose file was missing clears the warning (server state)', async (t) => {
  t.mock.method(console, 'log', () => {});
  await conn.query("UPDATE videos SET r2_key = 'videos/m03/1792800000000.mp4', size_bytes = 5000 WHERE slug = 'm03'");
  const res = await b.upload('/api/admin/videos/m03', [{ blob: new Blob([fakeMp4Bytes(1200)], { type: 'video/mp4' }), name: 'a.mp4' }]);
  assert.equal(res.status, 200);
  const { video } = await res.json();
  assert.deepEqual([video.hasVideo, video.fileMissing], [true, false]);
  const html = await (await b.get('/admin')).text();
  assert.match(cardsOf(html).m03, /data-has-video="true" data-file-missing="false">/);
});
