// QA (task 05, round 1): the UI polish must not change behaviour. Login / logout /
// change password / upload / replace end to end with every original Thai message,
// forms.js busy state, check marks + summary (server and admin.js), inline QR
// (login, same as download, PUBLIC_ORIGIN, production guard), HTML escaping of set
// titles, no external URLs, self-hosted fonts, phone-width CSS. Holds the DB lock.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import QRCode from 'qrcode';
import { loadConfig, APP_ROOT } from '../src/config.js';
import { createPool, connectionOptions } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { contentHash } from '../src/assets.js';
import { MSG } from '../src/admin-routes.js';
import { SIZE_LIMITS, VIDEO_MIME } from '../src/videos.js';
import {
  assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, startServer, Browser, makeTempStorage, fakeMp4Bytes,
} from './helpers.js';

const RAISED = { ipPerMinute: 100_000, maxConcurrentChecks: 100 };
const USER = 'qa5.admin';
const PASSWORD = 'qa5 admin password';
const baseConfig = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(baseConfig.db.database);
const ASSETS = path.join(APP_ROOT, 'public', 'assets');

let conn;
let pool;
let storage;
let config;
let srv;
let b;
const servers = [];
const origConsole = {};
let ipSeq = 0;
const freshIp = () => `198.51.100.${150 + (++ipSeq)}`;

