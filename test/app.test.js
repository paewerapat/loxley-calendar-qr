// AC2, AC6 (DB down), AC7, AC8. These tests never connect to a real database.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { loadConfig, APP_ROOT } from '../src/config.js';
import { startServer, closedPort } from './helpers.js';

const STACK_MARKER = 'boom-from-test-route';

function makeConfig(nodeEnv) {
  return loadConfig({
    NODE_ENV: nodeEnv,
    PORT: '0',
    DB_HOST: '127.0.0.1',
    DB_NAME: 'loxley_unreachable_test',
    DB_USERNAME: 'nobody',
    DB_PASSWORD: 'not-a-real-password',
    STORAGE_DIR: '../qr-storage', SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  });
}

function throwingRoutes(app) {
  app.get('/__test/throw', () => {
    throw new Error(STACK_MARKER);
  });
  app.get('/__test/reject', async () => {
    throw new Error(STACK_MARKER);
  });
}

let prod; // production-mode server whose DB is unreachable
let dev;
let deadPool;

before(async () => {
  const config = makeConfig('production');
  config.db.port = await closedPort();
  deadPool = createPool(config.db);
  prod = await startServer(createApp({ config, pool: deadPool, extraRoutes: throwingRoutes }));
  dev = await startServer(createApp({ config: makeConfig('development'), pool: deadPool, extraRoutes: throwingRoutes }));
});

after(async () => {
  await prod?.close();
  await dev?.close();
  await deadPool?.end().catch(() => {});
});

test('trust proxy is 1', () => {
  const app = createApp({ config: makeConfig('production'), pool: deadPool });
  assert.equal(app.get('trust proxy'), 1);
});

test('GET /healthz → 503 {"ok":false,"db":false} when the DB is unreachable, no details leaked', async (t) => {
  t.mock.method(console, 'error', () => {});
  const res = await fetch(`${prod.url}/healthz`);
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { ok: false, db: false });
  assert.doesNotMatch(text, /ECONNREFUSED|Error|127\.0\.0\.1|nobody/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('GET /robots.txt is served from public/', async () => {
  const res = await fetch(`${prod.url}/robots.txt`);
  assert.equal(res.status, 200);
  const expected = await readFile(path.join(APP_ROOT, 'public', 'robots.txt'), 'utf8');
  assert.equal(await res.text(), expected);
  assert.match(expected, /Disallow: \/admin/);
});

for (const p of ['/app.js', '/package.json', '/package-lock.json', '/src/config.js', '/.env.local', '/.env.test',
  '/migrations/001_create_videos.sql', '/public/robots.txt', '/node_modules/express/package.json']) {
  test(`GET ${p} → 404 (only public/ is served)`, async () => {
    const res = await fetch(`${prod.url}${p}`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
}

test('path traversal out of public/ → 404', async () => {
  for (const p of ['/..%2fapp.js', '/%2e%2e/package.json', '/..%5capp.js']) {
    const res = await fetch(`${prod.url}${p}`);
    assert.ok([400, 403, 404].includes(res.status), `${p} → ${res.status}`);
    const body = await res.text();
    assert.doesNotMatch(body, /createApp|"dependencies"/);
  }
});

test('unknown path → 404 Thai HTML page, black background, gold text', async () => {
  const res = await fetch(`${prod.url}/no-such-page`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /text\/html; charset=utf-8/);
  const html = await res.text();
  assert.match(html, /<html lang="th">/);
  assert.match(html, /ไม่พบหน้า/);
  assert.match(html, /background: #000/);
  assert.match(html, /color: #d4af37/);
});

test('POST to unknown path → 404 too', async () => {
  const res = await fetch(`${prod.url}/no-such-page`, { method: 'POST' });
  assert.equal(res.status, 404);
});

for (const route of ['/__test/throw', '/__test/reject']) {
  test(`production: unexpected error (${route}) → 500 Thai HTML without stack trace`, async (t) => {
    t.mock.method(console, 'error', () => {}); // keep test output clean
    const res = await fetch(`${prod.url}${route}`);
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<html lang="th">/);
    assert.match(html, /ระบบขัดข้อง/);
    assert.ok(!html.includes(STACK_MARKER));
    assert.doesNotMatch(html, /\bat .*\.js:\d+/);
  });
}

test('NODE_ENV unset: 500 page has no stack trace (fails closed)', async (t) => {
  t.mock.method(console, 'error', () => {});
  const srv = await startServer(createApp({ config: makeConfig(undefined), pool: deadPool, extraRoutes: throwingRoutes }));
  try {
    const res = await fetch(`${srv.url}/__test/throw`);
    assert.equal(res.status, 500);
    const html = await res.text();
    assert.match(html, /ระบบขัดข้อง/);
    assert.ok(!html.includes(STACK_MARKER));
  } finally {
    await srv.close();
  }
});

test('development: 500 page includes the (escaped) stack for debugging', async (t) => {
  t.mock.method(console, 'error', () => {});
  const res = await fetch(`${dev.url}/__test/throw`);
  assert.equal(res.status, 500);
  assert.ok((await res.text()).includes(STACK_MARKER));
});

test('no X-Powered-By header', async () => {
  const res = await fetch(`${prod.url}/robots.txt`);
  assert.equal(res.headers.get('x-powered-by'), null);
});
