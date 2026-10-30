// Task 04 AC2: behaviour of public/assets/admin.js (browser-side checks, XHR upload
// with progress / cancel, no double submit, card update), run in a vm with a tiny
// fake DOM. Real phones are still checked by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { APP_ROOT } from '../src/config.js';
import { SIZE_LIMITS, formatSize } from '../src/videos.js';

const ADMIN_JS = await readFile(path.join(APP_ROOT, 'public', 'assets', 'admin.js'), 'utf8');

function el(attrs = {}, extra = {}) {
  const listeners = {};
  const store = { ...attrs };
  return {
    textContent: '', className: '', hidden: false, disabled: false, value: '', onclick: null,
    attrs: store,
    setAttribute(k, v) { store[k] = String(v); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, event = {}) { for (const fn of listeners[type] ?? []) fn({ target: this, currentTarget: this, ...event }); },
    ...extra,
  };
}

function makeCard(slug, kind) {
  const fields = {};
  for (const f of ['status', 'size', 'updated', 'upload-text', 'upload-label', 'progress', 'bar', 'percent', 'message']) {
    fields[f] = el();
  }
  fields.progress.hidden = true;
  const actions = { upload: el(), copy: el({}, { dataset: { url: `https://site.example/v/${slug}` } }), cancel: el() };
  const card = {
    dataset: { slug, limitBytes: String(SIZE_LIMITS[kind]), limitLabel: formatSize(SIZE_LIMITS[kind]) },
    fields,
    actions,
    querySelector(sel) {
      let m = /^\[data-field="([^"]+)"\]$/.exec(sel);
      if (m) return fields[m[1]] ?? null;
      m = /^\[data-action="([^"]+)"\]$/.exec(sel);
      if (m) return actions[m[1]] ?? null;
      throw new Error(`unsupported selector ${sel}`);
    },
  };
  return card;
}

