// QR codes for printing: always point at /v/<slug> (rule 1), never at a video file.

import QRCode from 'qrcode';

export const QR_OPTIONS = { errorCorrectionLevel: 'Q', margin: 4 };
export const QR_PNG_WIDTH = 2000; // print size

export function qrTargetUrl(baseOrigin, slug) {
  return `${baseOrigin}/v/${slug}`;
}

export function qrPng(url) {
  return QRCode.toBuffer(url, { ...QR_OPTIONS, type: 'png', width: QR_PNG_WIDTH });
}

// SVG with a viewBox: scales to any print size without blurring.
export function qrSvg(url) {
  return QRCode.toString(url, { ...QR_OPTIONS, type: 'svg' });
}

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g;
const clean = (s) => String(s).replace(UNSAFE, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const ascii = (s) => clean(s).replace(/[^\x20-\x7e]/g, '');

/**
 * Names a person can read: QR-01-มกราคม.png, QR-ecard-Lee.png, plus an ASCII
 * fallback (QR-01-m01.png, QR-ecard-lee.png) for old clients.
 */
export function qrFileNames(row, ext) {
  let readable;
  let fallback;
  if (row.kind === 'monthly') {
    const nn = String(row.sort_order).padStart(2, '0');
    const month = String(row.title).replace(/\s*\d{4}\s*$/, '');
    readable = `QR-${nn}-${clean(month)}`;
    fallback = `QR-${nn}-${ascii(row.slug)}`;
  } else {
    const words = String(row.title).trim().split(/\s+/);
    const name = clean(words[words.length - 1] || row.slug);
    readable = `QR-ecard-${name}`;
    fallback = ascii(readable) === readable ? readable : `QR-${ascii(row.slug)}`;
  }
  return { utf8: `${readable}.${ext}`, ascii: `${fallback}.${ext}` };
}

const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function attachmentHeader({ utf8, ascii: fallback }) {
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(utf8)}`;
}
