// `npm run migrate` — on Plesk run it from Node.js → "Run Node.js commands".
// Reads DB_* from the environment only (no env file is loaded here).

import { loadConfig, ConfigError } from '../src/config.js';
import { runMigrations } from '../src/migrate.js';

try {
  const config = loadConfig(process.env, { scope: 'db' });
  const applied = await runMigrations(config.db, { log: (msg) => console.log(`[migrate] ${msg}`) });
  console.log(applied.length === 0
    ? '[migrate] already up to date'
    : `[migrate] done, applied ${applied.length} migration(s)`);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[migrate] ${err.message}`);
  } else {
    // Driver errors carry a code (ER_ACCESS_DENIED_ERROR, ECONNREFUSED, ...) and a
    // message; neither contains the password.
    console.error(`[migrate] failed: ${err.code ?? ''} ${err.message}`.trim());
  }
  process.exitCode = 1;
}
