// Logic behind `npm run video:set -- <slug> <path>`: point a video row at a file that
// is already in STORAGE_DIR (e.g. uploaded by FTP). Every check runs before the
// single UPDATE, so a failed check never changes the database. Old files are kept.

import { findVideo, resolveMediaFile, hasFtypBox, SLUG_RE, MEDIA_KEY_RE, SIZE_LIMITS } from './videos.js';

export class VideoSetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VideoSetError';
  }
}

// Exact byte counts: rounding to MB would print e.g. "20.0MB over 20.0MB".
const fmtBytes = (bytes) => `${bytes.toLocaleString('en-US')} bytes`;
const fmtLimit = (bytes) => `${fmtBytes(bytes)} = ${bytes / (1024 * 1024)}MB`;

/**
 * @returns {Promise<{ slug: string, key: string, size: number, previousKey: string|null }>}
 */
export async function setVideo({ pool, storageDir, slug, key, updatedBy = 'cli' }) {
  if (!slug || !key) {
    throw new VideoSetError('วิธีใช้: npm run video:set -- <slug> <videos/<slug>/<epoch>.mp4>');
  }
  if (!SLUG_RE.test(slug)) throw new VideoSetError(`slug ไม่ถูกรูปแบบ: ${slug}`);
  if (!MEDIA_KEY_RE.test(key)) {
    throw new VideoSetError(`path ต้องเป็นรูปแบบ videos/<slug>/<epoch>.mp4 (สัมพัทธ์กับ STORAGE_DIR): ${key}`);
  }
  if (key.split('/')[1] !== slug) {
    throw new VideoSetError(`path ต้องอยู่ในโฟลเดอร์ videos/${slug}/ ของชุดนี้: ${key}`);
  }

  const video = await findVideo(pool, slug);
  if (!video) throw new VideoSetError(`ไม่พบชุด ${slug} ในตาราง videos`);

  const media = await resolveMediaFile(storageDir, key);
  if (!media) throw new VideoSetError(`ไม่พบไฟล์ ${key} ใน STORAGE_DIR (หรือไม่ใช่ไฟล์ปกติ)`);

  const limit = SIZE_LIMITS[video.kind];
  if (!limit) throw new VideoSetError(`ไม่รู้จัก kind ${video.kind} ของชุด ${slug}`);
  if (media.size > limit) {
    throw new VideoSetError(`ไฟล์ใหญ่เกินกำหนด: ${fmtBytes(media.size)} (ชุด ${video.kind} รับได้ไม่เกิน ${fmtLimit(limit)})`);
  }
  if (!(await hasFtypBox(media.file))) {
    throw new VideoSetError(`ไฟล์ ${key} ไม่ใช่ MP4 (ไม่พบ box ftyp ที่ต้นไฟล์)`);
  }

  await pool.query(
    'UPDATE videos SET r2_key = ?, size_bytes = ?, updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE slug = ?',
    [key, media.size, updatedBy, slug],
  );

  return { slug, key, size: media.size, previousKey: video.r2_key ?? null };
}
