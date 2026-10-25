// mysql2 (pure JS) works with both MariaDB 10.11 (production) and MySQL 8.4 (local).

import mysql from 'mysql2/promise';

export function connectionOptions(db) {
  return {
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    password: db.password,
    charset: 'UTF8MB4_UNICODE_CI',
    // DATETIME columns hold UTC (written with UTC_TIMESTAMP()); read them back as UTC.
    timezone: 'Z',
    connectTimeout: 5000,
  };
}

// Session settings for every connection:
// - UTC, so NOW() / CURRENT_TIMESTAMP / column DEFAULTs agree with UTC_TIMESTAMP()
//   and with timezone 'Z' on the JS side, whatever the shared server's time zone is.
// - innodb_lock_wait_timeout = 5 s (server default 50 s): a web request waiting on a
//   row lock gives up quickly (the login throttle then answers "busy, try again").
//   The app's writes are single-row and short, so 5 s is ample for them.
export const LOCK_WAIT_TIMEOUT_S = 5;
export const SESSION_INIT_SQL = `SET time_zone = '+00:00', innodb_lock_wait_timeout = ${LOCK_WAIT_TIMEOUT_S}`;

// createPool does not connect until the first query, so building the app never
// blocks on (or crashes because of) the database.
export function createPool(db) {
  const pool = mysql.createPool({
    ...connectionOptions(db),
    waitForConnections: true,
    connectionLimit: 5, // shared hosting: keep it small
    enableKeepAlive: true,
  });
  // Fires for each new physical connection before it is handed out; the SET is
  // queued ahead of the first query on that connection.
  pool.on('connection', initPoolConnection);
  return pool;
}

// A connection whose session settings failed must not be used (its NOW() and
// DEFAULTs would be off): destroy it so the pool opens a fresh one.
export function initPoolConnection(conn) {
  conn.query(SESSION_INIT_SQL, (err) => {
    if (!err) return;
    console.error(`[db] could not apply session settings (UTC time zone), dropping connection: ${err.code ?? err.message}`);
    conn.destroy();
  });
}

// Single connection (migrations) with the same session settings.
export async function createConnection(db, extra = {}) {
  const conn = await mysql.createConnection({ ...connectionOptions(db), ...extra });
  await conn.query(SESSION_INIT_SQL);
  return conn;
}
