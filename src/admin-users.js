// admin_users access shared by the login routes and the admin:* CLI.

import { hashPassword, generatePassword } from './passwords.js';

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

export class AdminUserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdminUserError';
  }
}

// Usernames are case-insensitive and ignore surrounding spaces.
export function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export async function findUserByUsername(pool, username) {
  const [rows] = await pool.query(
    'SELECT id, username, password_hash, password_changed_at FROM admin_users WHERE username = ?',
    [username],
  );
  return rows[0] ?? null;
}

export async function findUserById(pool, id) {
  const [rows] = await pool.query(
    'SELECT id, username, password_hash, password_changed_at FROM admin_users WHERE id = ?',
    [id],
  );
  return rows[0] ?? null;
}

export async function recordLogin(pool, id) {
  await pool.query('UPDATE admin_users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [id]);
}

/**
 * Store a new password hash and mark the change time. Sessions that logged in
 * before `changedAt` stop working (checked on every request).
 * The time comes from this process, the same clock that stamps session login times.
 * @returns {Promise<Date>} changedAt (millisecond precision)
 */
export async function setPassword(pool, id, password) {
  const hash = await hashPassword(password);
  const changedAt = new Date();
  await pool.query(
    'UPDATE admin_users SET password_hash = ?, password_changed_at = ? WHERE id = ?',
    [hash, changedAt, id],
  );
  return changedAt;
}

function checkUsername(username) {
  if (!USERNAME_RE.test(username)) {
    throw new AdminUserError(
      `username ต้องเป็น a-z 0-9 . _ - ยาว 3–32 ตัว (ตัวพิมพ์เล็ก): ${username || '(ว่าง)'}`,
    );
  }
}

/** @returns {Promise<{ username: string, password: string }>} */
export async function createUser(pool, rawUsername) {
  const username = normalizeUsername(rawUsername);
  checkUsername(username);
  const password = generatePassword();
  const hash = await hashPassword(password);
  try {
    await pool.query(
      'INSERT INTO admin_users (username, password_hash, password_changed_at) VALUES (?, ?, ?)',
      [username, hash, new Date()],
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new AdminUserError(`มี username ${username} อยู่แล้ว`);
    throw err;
  }
  return { username, password };
}

/** New random password; every existing session of that user stops working. */
export async function resetPassword(pool, rawUsername) {
  const username = normalizeUsername(rawUsername);
  checkUsername(username);
  const user = await findUserByUsername(pool, username);
  if (!user) throw new AdminUserError(`ไม่พบ username ${username}`);
  const password = generatePassword();
  await setPassword(pool, user.id, password);
  // A customer who forgot the password is often locked out too: clear the counter.
  await pool.query('DELETE FROM login_throttle WHERE username = ?', [username]);
  return { username, password };
}

export async function listUsers(pool) {
  const [rows] = await pool.query(
    'SELECT username, created_at, last_login_at FROM admin_users ORDER BY username',
  );
  return rows;
}
