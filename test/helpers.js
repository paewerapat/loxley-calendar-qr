// Shared test helpers (no side effects on import; node --test also loads this file).

import net from 'node:net';
import { spawn } from 'node:child_process';
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
export function runNode(script, { env, cwd = APP_ROOT, waitFor, timeoutMs = 15000, execArgv = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgv, script], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
