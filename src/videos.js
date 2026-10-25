// Rules shared by the public pages, /media and the video:set CLI.

import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isInsideOrEqual } from './config.js';

export const SLUG_RE = /^[a-z0-9-]{1,40}$/;

// r2_key with deployment option C: path relative to STORAGE_DIR, timestamped
// file name (rule 2), e.g. videos/ecard-lee/1792832980.mp4
export const MEDIA_KEY_RE = /^videos\/[a-z0-9-]{1,40}\/[0-9]{9,13}\.mp4$/;

const MB = 1024 * 1024;
export const SIZE_LIMITS = { monthly: 20 * MB, ecard: 100 * MB };

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
