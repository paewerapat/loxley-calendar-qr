// AC3: config comes from env only, fails clearly, resolves STORAGE_DIR against app.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
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

// Task 02 AC6: videos must never end up web-accessible or mixed with the code.
for (const [label, value] of [
  ['public/ itself', 'public'],
  ['public/ with trailing slash', 'public/'],
  ['inside public/', 'public/videos'],
  ['deep inside public/ via ..', 'src/../public/v/storage'],
  ['the app root', '.'],
  ['the app root (absolute)', APP_ROOT],
]) {
  test(`STORAGE_DIR = ${label} → ConfigError naming STORAGE_DIR`, () => {
    assert.throws(() => loadConfig(baseEnv({ STORAGE_DIR: value })), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /STORAGE_DIR/);
      assert.ok(!err.message.includes(APP_ROOT), 'does not print the resolved path');
      return true;
    });
  });
}

test('STORAGE_DIR outside the app root or in a sibling folder of public/ is accepted', () => {
  assert.doesNotThrow(() => loadConfig(baseEnv({ STORAGE_DIR: '../qr-storage' })));
  assert.doesNotThrow(() => loadConfig(baseEnv({ STORAGE_DIR: 'storage' })));
  assert.doesNotThrow(() => loadConfig(baseEnv({ STORAGE_DIR: 'public-videos' })));
  assert.doesNotThrow(() => loadConfig(baseEnv({ STORAGE_DIR: path.join(os.tmpdir(), 'x') })));
});

test('node app.js refuses to start when STORAGE_DIR is inside public/', async () => {
  const env = { PATH: process.env.PATH, ...baseEnv({ STORAGE_DIR: 'public/videos' }) };
  const result = await runNode(APP_JS, { env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[config\].*STORAGE_DIR/);
  assert.doesNotMatch(result.stdout, /listening/);
});

// Task 02 round 2: N5 (production keeps videos outside the deploy target) and Q3
// (symlinks are followed by the STORAGE_DIR guard).
test('NODE_ENV=production: STORAGE_DIR inside the app root → ConfigError (deploy mirror could wipe it)', () => {
  for (const value of ['storage', './storage/videos', path.join(APP_ROOT, 'qr-storage')]) {
    assert.throws(() => loadConfig(baseEnv({ NODE_ENV: 'production', STORAGE_DIR: value })), (err) => {
      assert.ok(err instanceof ConfigError, value);
      assert.match(err.message, /STORAGE_DIR must be outside the app root when NODE_ENV=production/);
      assert.ok(!err.message.includes(APP_ROOT), 'does not print the path');
      return true;
    });
  }
});

test('NODE_ENV=production: STORAGE_DIR outside the app root is accepted', () => {
  assert.doesNotThrow(() => loadConfig(baseEnv({ NODE_ENV: 'production', STORAGE_DIR: '../qr-storage' })));
  assert.doesNotThrow(() => loadConfig(baseEnv({ NODE_ENV: 'production', STORAGE_DIR: path.join(os.tmpdir(), 'x') })));
});

test('dev / test / unset NODE_ENV may keep STORAGE_DIR=./storage inside the app root', () => {
  for (const NODE_ENV of ['development', 'test', undefined]) {
    assert.doesNotThrow(() => loadConfig(baseEnv({ NODE_ENV, STORAGE_DIR: 'storage' })), String(NODE_ENV));
  }
});

test('node app.js with NODE_ENV=production and STORAGE_DIR inside the app root refuses to start', async () => {
  const env = { PATH: process.env.PATH, ...baseEnv({ NODE_ENV: 'production', STORAGE_DIR: 'storage' }) };
  const result = await runNode(APP_JS, { env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[config\].*STORAGE_DIR must be outside the app root/);
  assert.ok(!result.stderr.includes(APP_ROOT));
});

test('symlinks: STORAGE_DIR pointing (via a symlink) into public/ or at the app root is refused', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loxley-links-'));
  try {
    const toPublic = path.join(dir, 'to-public');
    const toRoot = path.join(dir, 'to-root');
    await symlink(path.join(APP_ROOT, 'public'), toPublic);
    await symlink(APP_ROOT, toRoot);
    for (const NODE_ENV of ['test', 'production']) {
      for (const value of [toPublic, path.join(toPublic, 'not-created-yet'), toRoot]) {
        assert.throws(() => loadConfig(baseEnv({ NODE_ENV, STORAGE_DIR: value })), (err) => {
          assert.ok(err instanceof ConfigError, `${NODE_ENV} ${value}`);
          assert.match(err.message, /STORAGE_DIR must not be inside public\/ or equal to the app root/);
          assert.ok(!err.message.includes(dir) && !err.message.includes(APP_ROOT));
          return true;
        });
      }
    }
    // A symlink to a folder inside the app root: fine in test, refused in production.
    const inside = path.join(dir, 'to-inside');
    await symlink(path.join(APP_ROOT, 'migrations'), inside);
    assert.doesNotThrow(() => loadConfig(baseEnv({ NODE_ENV: 'test', STORAGE_DIR: inside })));
    assert.throws(
      () => loadConfig(baseEnv({ NODE_ENV: 'production', STORAGE_DIR: inside })),
      /STORAGE_DIR must be outside the app root when NODE_ENV=production/,
    );
    // A real folder outside the app root (through a symlink) is accepted in production.
    const outsideReal = await mkdtemp(path.join(os.tmpdir(), 'loxley-real-'));
    const toOutside = path.join(dir, 'to-outside');
    await symlink(outsideReal, toOutside);
    assert.doesNotThrow(() => loadConfig(baseEnv({ NODE_ENV: 'production', STORAGE_DIR: toOutside })));
    await rm(outsideReal, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