function setup({ ping = 200, page = null } = {}) {
  const cards = [makeCard('m01', 'monthly'), makeCard('ecard-lee', 'ecard')];
  if (page) { // task 05 page parts: check mark per card, summary, toast
    for (const c of cards) { c.fields['qr-check'] = el({}, { hidden: true }); c.dataset.hasVideo = 'false'; }
  }
  const root = {
    dataset: { mime: 'video/mp4' },
    querySelectorAll: (sel) => { assert.equal(sel, '[data-slug]'); return cards; },
  };
  const xhrs = [];
  class FakeXHR {
    constructor() { this.upload = {}; this.aborted = false; xhrs.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    send(body) { this.body = body; }
    abort() { this.aborted = true; this.onabort?.(); }
    respond(status, body) { this.status = status; this.responseText = typeof body === 'string' ? body : JSON.stringify(body); this.onload(); }
  }
  class FakeFormData {
    constructor() { this.entries = []; }
    append(...args) { this.entries.push(args); }
  }
  const fetches = [];
  const clipboard = [];
  const ctx = {
    document: { getElementById: (id) => (id === 'admin' ? root : page?.[id] ?? null) },
    ...(page ? { setTimeout: (fn) => { page.timers.push(fn); return page.timers.length; }, clearTimeout: () => {} } : {}),
    XMLHttpRequest: FakeXHR,
    FormData: FakeFormData,
    fetch: async (url, opts) => { fetches.push({ url, opts }); return { status: ping }; },
    navigator: { clipboard: { writeText: async (t) => { clipboard.push(t); } } },
    window: { prompt: () => {} },
    encodeURIComponent,
  };
  vm.runInNewContext(ADMIN_JS, ctx);
  return { cards, xhrs, fetches, clipboard };
}

const flush = () => new Promise((r) => setImmediate(r));
const file = (name, type, size) => ({ name, type, size, slice: (a, b, t) => ({ sliced: true, a, b, type: t }) });

async function pick(card, f) {
  card.actions.upload.files = [f];
  card.actions.upload.fire('change');
  await flush();
}

test('too big for this set → Thai message with the server-sent limit, nothing sent', async () => {
  const { cards, xhrs, fetches } = setup();
  await pick(cards[0], file('a.mp4', 'video/mp4', SIZE_LIMITS.monthly + 1));
  assert.match(cards[0].fields.message.textContent, /^ไฟล์ใหญ่เกิน 40 MB/);
  assert.equal(cards[0].fields.message.className, 'msg error');
  assert.equal(xhrs.length, 0);
  assert.equal(fetches.length, 0);
  // The e-card limit is its own (100 MiB): the same size is fine there.
  await pick(cards[1], file('a.mp4', 'video/mp4', SIZE_LIMITS.monthly + 1));
  assert.equal(xhrs.length, 1);
});

test('not an MP4 → Thai message, nothing sent', async () => {
  const { cards, xhrs } = setup();
  await pick(cards[0], file('clip.mov', 'video/quicktime', 1000));
  assert.match(cards[0].fields.message.textContent, /ไม่ใช่วีดีโอ MP4/);
  await pick(cards[0], file('notes.txt', '', 10));
  assert.match(cards[0].fields.message.textContent, /ไม่ใช่วีดีโอ MP4/);
  assert.equal(xhrs.length, 0);
});

test('a .mp4 without a browser type is sent labelled video/mp4', async () => {
  const { cards, xhrs } = setup();
  await pick(cards[0], file('phone.MP4', '', 1000));
  const [field, blob, name] = xhrs[0].body.entries[0];
  assert.equal(field, 'file');
  assert.equal(name, 'phone.MP4');
  assert.deepEqual(blob, { sliced: true, a: 0, b: 1000, type: 'video/mp4' });
});

test('upload: session check, POST via XHR, % progress, no double submit, card updated on success', async () => {
  const { cards, xhrs, fetches } = setup();
  const [m01, ecard] = cards;
  await pick(m01, file('a.mp4', 'video/mp4', 5000));
  assert.equal(fetches[0].url, '/api/admin/videos');
  assert.equal(xhrs.length, 1);
  assert.equal(xhrs[0].method, 'POST');
  assert.equal(xhrs[0].url, '/api/admin/videos/m01');
  assert.equal(m01.fields.progress.hidden, false);
  for (const c of cards) {
    assert.equal(c.actions.upload.disabled, true, 'every upload button disabled while uploading');
    assert.equal(c.fields['upload-label'].attrs['aria-disabled'], 'true');
  }
  xhrs[0].upload.onprogress({ lengthComputable: true, loaded: 2500, total: 5000 });
  assert.equal(m01.fields.bar.value, 50);
  assert.equal(m01.fields.percent.textContent, '50%');

  await pick(ecard, file('b.mp4', 'video/mp4', 10));
  assert.equal(xhrs.length, 1, 'no second upload while one is running');
  assert.match(ecard.fields.message.textContent, /กำลังอัปโหลดไฟล์อื่นอยู่/);

  xhrs[0].respond(200, { video: {
    statusLabel: 'มีวีดีโอแล้ว', hasVideo: true, sizeLabel: '4.9 KiB', updatedText: '25 ต.ค. 2569 17:00 น. โดย client',
  } });
  assert.equal(m01.fields.status.textContent, 'มีวีดีโอแล้ว');
  assert.equal(m01.fields.status.className, 'status status-ok');
  assert.equal(m01.fields.size.textContent, '4.9 KiB');
  assert.equal(m01.fields.updated.textContent, '25 ต.ค. 2569 17:00 น. โดย client');
  assert.equal(m01.fields['upload-text'].textContent, 'เปลี่ยนวีดีโอ');
  assert.equal(m01.fields.message.textContent, 'อัปโหลดเรียบร้อยแล้ว');
  assert.equal(m01.fields.progress.hidden, true);
  for (const c of cards) assert.equal(c.actions.upload.disabled, false);
});

test('server / network errors become Thai messages', async () => {
  const cases = [
    [413, { code: 'too_large', message: 'ไฟล์ใหญ่เกิน 40 MB (วีดีโอรายเดือนรับได้ไม่เกิน 40 MB)' }, /^ไฟล์ใหญ่เกิน 40 MB \(/],
    [415, { code: 'not_mp4', message: 'ไฟล์นี้ไม่ใช่วีดีโอ MP4 กรุณาเลือกไฟล์ .mp4' }, /ไม่ใช่วีดีโอ MP4/],
    [413, '<html>413 Request Entity Too Large</html>', /^ไฟล์ใหญ่เกิน 40 MB/], // from nginx
    [401, { error: 'unauthorized' }, /หมดเวลาล็อกอิน/],
    [500, '<html>error</html>', /ระบบขัดข้อง/],
    [507, { code: 'storage_full', message: 'พื้นที่เก็บไฟล์บนเซิร์ฟเวอร์เต็ม กรุณาติดต่อผู้ดูแลระบบ' }, /พื้นที่เก็บไฟล์/],
  ];
  for (const [status, body, expected] of cases) {
    const { cards, xhrs } = setup();
    await pick(cards[0], file('a.mp4', 'video/mp4', 10));
    xhrs[0].respond(status, body);
    assert.match(cards[0].fields.message.textContent, expected, `${status}`);
    assert.equal(cards[0].fields.message.className, 'msg error');
    assert.equal(cards[0].actions.upload.disabled, false);
  }
  const { cards, xhrs } = setup();
  await pick(cards[0], file('a.mp4', 'video/mp4', 10));
  xhrs[0].onerror();
  assert.match(cards[0].fields.message.textContent, /การเชื่อมต่อขาดหาย/);
});

test('at 100% sent it says "กำลังบันทึก..." until the server answers', async () => {
  const { cards, xhrs } = setup();
  await pick(cards[0], file('a.mp4', 'video/mp4', 10));
  xhrs[0].upload.onprogress({ lengthComputable: true, loaded: 9, total: 10 });
  assert.match(cards[0].fields.message.textContent, /กำลังอัปโหลด/);
  xhrs[0].upload.onprogress({ lengthComputable: true, loaded: 10, total: 10 });
  assert.equal(cards[0].fields.percent.textContent, '100%');
  assert.equal(cards[0].fields.message.textContent, 'กำลังบันทึก...');
  xhrs[0].respond(200, { video: { statusLabel: 'มีวีดีโอแล้ว', hasVideo: true, sizeLabel: '10 bytes', updatedText: 'x' } });
  assert.equal(cards[0].fields.message.textContent, 'อัปโหลดเรียบร้อยแล้ว');
});

test('cancel aborts the XHR', async () => {
  const { cards, xhrs } = setup();
  await pick(cards[0], file('a.mp4', 'video/mp4', 10));
  cards[0].actions.cancel.onclick();
  assert.equal(xhrs[0].aborted, true);
  assert.equal(cards[0].fields.message.textContent, 'ยกเลิกการอัปโหลดแล้ว');
  assert.equal(cards[0].fields.progress.hidden, true);
});

test('expired login is detected before sending the file', async () => {
  const { cards, xhrs } = setup({ ping: 401 });
  await pick(cards[0], file('a.mp4', 'video/mp4', 10));
  assert.equal(xhrs.length, 0);
  assert.match(cards[0].fields.message.textContent, /หมดเวลาล็อกอิน/);
  assert.equal(cards[0].actions.upload.disabled, false);
});

test('copy link uses the clipboard', async () => {
  const { cards, clipboard } = setup();
  cards[0].actions.copy.fire('click');
  await flush();
  assert.deepEqual(clipboard, ['https://site.example/v/m01']);
  assert.equal(cards[0].fields.message.textContent, 'คัดลอกลิงก์แล้ว');
});

// Task 05 ---------------------------------------------------------------------

function pageParts() {
  return {
    'summary-done': el(),
    'summary-bar': el({}, { value: 0, max: 14 }),
    toast: el({}, { hidden: true }),
    timers: [],
  };
}

test('after a successful upload: green state + check mark on the QR, summary count goes up, no reload', async () => {
  const page = pageParts();
  const { cards, xhrs } = setup({ page });
  const [m01, ecard] = cards;
  ecard.dataset.hasVideo = 'true'; // e.g. production today: e-card Lee already has a video
  await pick(m01, file('a.mp4', 'video/mp4', 10));
  xhrs[0].respond(200, { video: { statusLabel: 'มีวีดีโอแล้ว', hasVideo: true, sizeLabel: '10 bytes', updatedText: 'x' } });
  assert.equal(m01.dataset.hasVideo, 'true');
  assert.equal(m01.fields['qr-check'].hidden, false, 'check mark shown');
  assert.equal(m01.fields.status.className, 'status status-ok');
  assert.equal(page['summary-done'].textContent, '2');
  assert.equal(page['summary-bar'].value, 2);
  assert.equal(page['summary-bar'].attrs['aria-label'], 'มีวีดีโอแล้ว 2 จาก 14 ชุด');
});

test('copy link also shows a toast "คัดลอกลิงก์แล้ว" that hides itself', async () => {
  const page = pageParts();
  const { cards, clipboard } = setup({ page });
  cards[0].actions.copy.fire('click');
  await flush();
  assert.deepEqual(clipboard, ['https://site.example/v/m01']);
  assert.equal(page.toast.textContent, 'คัดลอกลิงก์แล้ว');
  assert.equal(page.toast.hidden, false);
  page.timers.at(-1)();
  assert.equal(page.toast.hidden, true);
});

test('a card whose file was missing loses the warning after a successful upload', async () => {
  const page = pageParts();
  const { cards, xhrs } = setup({ page });
  const [m01] = cards;
  m01.dataset.fileMissing = 'true';
  m01.fields['file-missing'] = el({}, { hidden: false });
  await pick(m01, file('a.mp4', 'video/mp4', 10));
  xhrs[0].respond(200, { video: { statusLabel: 'มีวีดีโอแล้ว', hasVideo: true, fileMissing: false, sizeLabel: '10 bytes', updatedText: 'x' } });
  assert.equal(m01.dataset.fileMissing, 'false');
  assert.equal(m01.fields['file-missing'].hidden, true);
  assert.equal(m01.fields['qr-check'].hidden, false);
  assert.equal(page['summary-done'].textContent, '1');
});
