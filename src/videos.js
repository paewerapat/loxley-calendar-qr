// Rules shared by the public pages, /media and the video:set CLI.

import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isInsideOrEqual } from './config.js';

export const SLUG_RE = /^[a-z0-9-]{1,40}$/;

// r2_key with deployment option C: path relative to STORAGE_DIR, timestamped
// file name (rule 2), e.g. videos/ecard-lee/1792832980.mp4
export const MEDIA_KEY_RE = /^videos\/[a-z0-9-]{1,40}\/[0-9]{9,13}\.mp4$/;

// Size limits per kind, in MiB (1 MiB = 1,048,576 bytes; a file shown as "40 MB"
// by any phone or computer fits in 40 MiB). The single source for the CLI, the
// upload route and the browser (sent to the page via data attributes / JSON).
const MIB = 1024 * 1024;
export const SIZE_LIMITS = { monthly: 40 * MIB, ecard: 100 * MIB };
export const VIDEO_MIME = 'video/mp4';

function sizeText(bytes, mega, kilo) {
  const n = bytes == null ? NaN : Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n >= MIB) {
    const v = n / MIB;
    return `${Number.isInteger(v) ? v : v.toFixed(1)} ${mega}`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)} ${kilo}`;
  return `${n} bytes`;
}

// For customers (page, API, upload messages): "40 MB", "7.3 MB" — computed in
// 1024-based units, the way Windows labels sizes, so a file the customer's
// computer shows as 40 MB always fits the 40 MiB limit.
export const formatSize = (bytes) => sizeText(bytes, 'MB', 'KB');

// For the operator (CLI messages): exact binary units, "40 MiB".
export const formatSizeBinary = (bytes) => sizeText(bytes, 'MiB', 'KiB');

// Exact bytes, for messages where rounding would hide the difference.
export const formatBytes = (bytes) => `${Number(bytes).toLocaleString('en-US')} bytes`;

const BANGKOK = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
// DB times are UTC; people read them in Thai time.
export function formatBangkok(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? `${BANGKOK.format(date)} น.` : '-';
}

export async function findVideo(pool, slug) {
  const [rows] = await pool.query(
    'SELECT slug, title, kind, r2_key, size_bytes FROM videos WHERE slug = ?',
    [slug],
  );
  return rows[0] ?? null;
}

/**
 * Resolve a media key to a regular file that really lives under storageDir
 * (symlinks followed). Returns { file, size } or null; never throws for
 * missing/invalid paths so callers can answer 404 without leaking anything.
 */
export async function resolveMediaFile(storageDir, key) {
  if (typeof key !== 'string' || !MEDIA_KEY_RE.test(key)) return null;
  try {
    const root = await realpath(storageDir);
    const file = await realpath(path.resolve(root, key));
    if (!isInsideOrEqual(file, root) || file === root) return null;
    const st = await stat(file);
    if (!st.isFile()) return null;
    return { file, size: st.size };
  } catch {
    return null;
  }
}

// MP4/ISO-BMFF files start with a box whose type (bytes 4–7) is 'ftyp'.
export async function hasFtypBox(file) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(8);
    const { bytesRead } = await fh.read(buf, 0, 8, 0);
    return bytesRead === 8 && buf.toString('latin1', 4, 8) === 'ftyp';
  } finally {
    await fh.close();
  }
}
