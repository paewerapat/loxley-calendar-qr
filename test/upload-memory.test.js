// Task 04 AC4: a ~100 MB upload is streamed to disk, not buffered: the app process
// (real app.js, own process) holds only a little of it at a time. Holds the DB lock.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { loadConfig } from '../src/config.js';
import { connectionOptions } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import {
  APP_JS, assertTestDatabase, acquireDbSuiteLock, resetTestDatabase, closedPort, makeTempStorage, runNode, Browser,
  fakeMp4Bytes,
} from './helpers.js';

const config = loadConfig({ ...process.env, PORT: '0' });
assertTestDatabase(config.db.database);
const MIB = 1024 * 1024;

// Test-only preload for the app process: GC every 20 ms, then print the live
// ArrayBuffer bytes (Buffers holding request data live there).
const MEMORY_PROBE = `--import=data:text/javascript,${encodeURIComponent(`
setInterval(() => {
  globalThis.gc();
  process.stdout.write('MEM=' + process.memoryUsage().arrayBuffers + '\\n');
}, 20).unref();
`)}`;

let conn;
let proc;
let port;
let storageDir;

before(async () => {
  conn = await mysql.createConnection(connectionOptions(config.db));
  await acquireDbSuiteLock(conn);
  await resetTestDatabase(conn);
  await runMigrations(config.db);
  await conn.query(
    'INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
    ['mem.user', bcrypt.hashSync('memory password 1', 4), new Date(Date.now() - 1000)],
  );
  port = await closedPort();
  storageDir = await makeTempStorage();
  proc = await runNode(APP_JS, {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', COOKIE_SECURE: 'false', STORAGE_DIR: storageDir },
    execArgv: ['--expose-gc', MEMORY_PROBE],
    waitFor: /listening on port/,
  });
  assert.ok(proc.match, `app did not start:\n${proc.stderr}`);
});

after(async () => {
  await proc?.kill?.();
  await conn?.end();
  if (storageDir) await rm(storageDir, { recursive: true, force: true });
});

async function rssBytes(pid) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  return Number(status.match(/^VmRSS:\s+(\d+) kB/m)[1]) * 1024;
}

// Stream a multipart body of `size` bytes from a reused 1 MiB chunk (the test
// itself never holds the whole file either), honouring backpressure.
function streamUpload({ cookie, slug, size }) {
  const boundary = 'lxmemboundary';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const chunk = fakeMp4Bytes(MIB);
  const filler = Buffer.alloc(MIB, 0x42);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `/api/admin/videos/${slug}`,
      headers: {
        cookie, origin: `http://127.0.0.1:${port}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(head.length + size + tail.length),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.write(head);
    let sent = 0;
    const pump = () => {
      while (sent < size) {
        const n = Math.min(MIB, size - sent);
        const buf = (sent === 0 ? chunk : filler).subarray(0, n);
        sent += n;
        if (!req.write(buf)) { req.once('drain', pump); return; }
      }
      req.end(tail);
    };
    pump();
  });
}

// Peak LIVE ArrayBuffer memory of the app between two points in its output. The
// app (test only) runs with a preload that forces a GC every 20 ms and prints
// process.memoryUsage().arrayBuffers: this removes GC timing from the measurement
// (raw RSS includes socket-read garbage V8 only collects after ~64 MB, which made
// RSS-based bounds noisy), so what is left is memory the upload really holds.
const memLines = (from) => [...proc.stdout.slice(from).matchAll(/^MEM=(\d+)$/gm)].map((m) => Number(m[1]));

async function measuredUpload(b, slug, size) {
  await new Promise((r) => setTimeout(r, 100)); // a few samples before
  const from = proc.stdout.length;
  const rssBefore = await rssBytes(proc.pid);
  const lastBefore = [...proc.stdout.slice(0, from).matchAll(/^MEM=(\d+)$/gm)].pop();
  const before = lastBefore ? Number(lastBefore[1]) : 0;
  const res = await streamUpload({ cookie: b.cookie, slug, size });
  await new Promise((r) => setTimeout(r, 100)); // and after
  const samples = memLines(from);
  return {
    res,
    livePeak: Math.max(...samples) - before,
    samples: samples.length,
    rssGrowth: (await rssBytes(proc.pid)) - rssBefore,
  };
}

test('uploads stream to disk: live memory stays small and does not grow with the file (20 vs 99 MiB)', { timeout: 120000 }, async (t) => {
  const b = new Browser(`http://127.0.0.1:${port}`);
  assert.equal((await b.login('mem.user', 'memory password 1')).status, 302);
  await b.get('/admin'); // warm up the admin page code path

  const small = await measuredUpload(b, 'm01', 20 * MIB); // monthly limit
  const big = await measuredUpload(b, 'ecard-lee', 99 * MIB);
  for (const [label, run, size] of [['20 MiB', small, 20 * MIB], ['99 MiB', big, 99 * MIB]]) {
    assert.equal(run.res.status, 200, `${label}: ${run.res.text}`);
    assert.ok(run.samples > 3, `${label}: memory was sampled during the upload`);
    t.diagnostic(`${label}: live ArrayBuffer peak +${(run.livePeak / MIB).toFixed(1)} MiB, RSS after ${(run.rssGrowth / MIB).toFixed(1)} MiB`);
    // Buffering would hold the whole file.
    assert.ok(run.livePeak < size, `${label}: live memory grew by ${(run.livePeak / MIB).toFixed(1)} MiB`);
  }
  const [[row]] = await conn.query("SELECT r2_key, size_bytes FROM videos WHERE slug = 'ecard-lee'");
  assert.equal(Number(row.size_bytes), 99 * MIB);
  assert.equal((await stat(path.join(storageDir, row.r2_key))).size, 99 * MIB);
  // 5× the data, (almost) the same memory: buffering would differ by ~79 MiB.
  const diff = Math.abs(big.livePeak - small.livePeak);
  assert.ok(diff < 30 * MIB, `live peak 20 MiB: ${(small.livePeak / MIB).toFixed(1)} MiB, 99 MiB: ${(big.livePeak / MIB).toFixed(1)} MiB`);
});
