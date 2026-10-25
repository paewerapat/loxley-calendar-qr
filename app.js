// Plesk "Application Startup File". The only place that calls listen().
//
// No top-level await here: Passenger may load this file through require(), and
// require() of an ES module only works when the module has no top-level await.
// The reusable factory lives in src/app.js (tests use that and pick a random port).

import http from 'node:http';
import { loadConfig, ConfigError } from './src/config.js';
import { createPool } from './src/db.js';
import { createApp } from './src/app.js';

// Under Phusion Passenger (Plesk) listen() is taken over by Passenger: the port is
// ignored, the return value may not be the server, and address() is not a TCP
// address. So PORT is only needed when running plain `node app.js`.
const underPassenger = typeof globalThis.PhusionPassenger !== 'undefined';

let config;
try {
  config = loadConfig(process.env, { requirePort: !underPassenger });
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`[config] ${err.message}`);
  process.exit(1);
}

const pool = createPool(config.db);

export const app = createApp({ config, pool });
export { createApp };

// Keep our own reference instead of relying on what listen() returns.
export const server = http.createServer(app);
// A 100 MB e-card over a slow mobile connection can take well over Node's default
// 5-minute request timeout. Headers must still arrive quickly (default 60 s).
server.requestTimeout = 30 * 60 * 1000;

const mode = `NODE_ENV=${config.nodeEnv ?? 'unset'}`;

server.on('error', (err) => {
  // Failing to start (port in use, ...) is fatal. Once listening, a server-level
  // error must not take the whole site down: log it and keep serving.
  if (!server.listening) {
    console.error(`[startup] cannot listen: ${err.code ?? err.message}`);
    process.exit(1);
  }
  console.error(`[server] error: ${err.code ?? err.message}`);
});

server.listen(underPassenger ? 'passenger' : config.port, () => {
  if (underPassenger) {
    console.log(`[startup] listening under Passenger (${mode})`);
    return;
  }
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : config.port;
  console.log(`[startup] listening on port ${port} (${mode})`);
});
