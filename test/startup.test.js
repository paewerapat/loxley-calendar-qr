// AC2: app.js under a simulated Phusion Passenger (as on Plesk). No real database.
//
// Passenger defines globalThis.PhusionPassenger and takes over listen(): the port is
// ignored, listen() may not return the server, and address() is a socket path. The
// preload below fakes exactly that so we can check app.js does not crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { APP_JS, runNode } from './helpers.js';

// FAKE_PASSENGER_MODE (env): unset = start normally; 'error-before-listen' = emit
// 'error' instead of listening; 'error-after-listen' = listen, then emit 'error'.
const FAKE_PASSENGER = `
import http from 'node:http';
globalThis.PhusionPassenger = { fake: true };
http.Server.prototype.listen = function (...args) {
  const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  const mode = process.env.FAKE_PASSENGER_MODE;
  console.log('FAKE_LISTEN_ARG=' + String(args[0]));
  this.address = () => '/tmp/passenger-fake.sock';
  const fakeError = () => Object.assign(new Error('fake'), { code: 'EFAKE' });
  if (mode === 'error-before-listen') {
    process.nextTick(() => this.emit('error', fakeError()));
    return undefined;
  }
  process.nextTick(() => {
    if (mode === 'error-after-listen') Object.defineProperty(this, 'listening', { value: true, configurable: true });
    this.emit('listening'); if (cb) cb();
    if (mode === 'error-after-listen') setTimeout(() => this.emit('error', fakeError()), 50);
  });
  return undefined;
};
`;

const PRELOAD = `--import=data:text/javascript,${encodeURIComponent(FAKE_PASSENGER)}`;

