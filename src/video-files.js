// Shared "point a set at a video file" logic, used by both `npm run video:set`
// and the back-office upload, so the checks and the database write are identical.

import {
  SIZE_LIMITS, formatSize, formatSizeBinary, formatBytes, formatBangkok, hasFtypBox,
} from './videos.js';

export class VideoFileError extends Error {
  /**
   * @param {string} code     machine code (too_large, not_mp4, ...)
   * @param {string} message  detailed Thai message (CLI / logs)
   * @param {object} [opts]
   * @param {number} [opts.status]       HTTP status for the upload API
   * @param {string} [opts.userMessage]  short Thai message for the customer
   */
  constructor(code, message, { status = 400, userMessage = message } = {}) {
    super(message);
    this.name = 'VideoFileError';
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
  }
}

const KIND_LABEL = { monthly: 'วีดีโอรายเดือน', ecard: 'e-card' };

export function sizeLimit(kind) {
  const limit = SIZE_LIMITS[kind];
  if (!limit) throw new VideoFileError('bad_kind', `ไม่รู้จัก kind ${kind}`, { status: 500 });
  return limit;
}

export function tooLargeError(kind, size) {
  const limit = sizeLimit(kind);
  const sizeText = size == null ? '' : `: ${formatBytes(size)}`;
  return new VideoFileError(
    'too_large',
    `ไฟล์ใหญ่เกินกำหนด${sizeText} (ชุด ${kind} รับได้ไม่เกิน ${formatBytes(limit)} = ${formatSizeBinary(limit)})`,
    { status: 413, userMessage: `ไฟล์ใหญ่เกิน ${formatSize(limit)} (${KIND_LABEL[kind]}รับได้ไม่เกิน ${formatSize(limit)})` },
  );
}

export function notMp4Error(label = 'ไฟล์นี้') {
  return new VideoFileError(
    'not_mp4',
    `${label} ไม่ใช่ MP4 (ไม่พบ box ftyp ที่ต้นไฟล์)`,
    { status: 415, userMessage: 'ไฟล์นี้ไม่ใช่วีดีโอ MP4 กรุณาเลือกไฟล์ .mp4' },
  );
}

/** Size limit for the set's kind, then the MP4 signature. Throws VideoFileError. */
export async function checkVideoFile({ kind, file, size, label }) {
  if (size > sizeLimit(kind)) throw tooLargeError(kind, size);
  if (!(await hasFtypBox(file))) throw notMp4Error(label);
}

/**
 * Point the set at `key` in one short transaction (row lock on that set only).
 * Returns the key it pointed at before, read under the same lock, so the caller
 * can delete exactly that file after the commit.
 * @returns {Promise<{ previousKey: string|null }>}
 */
export async function commitVideoFile(pool, { slug, key, size, updatedBy }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT r2_key FROM videos WHERE slug = ? FOR UPDATE', [slug]);
    if (rows.length === 0) {
      throw new VideoFileError('not_found', `ไม่พบชุด ${slug} ในตาราง videos`, { status: 404, userMessage: 'ไม่พบชุดนี้' });
    }
    await conn.query(
      'UPDATE videos SET r2_key = ?, size_bytes = ?, updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE slug = ?',
      [key, size, updatedBy, slug],
    );
    await conn.commit();
    return { previousKey: rows[0].r2_key ?? null };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

const ROW_COLUMNS = 'slug, title, kind, sort_order, r2_key, size_bytes, updated_at, updated_by';

export async function listVideoRows(pool) {
  const [rows] = await pool.query(`SELECT ${ROW_COLUMNS} FROM videos ORDER BY sort_order, slug`);
  return rows;
}

export async function getVideoRow(pool, slug) {
  const [rows] = await pool.query(`SELECT ${ROW_COLUMNS} FROM videos WHERE slug = ?`, [slug]);
  return rows[0] ?? null;
}

/**
 * What the back office needs about one set: no storage paths, sizes and times
 * already formatted for people (Thai time), limits for the browser-side check.
 */
export function toAdminRow(row, { fileExists = Boolean(row.r2_key) } = {}) {
  const limit = SIZE_LIMITS[row.kind] ?? null;
  // Same rule as /v/<slug>: a set "has a video" only when its file is really there.
  // A key whose file is gone (deleted by hand, bad restore...) is flagged so the
  // back office can ask for a new upload.
  const hasVideo = Boolean(row.r2_key) && fileExists;
  const fileMissing = Boolean(row.r2_key) && !fileExists;
  const updatedAt = row.updated_at instanceof Date ? row.updated_at : null;
  return {
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    sortOrder: row.sort_order,
    hasVideo,
    fileMissing,
    statusLabel: hasVideo ? 'มีวีดีโอแล้ว' : 'ยังไม่มีวีดีโอ',
    sizeBytes: hasVideo && row.size_bytes != null ? Number(row.size_bytes) : null,
    sizeLabel: hasVideo && row.size_bytes != null ? formatSize(row.size_bytes) : '-',
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    updatedAtLabel: formatBangkok(updatedAt),
    updatedBy: row.updated_by ?? null,
    updatedText: updatedAt
      ? `${formatBangkok(updatedAt)}${row.updated_by ? ` โดย ${row.updated_by}` : ''}`
      : '-',
    limitBytes: limit,
    limitLabel: limit ? formatSize(limit) : '-',
    viewPath: `/v/${row.slug}`,
    qrPng: `/admin/qr/${row.slug}.png`,
    qrSvg: `/admin/qr/${row.slug}.svg`,
  };
}
