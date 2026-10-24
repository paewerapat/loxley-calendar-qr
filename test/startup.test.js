// AC2: app.js under a simulated Phusion Passenger (as on Plesk). No real database.
//
// Passenger defines globalThis.PhusionPassenger and takes over listen(): the port is
// ignored, listen() may not return the server, and address() is a socket path. The
// preload below fakes exactly that so we can check app.js does not crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_JS, runNode } from './helpers.js';

const FAKE_PASSENGER = `
import http from 'node:http';
globalThis.PhusionPassenger = { fake: true };
http.Server.prototype.listen = function (...args) {
  const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  console.log('FAKE_LISTEN_ARG=' + String(args[0]));
  this.address = () => '/tmp/passenger-fake.sock';
  process.nextTick(() => { this.emit('listening'); if (cb) cb(); });
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
    STORAGE_DIR: '../qr-storage',
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