function passengerEnv(overrides = {}) {
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    DB_HOST: '127.0.0.1',
    DB_NAME: 'loxley_passenger_unused',
    DB_USERNAME: 'nobody',
    DB_PASSWORD: 'passenger-sentinel-password',
    STORAGE_DIR: '../qr-storage', SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    ...overrides,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

test('under Passenger without PORT: listens via "passenger", logs it, does not crash', async () => {
  const proc = await runNode(APP_JS, {
    env: passengerEnv(),
    execArgv: [PRELOAD],
    waitFor: /listening under Passenger \(NODE_ENV=production\)/,
  });
  try {
    assert.ok(proc.match, `app.js did not report Passenger startup (exit ${proc.code}):\n${proc.stdout}\n${proc.stderr}`);
    assert.match(proc.stdout, /FAKE_LISTEN_ARG=passenger/);
    assert.doesNotMatch(proc.stderr, /TypeError|cannot listen|Missing required/);
  } finally {
    await proc.kill?.();
  }
});

test('under Passenger the port is never read from address() even when PORT is set', async () => {
  const proc = await runNode(APP_JS, {
    env: passengerEnv({ PORT: '3999' }),
    execArgv: [PRELOAD],
    waitFor: /listening under Passenger/,
  });
  try {
    assert.ok(proc.match, `app.js did not start:\n${proc.stderr}`);
    assert.match(proc.stdout, /FAKE_LISTEN_ARG=passenger/);
    assert.doesNotMatch(proc.stdout, /listening on port/);
  } finally {
    await proc.kill?.();
  }
});

test('startup log says NODE_ENV=unset when NODE_ENV is not set', async () => {
  const proc = await runNode(APP_JS, {
    env: passengerEnv({ NODE_ENV: undefined }),
    execArgv: [PRELOAD],
    waitFor: /listening under Passenger \(NODE_ENV=unset\)/,
  });
  try {
    assert.ok(proc.match, `unexpected startup log:\n${proc.stdout}\n${proc.stderr}`);
  } finally {
    await proc.kill?.();
  }
});

// Task 02 AC8 ---------------------------------------------------------------

test('app.js can be loaded with require() under Passenger (no top-level await)', async () => {
  const code = `const m = require(${JSON.stringify(APP_JS)});
    console.log('REQUIRED_EXPORTS=' + Object.keys(m).sort().join(','));`;
  // runNode(script) appends `script` last, so this runs: node <preload> -e <code>
  const proc = await runNode(code, {
    env: passengerEnv(),
    execArgv: [PRELOAD, '--input-type=commonjs', '-e'],
    waitFor: /REQUIRED_EXPORTS=.*\n[\s\S]*listening under Passenger|listening under Passenger[\s\S]*REQUIRED_EXPORTS=.*\n/,
  });
  try {
    assert.ok(proc.match, `require(app.js) failed (exit ${proc.code}):\n${proc.stdout}\n${proc.stderr}`);
    assert.match(proc.stdout, /REQUIRED_EXPORTS=app,createApp,server/);
    assert.doesNotMatch(proc.stderr, /ERR_REQUIRE_ASYNC_MODULE|ERR_REQUIRE_ESM|TypeError/);
  } finally {
    await proc.kill?.();
  }
});

test('error before listening → logs "cannot listen" and exits 1', async () => {
  const result = await runNode(APP_JS, {
    env: passengerEnv({ FAKE_PASSENGER_MODE: 'error-before-listen' }),
    execArgv: [PRELOAD],
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[startup\] cannot listen: EFAKE/);
});

test('error after listening → only logged, the process does not exit(1)', async () => {
  const result = await runNode(APP_JS, {
    env: passengerEnv({ FAKE_PASSENGER_MODE: 'error-after-listen' }),
    execArgv: [PRELOAD],
  });
  // Nothing keeps the fake server alive, so the process ends on its own (code 0)
  // after the error; process.exit(1) would give code 1.
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /listening under Passenger/);
  assert.match(result.stderr, /\[server\] error: EFAKE/);
  assert.doesNotMatch(result.stderr, /cannot listen/);
});

test('without Passenger: port already in use → "cannot listen: EADDRINUSE", exit 1', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, r));
  try {
    const result = await runNode(APP_JS, {
      env: passengerEnv({ PORT: String(blocker.address().port) }),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot listen: EADDRINUSE/);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

// Task 04 U4 ----------------------------------------------------------------

test('server allows long uploads: requestTimeout 30 min, headersTimeout stays short', async () => {
  const code = `const m = require(${JSON.stringify(APP_JS)});
    console.log('TIMEOUTS=' + m.server.requestTimeout + ',' + m.server.headersTimeout);`;
  const proc = await runNode(code, {
    env: passengerEnv(),
    execArgv: [PRELOAD, '--input-type=commonjs', '-e'],
    waitFor: /TIMEOUTS=(\d+),(\d+)/,
  });
  try {
    assert.ok(proc.match, `app.js did not report timeouts:\n${proc.stdout}\n${proc.stderr}`);
    assert.equal(Number(proc.match[1]), 30 * 60 * 1000);
    assert.ok(Number(proc.match[2]) <= 60 * 1000, `headersTimeout ${proc.match[2]}`);
  } finally {
    await proc.kill?.();
  }
});

// Pre-deploy: process-level handlers -----------------------------------------

// Test-only preload (a file in a temp dir, so stack frames show only its path):
// once app.js is running, fail the way a forgotten await on a mysql2 query would —
// the error carries the interpolated SQL, here with a bcrypt hash.
async function crashPreload(dir, how) {
  const file = path.join(dir, `crash-${how}.mjs`);
  await writeFile(file, `
setTimeout(() => {
  const err = Object.assign(new Error('Unknown column in field list'), {
    code: 'ER_BAD_FIELD_ERROR',
    sql: "UPDATE admin_users SET password_hash = '$2b$12$${'h'.repeat(53)}' WHERE id = 1",
    sqlMessage: 'Unknown column',
  });
  ${how === 'reject' ? 'Promise.reject(err);' : 'throw err;'}
}, 300);
`);
  return `--import=${pathToFileURL(file).href}`;
}

for (const [how, kind] of [['reject', 'unhandled rejection'], ['throw', 'uncaught exception']]) {
  for (const nodeEnv of ['production', 'development']) {
    test(`${kind} (${nodeEnv}): one sanitised [fatal] line, no hash / SQL, exit 1`, async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'loxley-crash-'));
      try {
        const result = await runNode(APP_JS, {
          env: passengerEnv({ PORT: '0', NODE_ENV: nodeEnv }),
          execArgv: [await crashPreload(dir, how)],
        });
        assert.equal(result.code, 1, result.stderr);
        assert.match(result.stdout, /listening on port/, 'the app had started');
        assert.ok(
          result.stderr.includes(`[fatal] ${kind}: Error [ER_BAD_FIELD_ERROR]: Unknown column in field list`),
          result.stderr,
        );
        assert.ok(!result.stderr.includes('$2b$') && !result.stdout.includes('$2b$'), 'no hash');
        assert.doesNotMatch(result.stderr, /UPDATE admin_users|sqlMessage|\bsql\b/, 'no SQL');
        if (nodeEnv === 'production') assert.doesNotMatch(result.stderr, /\n\s+at /, 'no stack in production');
        else assert.match(result.stderr, /\n\s+at /, 'stack frames in development');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