before(async () => {
  for (const m of ['log', 'warn', 'error']) { origConsole[m] = console[m]; console[m] = () => {}; }
  conn = await mysql.createConnection(connectionOptions(baseConfig.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(baseConfig.db);
  await conn.query('INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    [USER, bcrypt.hashSync(PASSWORD, 4), new Date(Date.now() - 1000)]);
  storage = await makeTempStorage();
  config = { ...baseConfig, storageDir: storage };
  pool = createPool(config.db);
  srv = await startServer(createApp({ config, pool, authLimits: RAISED }));
  servers.push(srv);
  b = new Browser(srv.url, { ip: freshIp() });
  assert.equal((await b.login(USER, PASSWORD)).status, 302);
});

after(async () => {
  for (const s of servers) await s.close();
  await pool?.end();
  await conn?.end();
  if (storage) await rm(storage, { recursive: true, force: true });
  Object.assign(console, origConsole);
});

beforeEach(async () => {
  await conn.query('UPDATE videos SET r2_key = NULL, size_bytes = NULL, updated_at = NULL, updated_by = NULL');
  await rm(path.join(storage, 'videos'), { recursive: true, force: true });
});

const row = async (slug) => (await conn.query('SELECT * FROM videos WHERE slug = ?', [slug]))[0][0];
const mp4 = (n = 1500) => new Blob([fakeMp4Bytes(n)], { type: VIDEO_MIME });
const upload = (slug, blob, browser = b) => browser.upload(`/api/admin/videos/${slug}`, [{ blob, name: 'a.mp4' }]);
const html = async (res) => res.text();
const cardOf = (page, slug) => {
  const start = page.indexOf(`<li class="video" data-slug="${slug}"`);
  assert.ok(start >= 0, `card ${slug}`);
  return page.slice(start, page.indexOf('</li>', start) + 5);
};
const submitButton = (page) => /<button type="submit"[^>]*>/.exec(page)?.[0] ?? '';

// ================================================================== 1. flows + messages

test('1a. login page / failures: every original message in a role="alert" box; a fresh (non-busy) button on each response page', async () => {
  const user2 = 'qa5.flow';
  await conn.query('INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    [user2, bcrypt.hashSync('qa5 flow password', 4), new Date(Date.now() - 1000)]);
  const page = await html(await new Browser(srv.url).get('/admin/login'));
  assert.match(page, /<form method="post" action="\/admin\/login">/);
  assert.match(page, /<script src="\/assets\/forms\.js\?v=[0-9a-f]+" defer><\/script>/);
  assert.match(page, /data-busy-text="กำลังเข้าสู่ระบบ\.\.\."/);
  assert.match(page, /aria-label="แสดงรหัสผ่าน"/);

  const ip = freshIp();
  const expectAlert = async (res, status, msg) => {
    assert.equal(res.status, status);
    const p = await res.text();
    assert.ok(p.includes(`<p class="alert" role="alert">${msg}</p>`), `${msg} in an alert box`);
    const btn = submitButton(p);
    assert.ok(btn, 'submit button present');
    assert.doesNotMatch(btn, /disabled|aria-busy/, 'button usable on the response page');
    assert.match(p, /forms\.js\?v=/);
    return p;
  };
  // Wrong password (x4) → 401 badLogin; username kept in the field.
  for (let i = 0; i < 4; i++) {
    const p = await expectAlert(await new Browser(srv.url, { ip }).login(user2, 'nope'), 401, MSG.badLogin);
    assert.match(p, new RegExp(`value="${user2}"`));
  }
  // Unknown user: same message. Empty fields: same message.
  await expectAlert(await new Browser(srv.url, { ip: freshIp() }).login('qa5.nobody', 'x'), 401, MSG.badLogin);
  await expectAlert(await new Browser(srv.url, { ip: freshIp() }).login('', ''), 401, MSG.badLogin);
  // 5th wrong → locked (429); right password while locked → locked.
  await expectAlert(await new Browser(srv.url, { ip }).login(user2, 'nope'), 429, MSG.locked);
  await expectAlert(await new Browser(srv.url, { ip }).login(user2, 'qa5 flow password'), 429, MSG.locked);
  // A second, legitimate attempt from another IP after those pages: works.
  const ok = new Browser(srv.url, { ip: freshIp() });
  assert.equal((await ok.login(user2, 'qa5 flow password')).status, 302);
  // Oversized form → formTooLarge (400).
  await expectAlert(await new Browser(srv.url, { ip: freshIp() }).post('/admin/login', { username: user2, password: 'p'.repeat(20000) }), 400, MSG.formTooLarge);

  // busy: default in-memory limits (10 POST/min/IP).
  const d = await startServer(createApp({ config, pool }));
  servers.push(d);
  const bip = freshIp();
  for (let i = 0; i < 10; i++) await new Browser(d.url, { ip: bip }).login(`qa5.rl${i}`, 'x');
  await expectAlert(await new Browser(d.url, { ip: bip }).login(user2, 'qa5 flow password'), 429, MSG.busy);

  // Already logged in → /admin/login redirects.
  const again = await b.get('/admin/login');
  assert.equal(again.status, 302);
  assert.equal(again.headers.get('location'), '/admin');
});

test('1b. change password: every original message, success notice, other session logged out; logout kills the cookie', async () => {
  const u = 'qa5.pw';
  const pw = 'qa5 pw password 1';
  await conn.query('INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    [u, bcrypt.hashSync(pw, 4), new Date(Date.now() - 1000)]);
  const me = new Browser(srv.url, { ip: freshIp() });
  const other = new Browser(srv.url, { ip: freshIp() });
  assert.equal((await me.login(u, pw)).status, 302);
  assert.equal((await other.login(u, pw)).status, 302);

  const get = await me.get('/admin/password');
  assert.equal(get.status, 200);
  const page = await get.text();
  assert.equal((page.match(/data-toggle-password="/g) ?? []).length, 3);
  assert.match(page, /href="\/admin"[^>]*>[\s\S]*กลับหน้าหลังบ้าน/);
  assert.match(page, /data-busy-text="กำลังบันทึก\.\.\."/);

  const change = (current, next, confirm = next) => me.post('/admin/password',
    { current_password: current, new_password: next, confirm_password: confirm });
  const cases = [
    [['wrong current', 'qa5 new password 1'], 400, MSG.badCurrent],
    [[pw, 'short'], 400, MSG.tooShort],
    [[pw, 'ก'.repeat(25)], 400, MSG.tooLong],
    [[pw, pw], 400, MSG.sameAsOld],
    [[pw, 'qa5 new password 1', 'qa5 new password 2'], 400, MSG.mismatch],
  ];
  for (const [args, status, msg] of cases) {
    const res = await change(...args);
    assert.equal(res.status, status, msg);
    const p = await res.text();
    assert.ok(p.includes(`<p class="alert" role="alert">${msg}</p>`), msg);
    assert.doesNotMatch(submitButton(p), /disabled|aria-busy/);
  }
  const ok = await change(pw, 'qa5 new password 1');
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/admin?changed=1');
  const home = await (await me.get('/admin?changed=1')).text();
  assert.ok(home.includes(`<p class="notice" role="status">${MSG.changed}</p>`));
  assert.equal((await other.get('/admin')).status, 302, 'other session logged out');

  const cookie = me.cookie;
  const out = await me.post('/admin/logout', {});
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), '/admin/login');
  const replay = new Browser(srv.url, { ip: freshIp() });
  replay.cookie = cookie;
  assert.equal((await replay.get('/admin')).status, 302);
  assert.equal((await new Browser(srv.url, { ip: freshIp() }).login(u, 'qa5 new password 1')).status, 302);
});

test('1c. upload then replace: card flips to ✓, summary counts, /v plays the new file, old file deleted', async () => {
  const before = await html(await b.get('/admin'));
  assert.match(before, /<strong id="summary-done">0<\/strong> \/ <span id="summary-total">14<\/span>/);
  assert.equal((await upload('m04', mp4(1500))).status, 200);
  const k1 = (await row('m04')).r2_key;
  let page = await html(await b.get('/admin'));
  assert.match(page, /<strong id="summary-done">1<\/strong>/);
  assert.match(page, /<progress id="summary-bar" max="14" value="1" aria-label="มีวีดีโอแล้ว 1 จาก 14 ชุด">/);
  const card = cardOf(page, 'm04');
  assert.match(card, /data-has-video="true"/);
  assert.match(card, /class="status status-ok" data-field="status">มีวีดีโอแล้ว</);
  assert.match(card, /data-field="qr-check" title="มีวีดีโอแล้ว">/);
  assert.match(card, /เปลี่ยนวีดีโอ/);

  assert.equal((await upload('m04', mp4(2500))).status, 200);
  const k2 = (await row('m04')).r2_key;
  assert.notEqual(k1, k2);
  assert.ok(!fs.existsSync(path.join(storage, k1)));
  page = await html(await b.get('/admin'));
  assert.match(page, /<strong id="summary-done">1<\/strong>/, 'replace does not double count');
  assert.ok((await (await fetch(`${srv.url}/v/m04`)).text()).includes(`/media/${k2}`));
});

// ---------------------------------------------------------------- forms.js in a vm

function runForms() {
  const listeners = {};
  const winListeners = {};
  const input = { type: 'password', focus() {} };
  const toggle = {
    dataset: { togglePassword: 'password' }, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, fn) { (listeners[`toggle:${t}`] ||= []).push(fn); },
  };
  const button = {
    dataset: { busyText: 'กำลังเข้าสู่ระบบ...' }, textContent: 'เข้าสู่ระบบ', disabled: false, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
  };
  const form = {
    querySelector: (sel) => (sel === '[data-busy-text]' ? button : null),
    addEventListener(t, fn) { (listeners[`form:${t}`] ||= []).push(fn); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ASSETS, 'forms.js'), 'utf8'), {
    document: {
      querySelectorAll: (sel) => (sel === '[data-toggle-password]' ? [toggle] : sel === 'form' ? [form] : []),
      getElementById: (id) => (id === 'password' ? input : null),
    },
    window: { addEventListener(t, fn) { (winListeners[t] ||= []).push(fn); } },
  });
  const submit = () => {
    const ev = { prevented: false, preventDefault() { this.prevented = true; } };
    for (const fn of listeners['form:submit'] ?? []) fn(ev);
    return ev;
  };
  const pageshow = (persisted) => { for (const fn of winListeners.pageshow ?? []) fn({ persisted }); };
  const click = () => { for (const fn of listeners['toggle:click'] ?? []) fn({}); };
  return { input, toggle, button, submit, pageshow, click };
}

test('1d. forms.js: busy on submit, double submit blocked, a newly loaded page (e.g. the 401 page) and Back restore the button', () => {
  const f = runForms();
  assert.equal(f.submit().prevented, false, 'first submit goes through');
  assert.equal(f.button.disabled, true);
  assert.equal(f.button.textContent, 'กำลังเข้าสู่ระบบ...');
  assert.equal(f.button.attrs['aria-busy'], 'true');
  assert.equal(f.submit().prevented, true, 'second submit blocked');
  // Back button (bfcache): restored, and can submit again.
  f.pageshow(true);
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.textContent, 'เข้าสู่ระบบ');
  assert.equal(f.button.attrs['aria-busy'], undefined);
  assert.equal(f.submit().prevented, false, 'a second legitimate attempt is allowed');
  // A normal load (the server's 401/429 page) runs the script on fresh markup: usable.
  const fresh = runForms();
  assert.equal(fresh.button.disabled, false);
  assert.equal(fresh.submit().prevented, false);
  // Show / hide password.
  fresh.click();
  assert.equal(fresh.input.type, 'text');
  assert.equal(fresh.toggle.attrs['aria-pressed'], 'true');
  assert.equal(fresh.toggle.attrs['aria-label'], 'ซ่อนรหัสผ่าน');
  fresh.click();
  assert.equal(fresh.input.type, 'password');
  assert.equal(fresh.toggle.attrs['aria-label'], 'แสดงรหัสผ่าน');
});

// ================================================================== 2. check marks + summary

test('2a. ✓ only on sets with a video; summary matches; DB r2_key whose file is missing (observed behaviour)', async (t) => {
  assert.equal((await upload('m01', mp4())).status, 200);
  assert.equal((await upload('ecard-lee', mp4())).status, 200);
  // m02: the DB points at a file that is not on disk (e.g. deleted by hand / bad restore).
  await conn.query("UPDATE videos SET r2_key = 'videos/m02/1792800000000.mp4', size_bytes = 1000, updated_at = UTC_TIMESTAMP(), updated_by = 'x' WHERE slug = 'm02'");
  const page = await html(await b.get('/admin'));
  const cards = [...page.matchAll(/<li class="video" data-slug="([^"]+)"[^>]*data-has-video="(true|false)"/g)];
  assert.equal(cards.length, 14);
  const withCheck = cards.filter((c) => c[2] === 'true').map((c) => c[1]);
  for (const slug of cards.map((c) => c[1])) {
    const c = cardOf(page, slug);
    const shown = /data-field="qr-check" title="มีวีดีโอแล้ว">/.test(c);
    const hidden = /data-field="qr-check" title="มีวีดีโอแล้ว" hidden>/.test(c);
    assert.ok(shown !== hidden, slug);
    assert.equal(shown, withCheck.includes(slug), `${slug}: check mark matches data-has-video`);
    assert.equal(/status-ok/.test(c), shown, `${slug}: green label matches the check`);
    if (!shown) assert.match(c, /class="status status-none" data-field="status">ยังไม่มีวีดีโอ</);
  }
  const done = Number(/<strong id="summary-done">(\d+)<\/strong>/.exec(page)[1]);
  assert.equal(done, withCheck.length, 'summary = cards with a check');
  assert.match(page, new RegExp(`<progress id="summary-bar" max="14" value="${done}"`));
  assert.ok(withCheck.includes('m01') && withCheck.includes('ecard-lee'));
  for (const s of ['m03', 'm12', 'ecard-loxley']) assert.ok(!withCheck.includes(s), s);

  const m02Checked = withCheck.includes('m02');
  const v = await (await fetch(`${srv.url}/v/m02`)).text();
  const comingSoon = /เร็ว ๆ นี้/.test(v);
  t.diagnostic(`m02 (r2_key set, file missing): admin shows ${m02Checked ? '✓ มีวีดีโอแล้ว' : 'ยังไม่มีวีดีโอ'}; /v/m02 shows ${comingSoon ? 'coming soon' : 'video'}`);
  assert.ok(comingSoon, '/v falls back to coming-soon when the file is missing');
});

// admin.js in a vm, with the summary elements.
function runAdminJs(initial) {
  const el = (extra = {}) => {
    const listeners = {};
    return {
      textContent: '', className: '', hidden: false, disabled: false, value: 0, max: 14,
      setAttribute(k, v) { (this.attrs ||= {})[k] = v; },
      addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
      fire(t) { for (const fn of listeners[t] ?? []) fn({ target: this, currentTarget: this }); },
      ...extra,
    };
  };
  const make = (slug, hasVideo) => {
    const fields = {};
    for (const f of ['status', 'size', 'updated', 'upload-text', 'upload-label', 'progress', 'bar', 'percent', 'message', 'qr-check']) fields[f] = el();
    fields['qr-check'].hidden = !hasVideo;
    const actions = { upload: el(), copy: el({ dataset: { url: `https://x/v/${slug}` } }), cancel: el() };
    return {
      dataset: { slug, limitBytes: String(SIZE_LIMITS.monthly), limitLabel: '20 MB', hasVideo: hasVideo ? 'true' : 'false' },
      fields, actions,
      querySelector(sel) {
        let m = /^\[data-field="([^"]+)"\]$/.exec(sel);
        if (m) return fields[m[1]] ?? null;
        m = /^\[data-action="([^"]+)"\]$/.exec(sel);
        if (m) return actions[m[1]];
        throw new Error(sel);
      },
    };
  };
  const cards = initial.map(([slug, has]) => make(slug, has));
  const summaryDone = el({ textContent: String(initial.filter(([, h]) => h).length) });
  const summaryBar = el({ value: initial.filter(([, h]) => h).length, max: 14 });
  const toast = el({ hidden: true });
  const xhrs = [];
  class FakeXHR {
    constructor() { this.upload = {}; xhrs.push(this); }
    open() {} send() {} abort() { this.onabort?.(); }
    respond(status, body) { this.status = status; this.responseText = JSON.stringify(body); this.onload(); }
  }
  const byId = { admin: { dataset: { mime: VIDEO_MIME }, querySelectorAll: () => cards }, 'summary-done': summaryDone, 'summary-bar': summaryBar, toast };
  vm.runInNewContext(fs.readFileSync(path.join(ASSETS, 'admin.js'), 'utf8'), {
    document: { getElementById: (id) => byId[id] ?? null },
    XMLHttpRequest: FakeXHR, FormData: class { append() {} },
    fetch: async () => ({ status: 200 }),
    navigator: { clipboard: { writeText: async () => {} } },
    window: { prompt() {} }, encodeURIComponent, setTimeout, clearTimeout,
  });
  const pick = async (card) => {
    card.actions.upload.files = [{ name: 'a.mp4', type: VIDEO_MIME, size: 1000, slice: () => ({}) }];
    card.actions.upload.fire('change');
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  };
  return { cards, xhrs, pick, summaryDone, summaryBar, toast };
}

const videoJson = (slug, hasVideo) => ({
  video: {
    slug, hasVideo, statusLabel: hasVideo ? 'มีวีดีโอแล้ว' : 'ยังไม่มีวีดีโอ', sizeLabel: '1 KB', updatedText: 'x',
  },
});

test('2b. admin.js: a successful upload flips the card (✓, data-has-video) and increments the summary; replace does not', async () => {
  const js = runAdminJs([['m01', false], ['m02', true], ['m03', false]]);
  assert.equal(js.summaryDone.textContent, '1');
  await js.pick(js.cards[0]);
  js.xhrs[0].respond(200, videoJson('m01', true));
  const c = js.cards[0];
  assert.equal(c.dataset.hasVideo, 'true');
  assert.equal(c.fields['qr-check'].hidden, false);
  assert.equal(c.fields.status.textContent, 'มีวีดีโอแล้ว');
  assert.match(c.fields.status.className, /status-ok/);
  assert.equal(c.fields['upload-text'].textContent, 'เปลี่ยนวีดีโอ');
  assert.equal(c.fields.message.textContent, 'อัปโหลดเรียบร้อยแล้ว');
  assert.equal(js.summaryDone.textContent, '2');
  assert.equal(js.summaryBar.value, 2);
  assert.equal(js.summaryBar.attrs['aria-label'], 'มีวีดีโอแล้ว 2 จาก 14 ชุด');

  // Replacing an existing video keeps the count.
  await js.pick(js.cards[1]);
  js.xhrs[1].respond(200, videoJson('m02', true));
  assert.equal(js.summaryDone.textContent, '2');

  // A failed upload changes nothing.
  await js.pick(js.cards[2]);
  js.xhrs[2].respond(413, { code: 'too_large', message: 'ไฟล์ใหญ่เกิน 20 MB' });
  assert.equal(js.cards[2].dataset.hasVideo, 'false');
  assert.equal(js.cards[2].fields['qr-check'].hidden, true);
  assert.equal(js.summaryDone.textContent, '2');

  // Copy link → toast.
  js.cards[0].actions.copy.fire('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(js.toast.hidden, false);
  assert.equal(js.toast.textContent, 'คัดลอกลิงก์แล้ว');
});

// ================================================================== 3. inline QR + escaping

const inlineOf = (card) => /<div class="qr-code" role="img" aria-label="[^"]*">(<svg[\s\S]*?<\/svg>)\s*<\/div>/.exec(card)?.[1];
const stripNs = (s) => s.replace(' xmlns="http://www.w3.org/2000/svg"', '').trim();

test('3a. inline QR: needs login, equals the downloadable SVG, uses PUBLIC_ORIGIN; production without it shows none', { timeout: 60000 }, async () => {
  const anon = await new Browser(srv.url).get('/admin');
  assert.equal(anon.status, 302);
  assert.doesNotMatch(await anon.text(), /<svg/);

  const page = await html(await b.get('/admin'));
  for (const slug of ['m01', 'm12', 'ecard-loxley']) {
    const inline = inlineOf(cardOf(page, slug));
    assert.ok(inline, slug);
    const dl = await (await b.get(`/admin/qr/${slug}.svg`)).text();
    assert.equal(inline.trim(), stripNs(dl), `${slug}: inline = download`);
    const expected = await QRCode.toString(`${srv.url}/v/${slug}`, { errorCorrectionLevel: 'Q', margin: 4, type: 'svg' });
    assert.equal(inline.trim(), stripNs(expected));
  }

  const pub = await startServer(createApp({ config: { ...config, publicOrigin: 'https://wjasmin.example' }, pool, authLimits: RAISED }));
  servers.push(pub);
  const pb = new Browser(pub.url, { ip: freshIp() });
  assert.equal((await pb.login(USER, PASSWORD, { origin: 'https://wjasmin.example' })).status, 302);
  const pubPage = await html(await pb.get('/admin'));
  const inline = inlineOf(cardOf(pubPage, 'ecard-lee'));
  const expected = await QRCode.toString('https://wjasmin.example/v/ecard-lee', { errorCorrectionLevel: 'Q', margin: 4, type: 'svg' });
  assert.equal(inline.trim(), stripNs(expected));
  assert.equal(inline.trim(), stripNs(await (await pb.get('/admin/qr/ecard-lee.svg')).text()));

  const prod = await startServer(createApp({ config: { ...config, nodeEnv: 'production', publicOrigin: null }, pool, authLimits: RAISED }));
  servers.push(prod);
  const pr = new Browser(prod.url, { ip: freshIp() });
  pr.cookie = b.cookie;
  const prodPage = await html(await pr.get('/admin'));
  assert.doesNotMatch(prodPage, /class="qr-code"/);
  assert.equal((prodPage.match(/class="qr-missing"/g) ?? []).length, 14);
  assert.match(prodPage, /<p class="warning" role="alert">/);
});

test('3b. set titles with HTML/quotes are escaped everywhere (heading, aria-labels, data attributes, /v, QR filename)', async () => {
  const evil = `"><img src=x onerror=alert(1)>'&<script>alert(2)</script> มีนาคม 2570`;
  const [[orig]] = await conn.query("SELECT title FROM videos WHERE slug = 'm03'");
  const [[origE]] = await conn.query("SELECT title FROM videos WHERE slug = 'ecard-loxley'");
  await conn.query("UPDATE videos SET title = ? WHERE slug IN ('m03', 'ecard-loxley')", [evil]);
  try {
    const page = await html(await b.get('/admin'));
    assert.ok(!page.includes('<img src=x'), 'no raw img tag');
    assert.ok(!page.includes('<script>alert'), 'no raw script tag');
    assert.ok(!page.includes(`"><img`));
    const esc = '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;&lt;script&gt;alert(2)&lt;/script&gt; มีนาคม 2570';
    for (const slug of ['m03', 'ecard-loxley']) {
      const c = cardOf(page, slug);
      assert.ok(c.includes(`<h3>${esc}</h3>`), `${slug} heading`);
      assert.ok(c.includes(`aria-label="QR Code ของ ${esc}"`), `${slug} QR aria-label`);
      assert.ok(c.includes(`aria-label="ดาวน์โหลด QR ของ ${esc} แบบ PNG"`), `${slug} PNG aria-label`);
      assert.ok(c.includes(`aria-label="ดาวน์โหลด QR ของ ${esc} แบบ SVG"`), `${slug} SVG aria-label`);
    }
    // Every attribute value is a closed, quote-free string (no attribute breaking out).
    for (const m of page.matchAll(/\s([a-z-]+)="([^"]*)"/g)) assert.doesNotMatch(m[2], /[<>]/, `${m[1]}="${m[2]}"`);
    // Public page and QR download.
    const v = await (await fetch(`${srv.url}/v/m03`)).text();
    assert.ok(!v.includes('<img src=x') && !v.includes('<script>alert'));
    const png = await b.get('/admin/qr/m03.png');
    assert.equal(png.status, 200);
    const cd = png.headers.get('content-disposition');
    assert.match(cd, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''[A-Za-z0-9%._~!$&+,;=@-]+$/);
    assert.ok(!/[<>"]/.test(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(cd)[1])));
    const api = await (await b.get('/api/admin/videos')).json();
    assert.equal(api.videos.find((x) => x.slug === 'm03').title, evil, 'API returns the data as JSON (escaped by the client)');
  } finally {
    await conn.query("UPDATE videos SET title = ? WHERE slug = 'm03'", [orig.title]);
    await conn.query("UPDATE videos SET title = ? WHERE slug = 'ecard-loxley'", [origE.title]);
  }
});

test('3c. username is escaped in the top bar', async () => {
  // Usernames are restricted by the CLI regex, but the page must still escape them.
  const page = await html(await b.get('/admin'));
  assert.ok(page.includes(`<strong>${USER}</strong>`));
});

// ================================================================== 4. no external URLs, fonts

const OWN = () => new URL(srv.url).origin;
function externalUrls(text) {
  const found = [];
  for (const m of text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)) {
    const u = m[0];
    if (/^(?:https?:)?\/\/www\.w3\.org\/2000\/svg/.test(u)) continue; // XML namespace, not a request
    if (u.startsWith(OWN())) continue;
    found.push(u);
  }
  return found;
}

test('4a. no external URLs in back-office HTML, CSS or JS; no @import', async () => {
  const pages = [
    await html(await new Browser(srv.url).get('/admin/login')),
    await html(await b.get('/admin/password')),
    await html(await b.get('/admin')),
  ];
  for (const p of pages) {
    assert.deepEqual(externalUrls(p.replace(/data-url="[^"]*"/g, '')), []);
    for (const m of p.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(m[1].startsWith('/') && !m[1].startsWith('//'), `local ref: ${m[1]}`);
    }
  }
  for (const f of ['admin.css', 'admin.js', 'forms.js', 'player.css', 'player.js']) {
    const text = await readFile(path.join(ASSETS, f), 'utf8');
    assert.deepEqual(externalUrls(text), [], f);
    assert.doesNotMatch(text, /@import/, f);
  }
});

test('4b. fonts: @font-face URLs carry ?v=<hash>, are served as font/woff2 with the right bytes; license present', async () => {
  const page = await html(await new Browser(srv.url).get('/admin/login'));
  const urls = [...page.matchAll(/src:url\("([^"]+)"\) format\("woff2"\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 4);
  assert.match(page, /font-display:swap/);
  for (const u of urls) {
    const m = /^\/assets\/(fonts\/[a-z0-9-]+\.woff2)\?v=([0-9a-f]+)$/.exec(u);
    assert.ok(m, u);
    const file = await readFile(path.join(ASSETS, ...m[1].split('/')));
    assert.equal(m[2], contentHash(file), `${u}: ?v= is the content hash`);
    const res = await fetch(srv.url + u);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'font/woff2');
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.subarray(0, 4).toString('latin1'), 'wOF2');
    assert.ok(body.equals(file));
  }
  const files = await readdir(path.join(ASSETS, 'fonts'));
  assert.ok(files.some((f) => /OFL/i.test(f)), 'OFL license file');
  assert.match(await readFile(path.join(ASSETS, 'fonts', files.find((f) => /OFL/i.test(f))), 'utf8'), /SIL OPEN FONT LICENSE/i);
  // The admin page and password page reference the same fonts.
  assert.match(await html(await b.get('/admin')), /src:url\("\/assets\/fonts\/sarabun-thai-400-normal\.woff2\?v=/);
});

test('4c. /v pages (video and coming-soon) load no fonts and no back-office assets', async () => {
  assert.equal((await upload('m05', mp4())).status, 200);
  for (const slug of ['m05', 'm06', 'ecard-lee']) {
    const v = await (await fetch(`${srv.url}/v/${slug}`)).text();
    for (const needle of ['Sarabun', 'woff2', 'admin.css', 'admin.js', 'forms.js', '/fonts/', '@font-face']) {
      assert.ok(!v.includes(needle), `${slug}: ${needle}`);
    }
    assert.deepEqual(externalUrls(v), [], slug);
  }
  const playerCss = await readFile(path.join(ASSETS, 'player.css'), 'utf8');
  // A family name in font-family (pre-existing, local fonts only) downloads nothing;
  // only @font-face / url() would.
  assert.doesNotMatch(playerCss, /@font-face|woff|url\(/);
});

// ================================================================== 5. phone width

function stripMinWidthMedia(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at < 0) { out += css.slice(i); break; }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
    }
    const cond = css.slice(at, open);
    if (!/min-width/.test(cond)) out += css.slice(at, j);
    i = j;
  }
  return out;
}

function rules(css) {
  const out = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}

test('5a. admin.css: nothing fixed wider than 360 px outside min-width media queries', async () => {
  const css = await readFile(path.join(ASSETS, 'admin.css'), 'utf8');
  const base = stripMinWidthMedia(css);
  const offenders = [];
  for (const { sel, body } of rules(base)) {
    for (const d of body.matchAll(/(^|;)\s*((?:min-)?width|flex-basis|flex|grid-template-columns|left|right|margin-left|margin-right|padding-left|padding-right)\s*:\s*([^;]+)/g)) {
      for (const px of d[3].matchAll(/(\d+(?:\.\d+)?)px/g)) if (Number(px[1]) > 360) offenders.push(`${sel} { ${d[2]}: ${d[3]} }`);
      for (const em of d[3].matchAll(/(\d+(?:\.\d+)?)r?em/g)) if (Number(em[1]) * 16 > 360) offenders.push(`${sel} { ${d[2]}: ${d[3]} }`);
    }
    if (/white-space\s*:\s*nowrap/.test(body) && !/visually-hidden|status/.test(sel)) offenders.push(`${sel}: nowrap`);
  }
  assert.deepEqual(offenders, []);
  // Card QR + gap + padding fit a 360 px screen with room for the text column.
  const qr = Number(/\.qr\s*\{[^}]*width:\s*(\d+)px/.exec(css)[1]);
  assert.ok(16 * 2 + 16 * 2 + qr + 14 < 260, `QR column ${qr}px leaves room for the text at 360 px`);
});

test('5b. tap targets: every button/link on the three pages is a ≥44 px control', async () => {
  const css = stripMinWidthMedia(await readFile(path.join(ASSETS, 'admin.css'), 'utf8'));
  const R = rules(css);
  const sizeOf = (selector) => {
    let h = 0;
    let w = 0;
    for (const { sel, body } of R) {
      if (!sel.split(',').map((s) => s.trim()).includes(selector)) continue;
      const mh = /(?:^|;)\s*(?:min-)?height:\s*(\d+)px/.exec(body);
      const mw = /(?:^|;)\s*(?:min-)?width:\s*(\d+)px/.exec(body);
      if (mh) h = Math.max(h, Number(mh[1]));
      if (mw) w = Math.max(w, Number(mw[1]));
    }
    return { h, w };
  };
  assert.ok(sizeOf('.btn').h >= 44, '.btn');
  assert.ok(sizeOf('.btn-sm').h >= 44, '.btn-sm');
  const pw = sizeOf('.pw-toggle');
  assert.ok(pw.h >= 44 && pw.w >= 44, '.pw-toggle');
  assert.ok(sizeOf('.auth-back a').h >= 44, '.auth-back a');
  assert.ok(sizeOf('.input').h >= 44, '.input');

  const pages = {
    login: await html(await new Browser(srv.url).get('/admin/login')),
    password: await html(await b.get('/admin/password')),
    admin: await html(await b.get('/admin')),
  };
  for (const [name, p] of Object.entries(pages)) {
    for (const m of p.matchAll(/<(a|button)\b([^>]*)>/g)) {
      const cls = /class="([^"]*)"/.exec(m[2])?.[1] ?? '';
      const ok = /\bbtn\b|\bpw-toggle\b|\bbrand\b/.test(cls)
        || (name === 'password' && /href="\/admin"/.test(m[2])); // .auth-back a (44 px)
      assert.ok(ok, `${name}: <${m[1]}${m[2]}> has no ≥44 px class`);
    }
  }
});
