// QA (task 01): AC3 + AC7 + AC6 checked through the real startup file, launched
// from a working directory that is NOT the app folder (Passenger/Plesk may start
// the app from anywhere). No real database is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT } from '../src/config.js';
import { APP_JS, runNode, closedPort } from './helpers.js';

const OTHER_CWD = os.tmpdir();

async function fakeEnv() {
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    PORT: '0',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(await closedPort()),
    DB_NAME: 'loxley_qa_unreachable',
    DB_USERNAME: 'nobody',
    DB_PASSWORD: 'qa-sentinel-password',
    STORAGE_DIR: '../qr-storage', SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  };
}

test('node app.js started from another cwd: serves public/ only, healthz 503 without leaking', async () => {
  const proc = await runNode(APP_JS, {
    env: await fakeEnv(),
    cwd: OTHER_CWD,
    waitFor: /listening on port (\d+)/,
  });
  assert.ok(proc.match, `app.js did not start: ${proc.stderr}`);
  const base = `http://127.0.0.1:${proc.match[1]}`;
  try {
    const robots = await fetch(`${base}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(await robots.text(), /Disallow: \/admin/);

    for (const p of ['/app.js', '/package.json', '/src/config.js', '/.env.local', '/.env.test', '/%2e%2e/app.js', '/..%2fapp.js']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 404, p);
      const body = await res.text();
      assert.match(body, /<html lang="th">/, p);
      assert.doesNotMatch(body, /createApp|"dependencies"|loadConfig/, p);
    }

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 503);
    const text = await health.text();
    assert.deepEqual(JSON.parse(text), { ok: false, db: false });
    assert.doesNotMatch(text, /ECONN|nobody|loxley_qa|127\.0\.0\.1/);
  } finally {
    await proc.kill();
  }
  assert.ok(!proc.stdout.includes('qa-sentinel-password'));
  assert.ok(!proc.stderr.includes('qa-sentinel-password'));
});

test('STORAGE_DIR relative path resolves against the app folder in a fresh process started elsewhere', async () => {
  const configUrl = pathToFileURL(path.join(APP_ROOT, 'src', 'config.js')).href;
  const code = `import { loadConfig } from ${JSON.stringify(configUrl)};
    const c = loadConfig(process.env);
    process.stdout.write(JSON.stringify({ storageDir: c.storageDir, publicDir: c.publicDir }));`;
  const env = await fakeEnv();
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, cwd: OTHER_CWD });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (c) => (c === 0 ? resolve(stdout) : reject(new Error(stderr))));
  });
  const { storageDir, publicDir } = JSON.parse(out);
  assert.equal(storageDir, path.resolve(APP_ROOT, '..', 'qr-storage'));
  assert.equal(publicDir, path.join(APP_ROOT, 'public'));
});
