// Express app factory. Does not listen and does not read process.env: app.js (the
// Plesk startup file) builds the config and pool and calls listen once; tests call
// createApp() and listen on a random port themselves.

import express from 'express';
import { notFoundPage, errorPage } from './pages.js';
import { mountVideoRoutes } from './video-routes.js';
import { mountAdminRoutes } from './admin-routes.js';
import { describeError } from './log-error.js';

/**
 * @param {object} deps
 * @param {object} deps.config  result of loadConfig()
 * @param {import('mysql2/promise').Pool} deps.pool
 * @param {(app: import('express').Express) => void} [deps.extraRoutes]
 *   mounted after the built-in routes and before the 404/500 handlers (test seam)
 * @param {object} [deps.authLimits]  overrides for DEFAULT_AUTH_LIMITS (tests)
 */
export function createApp({ config, pool, extraRoutes, authLimits } = {}) {
  const app = express();

  // nginx on Plesk terminates https and forwards plain http to Passenger.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.get('/healthz', async (req, res) => {
    let dbOk = false;
    try {
      await pool.query('SELECT 1');
      dbOk = true;
    } catch (err) {
      // Log server-side only; the response never carries DB details.
      console.error(`[healthz] db check failed: ${err.code ?? err.name}`);
    }
    res.set('Cache-Control', 'no-store');
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: dbOk });
  });

  mountVideoRoutes(app, { config, pool });
  mountAdminRoutes(app, { config, pool, limits: authLimits });

  // Only public/ is web-accessible. Dotfiles are never served.
  // redirect: false — never answer a directory (e.g. /assets, raw /v/%2e%2e) with a
  // 301 page; it falls through to the Thai 404.
  app.use(express.static(config.publicDir, { dotfiles: 'ignore', index: false, redirect: false }));

  if (extraRoutes) extraRoutes(app);

  app.use((req, res) => {
    res.status(404).type('html').send(notFoundPage());
  });

  app.use((err, req, res, next) => {
    const raw = Number(err?.status ?? err?.statusCode);
    const status = raw >= 400 && raw < 500 ? raw : 500;
    // Sanitised: never the raw error (mysql2 errors carry the SQL, e.g. a hash).
    if (status === 500) console.error(`[error] ${describeError(err, { withStack: config.showErrorDetails })}`);
    if (res.headersSent) return next(err); // let Express close the connection
    const detail = config.showErrorDetails ? (err?.stack ?? String(err)) : undefined;
    res.status(status).type('html').send(errorPage({ status, detail }));
  });

  return app;
}
