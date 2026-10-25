// Task 02 AC5: GET/HEAD /media/<key> from a temp STORAGE_DIR, with HTTP Range.
// Raw http.request is used for traversal cases because fetch() normalises "..".

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeTempStorage, fakeMp4Bytes, writeStorageFile, fakePool, startServer } from './helpers.js';

const KEY = 'videos/m01/1792832980.mp4';
const SIZE = 1000;
const BYTES = fakeMp4Bytes(SIZE);

let storage;
let outside;
let srv;
let port;

before(async () => {
  storage = await makeTempStorage();
  outside = await makeTempStorage();
  await writeStorageFile(storage, KEY, BYTES);
  // A directory that matches the key pattern.
  await mkdir(path.join(storage, 'videos', 'm01', '1792832999.mp4'), { recursive: true });
  // A symlink inside storage pointing at a file outside it.
  const secret = path.join(outside, 'secret.mp4');
  await writeFile(secret, fakeMp4Bytes(50));
  await symlink(secret, path.join(storage, 'videos', 'm01', '1792832111.mp4'));
  // Files that exist but do not match the key pattern.
  await writeStorageFile(storage, 'videos/m01/notes.txt', 'hello');
  await writeStorageFile(storage, 'videos/m01/123.mp4', BYTES);
  await writeFile(path.join(storage, 'top.mp4'), BYTES);

  const config = loadConfig({
    NODE_ENV: 'production', PORT: '0', DB_HOST: '127.0.0.1', DB_NAME: 'unused_test',
    DB_USERNAME: 'x', DB_PASSWORD: 'x', STORAGE_DIR: storage, SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  });
  srv = await startServer(createApp({ config, pool: fakePool([]) }));
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET full file → 200 video/mp4, Accept-Ranges, immutable cache, exact bytes', async () => {
  const res = await raw('GET', `/media/${KEY}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(Number(res.headers['content-length']), SIZE);
  assert.ok(res.body.equals(BYTES));
});

test('HEAD → 200 with headers and no body', async () => {
  const res = await raw('HEAD', `/media/${KEY}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(Number(res.headers['content-length']), SIZE);
  assert.equal(res.body.length, 0);
});

test('Range: bytes=0-99 → 206 + Content-Range bytes 0-99/<size>', async () => {
  const res = await raw('GET', `/media/${KEY}`, { Range: 'bytes=0-99' });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], `bytes 0-99/${SIZE}`);
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.ok(res.body.equals(BYTES.subarray(0, 100)));
});

test('Range in the middle and open-ended ranges work (seek)', async () => {
  const mid = await raw('GET', `/media/${KEY}`, { Range: 'bytes=500-599' });
  assert.equal(mid.status, 206);
  assert.ok(mid.body.equals(BYTES.subarray(500, 600)));
  const tail = await raw('GET', `/media/${KEY}`, { Range: 'bytes=900-' });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers['content-range'], `bytes 900-999/${SIZE}`);
});

test('Range beyond the end of the file → 416', async () => {
  const res = await raw('GET', `/media/${KEY}`, { Range: `bytes=${SIZE}-${SIZE + 100}` });
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], `bytes */${SIZE}`);
  // An error must not be cached for a year or look like a video.
  assert.doesNotMatch(res.headers['cache-control'] ?? '', /immutable|max-age=31536000/);
  assert.notEqual(res.headers['content-type'], 'video/mp4');
});

const NOT_FOUND = [
  '/media/../app.js',
  '/media/videos/../../app.js',
  '/media/%2e%2e/app.js',
  '/media/videos/m01/%2e%2e/%2e%2e/%2e%2e/package.json',
  '/media/videos%2fm01%2f1792832980.mp4',
  '/media/videos/m01%2f1792832980.mp4',
  '/media/videos/m01/1792832980%2emp4',
  '/media/videos/m01/..%5c..%5capp.js',
  '/media/videos/m01/1792832980.MP4',
  '/media/videos/m01/1792832980.mp4/',
  '/media/videos/m01/1792832999.mp4', // a directory
  '/media/videos/m01/1792832111.mp4', // symlink pointing outside STORAGE_DIR
  '/media/videos/m01/1792800000.mp4', // missing
  '/media/videos/m01/notes.txt',
  '/media/videos/m01/123.mp4', // too few digits
  '/media/top.mp4',
  '/media/videos/M01/1792832980.mp4',
  '/media/',
  '/media',
];

for (const p of NOT_FOUND) {
  test(`${p} → 404 without revealing the real path`, async () => {
    const res = await raw('GET', p);
    assert.equal(res.status, 404, `${p} → ${res.status}`);
    const body = res.body.toString('utf8');
    assert.ok(!body.includes(storage), 'storage path leaked');
    assert.ok(!body.includes('secret'), 'symlink target leaked');
    assert.doesNotMatch(body, /createApp|"dependencies"|ftyp/);
    assert.notEqual(res.headers['content-type'], 'video/mp4');
  });
}

test('POST /media/<key> is not served', async () => {
  const res = await raw('POST', `/media/${KEY}`);
  assert.equal(res.status, 404);
});
