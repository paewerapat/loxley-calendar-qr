// QA (task 02): extra black-box cases for /v and /media that the developer's tests
// do not reach. Raw http.request is used because fetch() normalises "%2e%2e".
// Q1-Q3 were reported as { todo } in task 02 round 1 and fixed in round 2.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig, ConfigError, APP_ROOT } from '../src/config.js';
import { makeTempStorage, fakeMp4Bytes, writeStorageFile, fakePool, startServer } from './helpers.js';

const KEY = 'videos/ecard-lee/1792832980.mp4';
const SIZE = 3000;
const ROWS = [
  { slug: 'ecard-lee', title: 'e-card ปีใหม่ Lee', kind: 'ecard', r2_key: KEY },
  { slug: 'm01', title: 'มกราคม 2570', kind: 'monthly', r2_key: null },
];

let storage;
let outside;
let srv;
let port;

function baseEnv(storageDir) {
  return {
    NODE_ENV: 'production', PORT: '0', DB_HOST: '127.0.0.1', DB_NAME: 'unused_test',
    DB_USERNAME: 'x', DB_PASSWORD: 'x', STORAGE_DIR: storageDir,
  };
}

before(async () => {
  storage = await makeTempStorage();
  outside = await makeTempStorage();
  await writeStorageFile(storage, KEY, fakeMp4Bytes(SIZE));
  // A whole directory symlink under videos/ that points outside STORAGE_DIR.
  await mkdir(path.join(outside, 'escape'), { recursive: true });
  await writeFile(path.join(outside, 'escape', '1792832990.mp4'), fakeMp4Bytes(64));
  await symlink(path.join(outside, 'escape'), path.join(storage, 'videos', 'linkout'));
  srv = await startServer(createApp({ config: loadConfig(baseEnv(storage)), pool: fakePool(ROWS) }));
  port = new URL(srv.url).port;
});

after(async () => {
  await srv?.close();
  for (const d of [storage, outside]) if (d) await rm(d, { recursive: true, force: true });
});

function raw(method, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('AC1: query strings added by scanner / LINE apps still give the same page (no redirect)', async () => {
  const plain = await raw('GET', '/v/ecard-lee/');
  assert.equal(plain.status, 200);
  for (const p of ['/v/ecard-lee?fbclid=abc', '/v/ecard-lee/?openExternalBrowser=1', '/v/ecard-lee/?utm_source=qr&x=%2e%2e']) {
    const res = await raw('GET', p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.location, undefined, p);
    assert.equal(res.body, plain.body, p);
  }
});

test('AC1: HEAD /v/ecard-lee/ → 200 with no-cache', async () => {
  const res = await raw('HEAD', '/v/ecard-lee/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-cache');
});

for (const p of ['/v/%2e%2e', '/v/%2E%2E', '/v/.%2e']) {
  test(`AC1: raw ${p} → Thai 404 (no redirect)`, async () => {
    const res = await raw('GET', p);
    assert.equal(res.status, 404);
    assert.match(res.body, /<html lang="th">/);
  });
}

test('AC5: a directory symlink under videos/ pointing outside STORAGE_DIR → 404, no leak', async () => {
  const res = await raw('GET', '/media/videos/linkout/1792832990.mp4');
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes(outside));
  assert.ok(!res.body.includes(storage));
  assert.notEqual(res.headers['content-type'], 'video/mp4');
});

test('AC5: HEAD with Range → 206 + Content-Range, suffix range works', async () => {
  const head = await raw('HEAD', `/media/${KEY}`, { Range: 'bytes=0-99' });
  assert.equal(head.status, 206);
  assert.equal(head.headers['content-range'], `bytes 0-99/${SIZE}`);
  assert.equal(head.body, '');
  const suffix = await raw('GET', `/media/${KEY}`, { Range: 'bytes=-10' });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], `bytes ${SIZE - 10}-${SIZE - 1}/${SIZE}`);
});

test('AC5: /media/<key>?query still serves the file (cache-busting params)', async () => {
  const res = await raw('GET', `/media/${KEY}?v=2`, { Range: 'bytes=0-7' });
  assert.equal(res.status, 206);
});

test('AC5: 416 must not be cached for a year', async () => {
  const res = await raw('GET', `/media/${KEY}`, { Range: `bytes=${SIZE}-` });
  assert.equal(res.status, 416);
  assert.doesNotMatch(res.headers['cache-control'] ?? '', /immutable|max-age=31536000/);
});

test('AC6: STORAGE_DIR that is a symlink to public/ is refused', async () => {
  const link = path.join(outside, 'link-to-public');
  await symlink(path.join(APP_ROOT, 'public'), link);
  assert.throws(() => loadConfig(baseEnv(link)), ConfigError);
});
