// Back-office pages (Thai, black background, gold text, no external assets).

import { escapeHtml } from './pages.js';

function layout({ title, body }) {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; min-height: 100%; background: #000; }
  body {
    color: #d4af37;
    font-family: "Sarabun", "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif;
    display: flex; justify-content: center; padding: 48px 16px; box-sizing: border-box;
  }
  main { width: 100%; max-width: 26rem; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 1.5rem; }
  p { line-height: 1.6; color: #e8cf7a; }
  label { display: block; margin: 1rem 0 .35rem; }
  input {
    width: 100%; box-sizing: border-box; padding: 12px; font: inherit; font-size: 16px;
    background: #111; color: #f3e3a8; border: 1px solid rgba(212, 175, 55, .5); border-radius: 8px;
  }
  input:focus { outline: 2px solid #d4af37; outline-offset: 1px; }
  button {
    margin-top: 1.5rem; padding: 12px 20px; min-height: 44px; font: inherit; font-size: 16px; cursor: pointer;
    background: #d4af37; color: #000; border: 0; border-radius: 8px; font-weight: 600;
  }
  button.secondary { background: transparent; color: #d4af37; border: 1px solid rgba(212, 175, 55, .6); }
  a { color: #f0d77a; }
  .alert { padding: 12px; border: 1px solid #c0392b; border-radius: 8px; color: #ffb4a8; background: #1a0705; }
  .notice { padding: 12px; border: 1px solid rgba(212, 175, 55, .6); border-radius: 8px; }
  .row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-top: 2rem; }
  .row form { margin: 0; }
  .row button { margin-top: 0; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

const alertBox = (message) => (message ? `<p class="alert" role="alert">${escapeHtml(message)}</p>` : '');
const noticeBox = (message) => (message ? `<p class="notice" role="status">${escapeHtml(message)}</p>` : '');

export function loginPage({ error, username = '' } = {}) {
  return layout({
    title: 'เข้าสู่ระบบ',
    body: `<h1>เข้าสู่ระบบหลังบ้าน</h1>
${alertBox(error)}
<form method="post" action="/admin/login">
  <label for="username">ชื่อผู้ใช้</label>
  <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${escapeHtml(username)}">
  <label for="password">รหัสผ่าน</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">เข้าสู่ระบบ</button>
</form>`,
  });
}

export function adminHomePage({ username, notice } = {}) {
  return layout({
    title: 'หลังบ้าน',
    body: `<h1>หลังบ้าน</h1>
${noticeBox(notice)}
<p>เข้าสู่ระบบในชื่อ <strong>${escapeHtml(username)}</strong></p>
<p>รายการวีดีโอและการอัปโหลดจะเปิดให้ใช้งานเร็ว ๆ นี้</p>
<div class="row">
  <a href="/admin/password">เปลี่ยนรหัสผ่าน</a>
  <form method="post" action="/admin/logout"><button type="submit" class="secondary">ออกจากระบบ</button></form>
</div>`,
  });
}

export function passwordPage({ error } = {}) {
  return layout({
    title: 'เปลี่ยนรหัสผ่าน',
    body: `<h1>เปลี่ยนรหัสผ่าน</h1>
${alertBox(error)}
<form method="post" action="/admin/password">
  <label for="current_password">รหัสผ่านเดิม</label>
  <input id="current_password" name="current_password" type="password" autocomplete="current-password" required>
  <label for="new_password">รหัสผ่านใหม่ (อย่างน้อย 10 ตัวอักษร)</label>
  <input id="new_password" name="new_password" type="password" autocomplete="new-password" minlength="10" required>
  <label for="confirm_password">ยืนยันรหัสผ่านใหม่</label>
  <input id="confirm_password" name="confirm_password" type="password" autocomplete="new-password" minlength="10" required>
  <button type="submit">บันทึกรหัสผ่านใหม่</button>
</form>
<p><a href="/admin">กลับหน้าหลังบ้าน</a></p>`,
  });
}
