// The only place that reads process.env. Everything else receives a config object.
//
// Values come from Plesk "Custom environment variables" in production and from
// `node --env-file=.env.dev|.env.test` locally. This module never loads env files
// itself (in particular never .env.local, which holds production secrets).

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Folder that contains app.js (the Plesk Application Root). Relative paths such as
// STORAGE_DIR=../qr-storage are resolved against this, never against process.cwd().
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DB_VARS = ['DB_HOST', 'DB_NAME', 'DB_USERNAME', 'DB_PASSWORD'];
const STORAGE_VARS = ['STORAGE_DIR'];
const SESSION_VARS = ['SESSION_SECRET'];
const MIN_SESSION_SECRET_LENGTH = 32;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Env files edited on Windows may carry CRLF; strip \r and surrounding whitespace.
function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\r/g, '').trim();
}

function parsePort(name, raw) {
  if (!/^\d+$/.test(raw)) throw new ConfigError(`Environment variable ${name} must be a port number`);
  const n = Number(raw);
  if (n > 65535) throw new ConfigError(`Environment variable ${name} must be a port number`);
  return n;
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ scope?: 'app'|'storage'|'db', requirePort?: boolean }} options
 *   scope 'db'      DB_* only: `npm run migrate`, `npm run admin:*` (on Plesk these run
 *                   from "Run Node.js commands", where PORT is not set)
 *   scope 'storage' DB_* + STORAGE_DIR: `npm run video:set`
 *   scope 'app'     everything the web app needs (adds SESSION_SECRET, COOKIE_SECURE, PORT)
 *   requirePort=false lets PORT be absent (Passenger hooks listen() itself).
 */
export function loadConfig(env = process.env, { scope = 'app', requirePort = true } = {}) {
  const get = (name) => clean(env[name]);
  const withStorage = scope === 'app' || scope === 'storage';

  const required = [...DB_VARS];
  if (withStorage) required.push(...STORAGE_VARS);
  if (scope === 'app') {
    required.push(...SESSION_VARS);
    if (requirePort) required.push('PORT');
  }

  // Report names only, never values.
  const missing = required.filter((name) => get(name) === '');
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const nodeEnv = get('NODE_ENV') || null; // null = not set

  const config = {
    nodeEnv,
    // Fail closed: stack traces only when NODE_ENV is explicitly 'development'.
    showErrorDetails: nodeEnv === 'development',
    db: {
      host: get('DB_HOST'),
      port: get('DB_PORT') === '' ? 3306 : parsePort('DB_PORT', get('DB_PORT')),
      database: get('DB_NAME'),
      user: get('DB_USERNAME'),
      password: get('DB_PASSWORD'),
    },
  };

  if (withStorage) {
    config.storageDir = path.resolve(APP_ROOT, get('STORAGE_DIR'));
    config.publicDir = path.join(APP_ROOT, 'public');
    checkStorageDir(config.storageDir, config.publicDir, nodeEnv);
  }

  if (scope === 'app') {
    config.port = get('PORT') === '' ? null : parsePort('PORT', get('PORT'));
    const secret = get('SESSION_SECRET');
    if (secret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new ConfigError(
        `Environment variable SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
      );
    }
    config.session = {
      secret,
      // Secure unless explicitly in development (plain http://localhost); fail safe
      // when NODE_ENV is missing.
      cookieSecure: parseBool('COOKIE_SECURE', get('COOKIE_SECURE'), nodeEnv !== 'development'),
    };
    // Optional public origin of the site, e.g. https://wjasmin.site. When set, the
    // CSRF check compares against it instead of trusting proxy headers.
    config.publicOrigin = parseOrigin('PUBLIC_ORIGIN', get('PUBLIC_ORIGIN'));
  }

  return config;
}

function parseOrigin(name, raw) {
  if (raw === '') return null;
  const bad = () => new ConfigError(`Environment variable ${name} must be an origin like https://example.com`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw bad();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash
    || url.username || url.password || raw.endsWith('?') || raw.endsWith('#')) {
    throw bad();
  }
  return url.origin; // normalised: lowercase scheme/host, default port dropped
}

function parseBool(name, raw, fallback) {
  if (raw === '') return fallback;
  const v = raw.toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ConfigError(`Environment variable ${name} must be true or false`);
}

// Messages name the variable only; the resolved path is never printed.
function checkStorageDir(storageDir, publicDir, nodeEnv) {
  // Check both the lexical path and the real path (symlinks followed), so a symlink
  // pointing into public/ or the app root is caught too.
  const pairs = [
    [storageDir, publicDir, APP_ROOT],
    [realpathLoose(storageDir), realpathLoose(publicDir), realpathLoose(APP_ROOT)],
  ];
  for (const [storage, pub, root] of pairs) {
    // Videos must never be reachable as static files (nginx serves public/ directly),
    // and the app root itself holds the code.
    if (isInsideOrEqual(storage, pub) || storage === root) {
      throw new ConfigError('Environment variable STORAGE_DIR must not be inside public/ or equal to the app root');
    }
    // In production the app root is the deploy target (FTP mirror with --delete), so
    // videos stored anywhere under it could be wiped by a deploy.
    if (nodeEnv === 'production' && isInsideOrEqual(storage, root)) {
      throw new ConfigError('Environment variable STORAGE_DIR must be outside the app root when NODE_ENV=production');
    }
  }
}

// realpath of `p`; if it does not exist yet, realpath of its nearest existing
// ancestor with the missing part appended (pure lexical path as a last resort).
function realpathLoose(p) {
  try {
    return realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathLoose(parent), path.basename(p));
  }
}

// True when `child` is `parent` or somewhere below it (lexically, after resolve).
export function isInsideOrEqual(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..');
}
