// Minimal migration runner: applies migrations/NNN_name.sql in numeric order and
// records each applied file in schema_migrations. Safe to run repeatedly.
//
// Migration files must themselves be idempotent (CREATE TABLE IF NOT EXISTS,
// INSERT IGNORE) because DDL auto-commits in MySQL/MariaDB, so a file that fails
// halfway may be re-run. Keep SQL to the subset shared by MariaDB 10.11 and MySQL 8.4.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_ROOT } from './config.js';
import { createConnection } from './db.js';

export const MIGRATIONS_DIR = path.join(APP_ROOT, 'migrations');

const FILE_PATTERN = /^(\d+)_[a-z0-9_-]+\.sql$/i;

const CREATE_SCHEMA_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    VARCHAR(255) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export async function listMigrationFiles(dir = MIGRATIONS_DIR) {
  const files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f));
  const numbered = files.map((f) => ({ file: f, n: Number(f.match(FILE_PATTERN)[1]) }));
  numbered.sort((a, b) => a.n - b.n);
  for (let i = 1; i < numbered.length; i++) {
    if (numbered[i].n === numbered[i - 1].n) {
      throw new Error(`Duplicate migration number: ${numbered[i - 1].file} and ${numbered[i].file}`);
    }
  }
  return numbered.map((x) => x.file);
}

/**
 * @param {object} db  config.db from loadConfig()
 * @returns {Promise<string[]>} files applied in this run
 */
export async function runMigrations(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const files = await listMigrationFiles(dir);
  const conn = await createConnection(db, { multipleStatements: true }); // UTC session
  let locked = false;
  try {
    // Lock name is per database: the MariaDB server is shared with other customers.
    const [[lockRow]] = await conn.query(
      "SELECT GET_LOCK(CONCAT(DATABASE(), ':migrate'), 30) AS locked",
    );
    if (Number(lockRow.locked) !== 1) throw new Error('Could not acquire migration lock (another migrate running?)');
    locked = true;

    await conn.query(CREATE_SCHEMA_MIGRATIONS);
    const [rows] = await conn.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));

    const applied = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      log(`applying ${file}`);
      await conn.query(sql);
      await conn.query('INSERT IGNORE INTO schema_migrations (version) VALUES (?)', [file]);
      applied.push(file);
    }
    return applied;
  } finally {
    if (locked) {
      await conn.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':migrate'))").catch(() => {});
    }
    await conn.end().catch(() => {});
  }
}
