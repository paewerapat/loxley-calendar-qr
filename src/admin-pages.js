// Back-office pages (Thai). Look: public/assets/admin.css (+ self-hosted Sarabun);
// behaviour: forms.js (login / change password) and admin.js (video list).
// Icons are inline SVG drawn here; nothing is loaded from another site.

import { escapeHtml } from './pages.js';

const e = escapeHtml;

// --- icons (24×24, stroke = currentColor) ---------------------------------------------
const svg = (body, extra = '', width = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;
export const ICONS = {
  logo: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M10 8.5v7l6-3.5z" fill="currentColor" stroke="none"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', ' class="icon-show"'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.9"/><path d="M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>', ' class="icon-hide"'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m17 6 3 3"/>'),
  logout: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/>'),
  play: svg('<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5z" fill="currentColor" stroke="none"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  download: svg('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>'),
  upload: svg('<path d="M12 20V9"/><path d="m7 14 5-5 5 5"/><path d="M5 4h14"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', '', 3),
  back: svg('<path d="M15 6l-6 6 6 6"/>'),
};

// --- shared pieces ------------------------------------------------------------------
function head({ title, assets, script }) {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0b0b0c">
<title>${e(title)}</title>
<style>${assets.fontCss}</style>
<link rel="stylesheet" href="${e(assets.css)}">
<script src="${e(script)}" defer></script>
</head>`;
}

const brand = (tag = 'div', attrs = '') => `<${tag} class="brand"${attrs}>
  <span class="brand-mark">${ICONS.logo}</span>
  <span class="brand-text"><span class="brand-name">ระบบจัดการวีดีโอ</span><span class="brand-sub">ปฏิทิน QR วีดีโอ</span></span>
</${tag}>`;

// The icon comes from CSS (no markup inside the message, so screen readers read it as is).
const alertBox = (message) => (message ? `<p class="alert" role="alert">${e(message)}</p>` : '');
const noticeBox = (message) => (message ? `<p class="notice" role="status">${e(message)}</p>` : '');

function passwordField({ id, label, autocomplete, help = '', minlength }) {
  return `<div class="field">
    <label for="${id}">${e(label)}${help ? ` <span class="help">${e(help)}</span>` : ''}</label>
    <div class="password-wrap">
      <input class="input" id="${id}" name="${id}" type="password" autocomplete="${autocomplete}"${minlength ? ` minlength="${minlength}"` : ''} required>
      <button type="button" class="pw-toggle" data-toggle-password="${id}" aria-controls="${id}" aria-pressed="false" aria-label="แสดงรหัสผ่าน">${ICONS.eye}${ICONS.eyeOff}</button>
    </div>
  </div>`;
}

function authPage({ title, assets, body }) {
  return `${head({ title, assets, script: assets.formsJs })}
<body>
<div class="auth-page">
<main class="auth-card">
${brand()}
${body}
</main>
</div>
</body>
</html>`;
}

// --- login ----------------------------------------------------------------------------
export function loginPage({ error, username = '', assets }) {
  return authPage({
    title: 'เข้าสู่ระบบ',
    assets,
    body: `<h1>เข้าสู่ระบบหลังบ้าน</h1>
${alertBox(error)}
<form method="post" action="/admin/login">
  <div class="field">
    <label for="username">ชื่อผู้ใช้</label>
    <input class="input" id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${e(username)}">
  </div>
  ${passwordField({ id: 'password', label: 'รหัสผ่าน', autocomplete: 'current-password' })}
  <button type="submit" class="btn btn-primary btn-block" data-busy-text="กำลังเข้าสู่ระบบ...">เข้าสู่ระบบ</button>
</form>`,
  });
}

// --- change password ---------------------------------------------------------------------
export function passwordPage({ error, assets }) {
  return authPage({
    title: 'เปลี่ยนรหัสผ่าน',
    assets,
    body: `<h1>เปลี่ยนรหัสผ่าน</h1>
${alertBox(error)}
<form method="post" action="/admin/password">
  ${passwordField({ id: 'current_password', label: 'รหัสผ่านเดิม', autocomplete: 'current-password' })}
  ${passwordField({ id: 'new_password', label: 'รหัสผ่านใหม่', help: '(อย่างน้อย 10 ตัวอักษร)', autocomplete: 'new-password', minlength: 10 })}
  ${passwordField({ id: 'confirm_password', label: 'ยืนยันรหัสผ่านใหม่', autocomplete: 'new-password', minlength: 10 })}
  <button type="submit" class="btn btn-primary btn-block" data-busy-text="กำลังบันทึก...">บันทึกรหัสผ่านใหม่</button>
</form>
<p class="auth-back"><a href="/admin">${ICONS.back}กลับหน้าหลังบ้าน</a></p>`,
  });
}

// --- /admin: the 14 sets ------------------------------------------------------------------
// Mobile first (cards in a 1/2/3-column grid, no horizontal scrolling). Behaviour
// (copy link, browser-side checks, XHR upload with progress) is in admin.js; the
// size limit and accepted type come from the server through data attributes.

// The set points at a file that is no longer on disk (/v shows "coming soon").
export const FILE_MISSING_TEXT = 'ไฟล์วีดีโอหาย กรุณาอัปโหลดใหม่';

function videoCard(v) {
  const num = v.kind === 'monthly' ? String(v.sortOrder).padStart(2, '0') : 'e-card';
  const qr = v.qrInline
    ? `<div class="qr-code" role="img" aria-label="QR Code ของ ${e(v.title)}">${v.qrInline}</div>`
    : '<div class="qr-missing">ยังแสดง QR ไม่ได้ (ดูคำเตือนด้านบน)</div>';
  return `<li class="video" data-slug="${e(v.slug)}" data-limit-bytes="${e(v.limitBytes)}" data-limit-label="${e(v.limitLabel)}" data-has-video="${v.hasVideo ? 'true' : 'false'}" data-file-missing="${v.fileMissing ? 'true' : 'false'}">
  <div class="video-head">
    <span class="num">${num}</span>
    <h3>${e(v.title)}</h3>
    <span class="status ${v.hasVideo ? 'status-ok' : 'status-none'}" data-field="status">${e(v.statusLabel)}</span>
  </div>
  <p class="file-missing" data-field="file-missing"${v.fileMissing ? '' : ' hidden'}>${e(FILE_MISSING_TEXT)}</p>
  <div class="video-body">
    <figure class="qr">
      ${qr}
      <span class="qr-check" data-field="qr-check" title="มีวีดีโอแล้ว"${v.hasVideo ? '' : ' hidden'}>${ICONS.check}</span>
    </figure>
    <dl class="meta">
      <div><dt>ขนาด</dt><dd data-field="size">${e(v.sizeLabel)}</dd></div>
      <div><dt>อัปเดตล่าสุด</dt><dd data-field="updated">${e(v.updatedText)}</dd></div>
      <div><dt>รับไฟล์</dt><dd>MP4 ไม่เกิน ${e(v.limitLabel)}</dd></div>
    </dl>
  </div>
  <div class="actions">
    <a class="btn" href="${e(v.viewPath)}" target="_blank" rel="noopener">${ICONS.play}ดูวีดีโอ</a>
    <button type="button" class="btn" data-action="copy" data-url="${e(v.publicUrl)}">${ICONS.link}คัดลอกลิงก์</button>
    <div class="qr-downloads">
      <span class="qr-downloads-label">${ICONS.download}ดาวน์โหลด QR</span>
      <a class="btn btn-sm" href="${e(v.qrPng)}" download aria-label="ดาวน์โหลด QR ของ ${e(v.title)} แบบ PNG">PNG</a>
      <a class="btn btn-sm" href="${e(v.qrSvg)}" download aria-label="ดาวน์โหลด QR ของ ${e(v.title)} แบบ SVG">SVG</a>
    </div>
    <label class="btn btn-primary" data-field="upload-label">
      ${ICONS.upload}<span data-field="upload-text">${v.hasVideo ? 'เปลี่ยนวีดีโอ' : 'อัปโหลดวีดีโอ'}</span>
      <input type="file" class="visually-hidden" accept="video/mp4,.mp4" data-action="upload">
    </label>
  </div>
  <div class="progress" data-field="progress" hidden>
    <progress max="100" value="0" data-field="bar"></progress>
    <span data-field="percent">0%</span>
    <button type="button" class="btn btn-sm" data-action="cancel">ยกเลิก</button>
  </div>
  <p class="msg" role="status" aria-live="polite" data-field="message"></p>
</li>`;
}

function group(id, title, videos) {
  if (videos.length === 0) return '';
  return `<section class="group" aria-labelledby="group-${id}">
  <h2 id="group-${id}">${e(title)} <span class="count">${videos.length} ชุด</span></h2>
  <ul class="videos">
${videos.map(videoCard).join('\n')}
  </ul>
</section>`;
}

export function adminVideosPage({ username, notice, warning, videos, assets, mime }) {
  const limits = [...new Map(videos.map((v) => [v.kind, v.limitLabel])).entries()]
    .map(([kind, label]) => `${kind === 'monthly' ? 'วีดีโอรายเดือน' : 'e-card'} ไม่เกิน ${e(label)}`)
    .join(', ');
  const done = videos.filter((v) => v.hasVideo).length;
  const total = videos.length;
  return `${head({ title: 'หลังบ้าน - จัดการวีดีโอ', assets, script: assets.js })}
<body>
<header class="topbar">
  <div class="topbar-inner">
    ${brand('a', ' href="/admin"')}
    <nav class="topbar-user" aria-label="บัญชีผู้ใช้">
      <span class="user-name">${ICONS.user}<span>เข้าสู่ระบบในชื่อ <strong>${e(username)}</strong></span></span>
      <a class="btn btn-ghost" href="/admin/password" aria-label="เปลี่ยนรหัสผ่าน">${ICONS.key}<span class="hide-sm">เปลี่ยนรหัสผ่าน</span></a>
      <form method="post" action="/admin/logout"><button type="submit" class="btn btn-ghost" aria-label="ออกจากระบบ">${ICONS.logout}<span class="hide-sm">ออกจากระบบ</span></button></form>
    </nav>
  </div>
</header>
<main class="admin" id="admin" data-mime="${e(mime)}">
${warning ? `<p class="warning" role="alert">${e(warning)}</p>` : ''}
${noticeBox(notice)}
<section class="summary" aria-label="สรุปวีดีโอ">
  <p class="summary-text">มีวีดีโอแล้ว <strong id="summary-done">${done}</strong> / <span id="summary-total">${total}</span> ชุด</p>
  <progress id="summary-bar" max="${total}" value="${done}" aria-label="มีวีดีโอแล้ว ${done} จาก ${total} ชุด"></progress>
</section>
<p class="hint">อัปโหลดได้เฉพาะไฟล์ MP4 (${limits}) QR Code พิมพ์ครั้งเดียวใช้ได้ตลอด เปลี่ยนวีดีโอแล้ว QR เดิมจะเปิดวีดีโอใหม่ทันที</p>
${group('monthly', 'วีดีโอรายเดือน', videos.filter((v) => v.kind === 'monthly'))}
${group('ecard', 'e-card', videos.filter((v) => v.kind !== 'monthly'))}
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
</main>
</body>
</html>`;
}
