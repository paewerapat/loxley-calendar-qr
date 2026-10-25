// Task 03 round 2: small units behind the login guards (no database).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpLimiter, createSemaphore } from '../src/rate-limit.js';
import { withLockRetry, ThrottleBusyError } from '../src/throttle.js';
import { initPoolConnection } from '../src/db.js';
import bcrypt from 'bcryptjs';
import { passwordTooLong, MAX_PASSWORD_BYTES, dummyHash } from '../src/passwords.js';
import { isSameOrigin } from '../src/admin-routes.js';

test('IP limiter: N requests per window per IP, then refused; other IPs and later windows unaffected', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const limiter = createIpLimiter({ limit: 3, windowMs: 60_000 });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.take('1.1.1.1')), [true, true, true, false]);
  assert.equal(limiter.take('2.2.2.2'), true);
  t.mock.timers.tick(60_001);
  assert.equal(limiter.take('1.1.1.1'), true, 'new window');
  limiter.prune();
  assert.equal(limiter.size, 1, 'expired entries pruned');
});

test('IP limiter memory stays bounded with many (spoofed) IPs', () => {
  const limiter = createIpLimiter({ limit: 1, windowMs: 60_000, maxEntries: 100 });
  for (let i = 0; i < 1000; i++) limiter.take(`10.0.${i >> 8}.${i & 255}`);
  assert.ok(limiter.size <= 100, String(limiter.size));
});

test('semaphore: at most max holders; release is idempotent', () => {
  const sem = createSemaphore(2);
  const a = sem.tryAcquire();
  const b = sem.tryAcquire();
  assert.ok(a && b);
  assert.equal(sem.tryAcquire(), null);
  a();
  a();
  assert.equal(sem.active, 1);
  assert.ok(sem.tryAcquire());
});

test('withLockRetry: retries deadlocks / lock wait timeouts, then gives up with ThrottleBusyError', async () => {
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n < 3) throw Object.assign(new Error('x'), { code: n === 1 ? 'ER_LOCK_DEADLOCK' : 'ER_LOCK_WAIT_TIMEOUT' });
    return 'done';
  };
  assert.equal(await withLockRetry(flaky, { baseDelayMs: 1 }), 'done');
  assert.equal(n, 3);

  let calls = 0;
  await assert.rejects(withLockRetry(async () => {
    calls += 1;
    throw Object.assign(new Error('x'), { code: 'ER_LOCK_DEADLOCK' });
  }, { attempts: 4, baseDelayMs: 1 }), ThrottleBusyError);
  assert.equal(calls, 4);

  await assert.rejects(withLockRetry(async () => {
    throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
  }, { baseDelayMs: 1 }), /db down/);
});

test('a pool connection that cannot switch to UTC is destroyed', (t) => {
  t.mock.method(console, 'error', () => {});
  const make = (err) => {
    const conn = { destroyed: 0, query(sql, cb) { this.sql = sql; cb(err); }, destroy() { this.destroyed += 1; } };
    initPoolConnection(conn);
    return conn;
  };
  assert.equal(make(null).destroyed, 0);
  const bad = make(Object.assign(new Error('nope'), { code: 'ER_UNKNOWN_TIME_ZONE' }));
  assert.equal(bad.sql, "SET time_zone = '+00:00', innodb_lock_wait_timeout = 5");
  assert.equal(bad.destroyed, 1);
});

test('withLockRetry stops retrying when another attempt could not finish before the deadline', async () => {
  let calls = 0;
  const started = Date.now();
  // Each attempt "waits on a lock" for 40 ms; with a 100 ms deadline and a 40 ms
  // worst-case attempt, only attempts that can still end in time are started.
  await assert.rejects(withLockRetry(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 40));
    throw Object.assign(new Error('x'), { code: 'ER_LOCK_WAIT_TIMEOUT' });
  }, { attempts: 10, baseDelayMs: 1, deadlineMs: 100, attemptMaxMs: 40 }), ThrottleBusyError);
  assert.ok(calls >= 1 && calls <= 2, String(calls));
  assert.ok(Date.now() - started < 200);
});

test('a failed dummy-hash computation is retried on the next call', async (t) => {
  const original = bcrypt.hash;
  let failures = 0;
  t.mock.method(bcrypt, 'hash', function (...args) {
    if (failures === 0) {
      failures += 1;
      return Promise.reject(new Error('transient'));
    }
    return original.apply(this, args);
  });
  await assert.rejects(dummyHash(), /transient/);
  const hash = await dummyHash();
  assert.match(hash, /^\$2[ab]\$12\$/);
  assert.equal(await dummyHash(), hash, 'cached once it succeeded');
});

test('passwords over 72 UTF-8 bytes are "too long"', () => {
  assert.equal(MAX_PASSWORD_BYTES, 72);
  assert.equal(passwordTooLong('a'.repeat(72)), false);
  assert.equal(passwordTooLong('a'.repeat(73)), true);
  assert.equal(passwordTooLong('ก'.repeat(24)), false); // 72 bytes
  assert.equal(passwordTooLong('ก'.repeat(25)), true); // 75 bytes
});

test('isSameOrigin: PUBLIC_ORIGIN wins over the request origin; Referer fallback', () => {
  const req = (headers, protocol = 'http', host = '127.0.0.1:3000') => ({
    protocol,
    get: (h) => (h.toLowerCase() === 'host' ? host : headers[h.toLowerCase()]),
  });
  const pub = 'https://wjasmin.site';
  assert.equal(isSameOrigin(req({ origin: 'https://wjasmin.site' }), pub), true);
  assert.equal(isSameOrigin(req({ origin: 'https://WJASMIN.site' }), pub), true);
  assert.equal(isSameOrigin(req({ origin: 'http://127.0.0.1:3000' }), pub), false);
  assert.equal(isSameOrigin(req({ origin: 'https://wjasmin.site:8443' }), pub), false);
  assert.equal(isSameOrigin(req({ referer: 'https://wjasmin.site/admin/login' }), pub), true);
  assert.equal(isSameOrigin(req({}), pub), false);
  assert.equal(isSameOrigin(req({ origin: 'http://127.0.0.1:3000' })), true, 'no PUBLIC_ORIGIN: own origin');
});
