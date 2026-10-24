// AC3: config comes from env only, fails clearly, resolves STORAGE_DIR against app.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError, APP_ROOT } from '../src/config.js';
import { APP_JS, runNode } from './helpers.js';

const SECRET = 'sentinel-secret-value-9f3a';

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    PORT: '3001',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'loxley_unit',
    DB_USERNAME: 'someone',
    DB_PASSWORD: SECRET,
    STORAGE_DIR: '../qr-storage',
    ...overrides,
  };
}

test('APP_ROOT is the folder that contains app.js', () => {
  assert.equal(path.dirname(APP_JS), APP_ROOT);
});

test('missing variables: ConfigError names every missing variable and prints no values', () => {
  const env = baseEnv({ DB_NAME: undefined, DB_USERNAME: '' });
  delete env.STORAGE_DIR;
  assert.throws(() => loadConfig(env), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /DB_NAME/);
    assert.match(err.message, /DB_USERNAME/);
    assert.match(err.message, /STORAGE_DIR/);
    assert.doesNotMatch(err.message, /DB_PASSWORD|DB_HOST/);
    assert.ok(!err.message.includes(SECRET));
    assert.ok(!err.message.includes('127.0.0.1'));
    return true;
  });
});

test('whitespace-only or CR-only values count as missing', () => {
  assert.throws(() => loadConfig(baseEnv({ DB_PASSWORD: '\r' })), /DB_PASSWORD/);
  assert.throws(() => loadConfig(baseEnv({ DB_HOST: '   ' })), /DB_HOST/);
});

test('CRLF from env files is stripped from values', () => {
  const cfg = loadConfig(baseEnv({ DB_HOST: 'db.local\r', DB_PASSWORD: `${SECRET}\r`, PORT: '3001\r', DB_PORT: '3307\r' }));
  assert.equal(cfg.db.host, 'db.local');
  assert.equal(cfg.db.password, SECRET);
  assert.equal(cfg.port, 3001);
  assert.equal(cfg.db.port, 3307);
});

test('DB_PORT defaults to 3306; invalid ports name the variable but not the value', () => {
  assert.equal(loadConfig(baseEnv({ DB_PORT: undefined })).db.port, 3306);
  assert.throws(() => loadConfig(baseEnv({ PORT: 'abc' })), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /PORT/);
    assert.ok(!err.message.includes('abc'));
    return true;
  });
  assert.throws(() => loadConfig(baseEnv({ DB_PORT: '70000' })), /DB_PORT/);
});

test('PORT is required by default and optional with requirePort=false', () => {
  assert.throws(() => loadConfig(baseEnv({ PORT: undefined })), /PORT/);
  assert.equal(loadConfig(baseEnv({ PORT: undefined }), { requirePort: false }).port, null);
});

test('scope "db" (npm run migrate) needs only DB_* variables', () => {
  const cfg = loadConfig(
    { DB_HOST: 'h', DB_NAME: 'n', DB_USERNAME: 'u', DB_PASSWORD: 'p' },
    { scope: 'db' },
  );
  assert.deepEqual(cfg.db, { host: 'h', port: 3306, database: 'n', user: 'u', password: 'p' });
});

test('relative STORAGE_DIR resolves against the app.js folder, not process.cwd()', () => {
  const original = process.cwd();
  process.chdir(os.tmpdir());
  try {
    const cfg = loadConfig(baseEnv({ STORAGE_DIR: '../qr-storage' }));
    assert.equal(cfg.storageDir, path.resolve(APP_ROOT, '..', 'qr-storage'));
    assert.notEqual(cfg.storageDir, path.resolve(os.tmpdir(), '..', 'qr-storage'));
  } finally {
    process.chdir(original);
  }
});

test('absolute STORAGE_DIR is kept as is', () => {
  const abs = path.join(os.tmpdir(), 'loxley-storage');
  assert.equal(loadConfig(baseEnv({ STORAGE_DIR: abs })).storageDir, abs);
});

test('NODE_ENV: stack traces only when explicitly development', () => {
  assert.equal(loadConfig(baseEnv({ NODE_ENV: 'production' })).showErrorDetails, false);
  assert.equal(loadConfig(baseEnv({ NODE_ENV: 'test' })).showErrorDetails, false);
  assert.equal(loadConfig(baseEnv({ NODE_ENV: 'development' })).showErrorDetails, true);
});

test('NODE_ENV unset (or blank): no error details, nodeEnv is null (not "development")', () => {
  for (const value of [undefined, '', '  \r']) {
    const cfg = loadConfig(baseEnv({ NODE_ENV: value }));
    assert.equal(cfg.showErrorDetails, false);
    assert.equal(cfg.nodeEnv, null);
  }
});

test('node app.js with a missing variable exits 1 with the variable name and no secret values', async () => {
  const env = { PATH: process.env.PATH, ...baseEnv({ DB_NAME: undefined }) };
  delete env.DB_NAME;
  const result = await runNode(APP_JS, { env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing required environment variable\(s\): DB_NAME/);
  assert.ok(!result.stderr.includes(SECRET));
  assert.ok(!result.stdout.includes(SECRET));
  assert.doesNotMatch(result.stderr, /\n\s+at /); // no stack trace
});

test('scripts/migrate.js with a missing variable exits 1 and names it', async () => {
  const env = { PATH: process.env.PATH, DB_HOST: '127.0.0.1', DB_NAME: 'x', DB_PASSWORD: SECRET };
  const result = await runNode(path.join(APP_ROOT, 'scripts', 'migrate.js'), { env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /DB_USERNAME/);
  assert.ok(!result.stderr.includes(SECRET));
});
