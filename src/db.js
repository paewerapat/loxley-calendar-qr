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

// createPool does not connect until the first query, so building the app never
// blocks on (or crashes because of) the database.
export function createPool(db) {
  return mysql.createPool({
    ...connectionOptions(db),
    waitForConnections: true,
    connectionLimit: 5, // shared hosting: keep it small
    enableKeepAlive: true,
  });
}
