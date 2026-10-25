// Brute-force protection kept in the database (survives restarts, shared by every
// Passenger process). Times use the database clock (UTC_TIMESTAMP(3)).
//
// Each password check first RESERVES an attempt for IP + lowercased username in one
// row-locked transaction, before bcrypt runs. A reservation counts as a failure
// until the password turns out to be right, so requests sent in parallel cannot all
// slip past the check: at most `keyFailures` passwords are ever evaluated per key
// per window. After that the key is locked for `lockMs`. On top of that, a
// username-wide cap (any IP) limits guessing with spoofed X-Forwarded-For.

import { LOCK_WAIT_TIMEOUT_S } from './db.js';

export const DEFAULT_THROTTLE = {
  keyFailures: 5, // per IP + username
  // Per username, all IPs together. High enough that locking the customer out
  // needs ~20 IPs; guessing a ≥10-character password in 100 tries stays hopeless.
  usernameFailures: 100,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
};

// Columns are VARCHAR(64); valid usernames are at most 32 characters anyway.
export function throttleKey(ip, username) {
  return {
    ip: String(ip ?? '').slice(0, 64),
    username: String(username ?? '').trim().toLowerCase().slice(0, 64),
  };
}

// The database gave up on a row lock even after retries; callers answer
// "busy, try again" (never 500).
export class ThrottleBusyError extends Error {
  constructor(cause) {
    super('login throttle is busy');
    this.name = 'ThrottleBusyError';
    this.cause = cause;
  }
}

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
// Every pool connection runs with innodb_lock_wait_timeout = 5 s (see db.js).
const LOCK_WAIT_MS = LOCK_WAIT_TIMEOUT_S * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying row-lock errors. Bounded both in attempts and in total time:
 * a new attempt only starts if it can finish (worst case: one full lock wait,
 * `attemptMaxMs`) before `deadlineMs`, so a stuck lock answers "busy" in ~15 s.
 */
export async function withLockRetry(fn, {
  attempts = 4,
  baseDelayMs = 15,
  deadlineMs = 15_000,
  attemptMaxMs = LOCK_WAIT_MS,
} = {}) {
  const start = Date.now();
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!RETRYABLE.has(err?.code)) throw err;
      const delay = baseDelayMs * i + Math.floor(Math.random() * baseDelayMs);
      const wouldEnd = Date.now() - start + delay + attemptMaxMs;
      if (i >= attempts || wouldEnd > deadlineMs) throw new ThrottleBusyError(err);
      await sleep(delay);
    }
  }
}

async function inTransaction(pool, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Reserve one password check for this key.
 * @returns {Promise<'ok'|'locked'>}
 */
export function reserveAttempt(pool, { ip, username }, limits = DEFAULT_THROTTLE) {
  return withLockRetry(() => inTransaction(pool, async (conn) => {
    // Insert inside the transaction, so the row is guaranteed to exist (and to be
    // ours, row-locked) for the SELECT below even if a success deletes it meanwhile.
    await conn.query(
      `INSERT INTO login_throttle (ip, username, failures, first_failed_at)
       VALUES (?, ?, 0, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE failures = failures`,
      [ip, username],
    );
    const [[row]] = await conn.query(
      `SELECT failures, first_failed_at, locked_until, UTC_TIMESTAMP(3) AS now
         FROM login_throttle WHERE ip = ? AND username = ? FOR UPDATE`,
      [ip, username],
    );
    const now = row.now;
    if (row.locked_until && row.locked_until.getTime() > now.getTime()) return 'locked';

    let { failures } = row;
    let firstFailedAt = row.first_failed_at;
    // A lock that has run out, or failures older than the window, start over.
    if (row.locked_until || now.getTime() - firstFailedAt.getTime() > limits.windowMs) {
      failures = 0;
      firstFailedAt = now;
    }
    const save = (f, lockedUntil) => conn.query(
      'UPDATE login_throttle SET failures = ?, first_failed_at = ?, locked_until = ? WHERE ip = ? AND username = ?',
      [f, firstFailedAt, lockedUntil, ip, username],
    );

    if (failures >= limits.keyFailures) {
      await save(failures, new Date(now.getTime() + limits.lockMs));
      return 'locked';
    }
    // Username-wide cap: recent failures/reservations for this username from
    // every other IP, plus this key's own.
    const [[others]] = await conn.query(
      `SELECT COALESCE(SUM(failures), 0) AS n FROM login_throttle
        WHERE username = ? AND ip <> ?
          AND (first_failed_at > ? OR locked_until > ?)`,
      [username, ip, new Date(now.getTime() - limits.windowMs), now],
    );
    if (Number(others.n) + failures >= limits.usernameFailures) {
      await save(failures, null);
      return 'locked';
    }
    await save(failures + 1, null);
    return 'ok';
  }));
}

/**
 * The reserved password was wrong. Its reservation already counts; lock the key
 * once the limit is reached. @returns {Promise<boolean>} locked now
 */
export async function failAttempt(pool, { ip, username }, limits = DEFAULT_THROTTLE) {
  await withLockRetry(() => pool.query(
    `UPDATE login_throttle SET locked_until = COALESCE(locked_until, UTC_TIMESTAMP(3) + INTERVAL ? SECOND)
      WHERE ip = ? AND username = ? AND failures >= ?`,
    [Math.round(limits.lockMs / 1000), ip, username, limits.keyFailures],
  ));
  return isLocked(pool, { ip, username });
}

export async function isLocked(pool, { ip, username }) {
  const [rows] = await withLockRetry(() => pool.query(
    'SELECT locked_until > UTC_TIMESTAMP(3) AS locked FROM login_throttle WHERE ip = ? AND username = ?',
    [ip, username],
  ));
  return Number(rows[0]?.locked ?? 0) === 1;
}

// Right password (and the key is not locked): forget this key's failures.
export async function clearFailures(pool, { ip, username }) {
  await withLockRetry(() => pool.query('DELETE FROM login_throttle WHERE ip = ? AND username = ?', [ip, username]));
}

// Housekeeping (runs from a background timer, not in the request path).
export async function purgeOldThrottleRows(pool) {
  const [res] = await pool.query(
    `DELETE FROM login_throttle
      WHERE first_failed_at < UTC_TIMESTAMP(3) - INTERVAL 1 DAY
        AND (locked_until IS NULL OR locked_until < UTC_TIMESTAMP(3))`,
  );
  return res.affectedRows;
}
