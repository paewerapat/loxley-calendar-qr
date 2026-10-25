// Back-office users. On Plesk run from Node.js → "Run Node.js commands":
//   npm run admin:create -- <username>          new user, prints a random password once
//   npm run admin:reset-password -- <username>  new random password, logs out old sessions
//   npm run admin:list                          username, created_at, last_login_at
// Uses DB_* only. Passwords never come from argv or env (the panel keeps command
// history); they are generated here and printed once.

import { loadConfig, ConfigError } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createUser, resetPassword, listUsers, AdminUserError } from '../src/admin-users.js';

const [command, username, ...extra] = process.argv.slice(2);
const fmt = (d) => (d instanceof Date ? `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC` : '-');

let pool;
try {
  if (extra.length > 0) throw new AdminUserError('ใส่ได้แค่ username เดียว (ห้ามใส่รหัสผ่านใน command)');
  const config = loadConfig(process.env, { scope: 'db' });
  pool = createPool(config.db);

  if (command === 'create' || command === 'reset-password') {
    const result = command === 'create'
      ? await createUser(pool, username)
      : await resetPassword(pool, username);
    console.log(command === 'create'
      ? `[admin] สร้างผู้ใช้ ${result.username} แล้ว`
      : `[admin] ตั้งรหัสผ่านใหม่ให้ ${result.username} แล้ว (session เดิมทั้งหมดถูกออกจากระบบ)`);
    console.log(`[admin] รหัสผ่าน (แสดงครั้งเดียว จดไว้ให้ดี): ${result.password}`);
  } else if (command === 'list') {
    const users = await listUsers(pool);
    if (users.length === 0) console.log('[admin] ยังไม่มีผู้ใช้');
    for (const u of users) {
      console.log(`${u.username}\tcreated ${fmt(u.created_at)}\tlast login ${fmt(u.last_login_at)}`);
    }
  } else {
    throw new AdminUserError('คำสั่งที่ใช้ได้: create <username>, reset-password <username>, list');
  }
} catch (err) {
  if (err instanceof ConfigError || err instanceof AdminUserError) {
    console.error(`[admin] ${err.message}`);
  } else {
    console.error(`[admin] failed: ${err.code ?? ''} ${err.message}`.trim());
  }
  process.exitCode = 1;
} finally {
  await pool?.end().catch(() => {});
}
