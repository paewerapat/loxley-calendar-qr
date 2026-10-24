// Server-rendered HTML pages (Thai, black background, gold text). No external assets.

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
