// Shared test helpers (no side effects on import; node --test also loads this file).

import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_ROOT } from '../src/config.js';

export const APP_JS = path.join(APP_ROOT, 'app.js');

// Refuse to touch any database that is not clearly a test database. .env.local
// points at production; this stops a misconfigured run from dropping its tables.
export function assertTestDatabase(dbName) {
  if (!/_test$/.test(dbName ?? '')) {
    throw new Error('Refusing to run DB tests: DB_NAME must end with "_test" (load .env.test)');
  }
}

// Serialise test files that use the real test database: node --test runs files in
// parallel processes, and some of them drop/recreate tables. Hold this lock on a
// dedicated connection for the whole file (released when the connection ends).
export async function acquireDbSuiteLock(conn) {
  const [[row]] = await conn.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':test-suite'), 120) AS locked");
  if (Number(row.locked) !== 1) throw new Error('Could not acquire the test DB lock');
}

// Temp STORAGE_DIR for tests (never inside the repo, never committed).
export async function makeTempStorage() {
  return mkdtemp(path.join(os.tmpdir(), 'loxley-storage-'));
}

// A tiny fake MP4: an ftyp box followed by deterministic filler bytes.
export function fakeMp4Bytes(size = 1000) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251;
  buf.writeUInt32BE(24, 0);
  buf.write('ftypisom', 4, 'latin1');
  return buf;
}

export async function writeStorageFile(storageDir, key, content) {
  const file = path.join(storageDir, ...key.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

// Stand-in for the mysql2 pool: answers the videos lookup from an in-memory list.
export function fakePool(rows = []) {
  return {
    async query(sql, params = []) {
      if (/FROM videos WHERE slug = \?/.test(sql)) {
        const row = rows.find((r) => r.slug === params[0]);
        return [row ? [{ r2_key: null, size_bytes: null, ...row }] : []];
      }
      if (/^SELECT 1$/.test(sql.trim())) return [[{ 1: 1 }]];
      throw new Error(`fakePool: unexpected query ${sql}`);
    },
    async end() {},
  };
}

export async function startServer(app) {
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve(s)));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// A TCP port on 127.0.0.1 that nothing listens on (connection refused immediately).
export async function closedPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// Run `node <script>` with an explicit environment and collect its output.
// If waitFor matches stdout, resolves early and returns a kill() handle.
export function runNode(script, { env, cwd = APP_ROOT, waitFor, timeoutMs = 15000, execArgv = [], args = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgv, script, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value, isError = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (isError) reject(value); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`timeout running ${script}\nstdout:\n${stdout}\nstderr:\n${stderr}`), true);
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      const m = waitFor && stdout.match(waitFor);
      if (m) {
        finish({
          match: m,
          get stdout() { return stdout; },
          get stderr() { return stderr; },
          kill: () => new Promise((r) => {
            if (child.exitCode !== null || child.signalCode !== null) return r();
            child.once('exit', r);
            child.kill('SIGTERM');
          }),
        });
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(err, true));
    child.on('exit', (code) => finish({ code, stdout, stderr }));
  });
}
