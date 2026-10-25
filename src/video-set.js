// Logic behind `npm run video:set -- <slug> <path>`: point a video row at a file that
// is already in STORAGE_DIR (e.g. uploaded by FTP). Every check runs before the
// database write, so a failed check never changes the database. Old files are kept.
// The checks and the write are shared with the back-office upload (video-files.js).

import { findVideo, resolveMediaFile, SLUG_RE, MEDIA_KEY_RE } from './videos.js';
import { checkVideoFile, commitVideoFile, VideoFileError } from './video-files.js';

export class VideoSetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VideoSetError';
  }
}

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

  try {
    await checkVideoFile({ kind: video.kind, file: media.file, size: media.size, label: `ไฟล์ ${key}` });
    const { previousKey } = await commitVideoFile(pool, { slug, key, size: media.size, updatedBy });
    return { slug, key, size: media.size, previousKey };
  } catch (err) {
    if (err instanceof VideoFileError) throw new VideoSetError(err.message);
    throw err;
  }
}
