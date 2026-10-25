// Server-rendered HTML pages (Thai, black background, gold text). Nothing is loaded
// from another origin; the video page uses the same-origin /assets/player.*.

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMessagePage({ title, heading, message, detail }) {
  const detailHtml = detail ? `<pre class="detail">${escapeHtml(detail)}</pre>` : '';
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
    font-family: "Sukhumvit Set", "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 0 16px; box-sizing: border-box; text-align: center;
  }
  main { max-width: 32rem; }
  h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 0.75rem; }
  p { font-size: 1rem; line-height: 1.6; margin: 0; color: #e8cf7a; }
  .detail { margin-top: 1.5rem; text-align: left; white-space: pre-wrap; font-size: 0.75rem; color: #b8963a; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(message)}</p>
${detailHtml}
</main>
</body>
</html>`;
}

// /v/<slug> with a video. Markup follows the e-card page the client approved; the
// look and behaviour live in public/assets/player.css + player.js (shared by every
// slug, served from public/ so nginx can serve them directly on Plesk).
export function videoPage({ title, src, assets = { css: '/assets/player.css', js: '/assets/player.js' } }) {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#000000">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeHtml(assets.css)}">
<script src="${escapeHtml(assets.js)}" defer></script>
</head>
<body>
  <div class="stage" id="stage">
    <video id="v" playsinline preload="auto" src="${escapeHtml(src)}"></video>
    <div id="sound" class="sound" data-state="on" role="status" aria-live="polite" aria-label="สถานะเสียง">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/>
        <g class="waves"><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></g>
        <g class="cross"><path d="m16 9 5 6"/><path d="m21 9-5 6"/></g>
      </svg>
    </div>
    <button id="replay" class="replay" type="button" hidden>ดูอีกครั้ง</button>
  </div>
  <p id="hint" class="hint" hidden>แตะหน้าจอหนึ่งครั้งเพื่อฟังเสียงบรรยาย</p>
</body>
</html>`;
}

const COMING_SOON = {
  monthly: 'วีดีโอเดือนนี้จะเปิดให้ชมเร็ว ๆ นี้',
  ecard: 'e-card นี้จะเปิดให้ชมเร็ว ๆ นี้',
};

// /v/<slug> before a video exists (or when its file is missing on disk).
export function comingSoonPage({ title, kind }) {
  return renderMessagePage({
    title,
    heading: title,
    message: COMING_SOON[kind] ?? COMING_SOON.monthly,
  });
}

export function notFoundPage() {
  return renderMessagePage({
    title: 'ไม่พบหน้านี้',
    heading: 'ไม่พบหน้าที่คุณต้องการ',
    message: 'ลิงก์อาจไม่ถูกต้อง หรือหน้านี้ถูกย้ายไปแล้ว กรุณาสแกน QR Code อีกครั้ง',
  });
}

export function errorPage({ status = 500, detail } = {}) {
  if (status >= 400 && status < 500) {
    return renderMessagePage({
      title: 'คำขอไม่ถูกต้อง',
      heading: 'คำขอไม่ถูกต้อง',
      message: 'กรุณาตรวจสอบลิงก์แล้วลองใหม่อีกครั้ง',
      detail,
    });
  }
  return renderMessagePage({
    title: 'เกิดข้อผิดพลาด',
    heading: 'ขออภัย ระบบขัดข้องชั่วคราว',
    message: 'กรุณาลองใหม่อีกครั้งในอีกสักครู่',
    detail,
  });
}
