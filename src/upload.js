// Back-office video upload (deployment option C): the file is streamed with busboy
// straight into STORAGE_DIR/tmp/ (never held in memory), checked, moved to
// videos/<slug>/<epoch-ms>.mp4 (rule 2: new name for every upload), then the set is
// pointed at it in one short transaction. The previous file is deleted only after
// the commit. Every failure removes the temporary file and answers JSON with a
// machine `code` and a Thai `message`.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import busboy from 'busboy';
import { findVideo, resolveMediaFile, SLUG_RE, VIDEO_MIME } from './videos.js';
import {
  VideoFileError, sizeLimit, tooLargeError, checkVideoFile, commitVideoFile,
} from './video-files.js';
import { withLockRetry, ThrottleBusyError } from './throttle.js';

export const TMP_DIRNAME = 'tmp';
const MULTIPART_SLACK = 64 * 1024; // room for multipart headers around the file
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const uploadError = (code, status, message) => new VideoFileError(code, message, { status, userMessage: message });
export const UPLOAD_ERRORS = {
  notFound: () => uploadError('not_found', 404, 'ไม่พบชุดนี้'),
  badRequest: () => uploadError('bad_request', 400, 'ข้อมูลที่ส่งมาไม่ถูกต้อง กรุณาเลือกไฟล์แล้วลองใหม่'),
  noFile: () => uploadError('no_file', 400, 'ไม่พบไฟล์ที่ส่งมา กรุณาเลือกไฟล์วีดีโอ'),
  tooManyFiles: () => uploadError('too_many_files', 400, 'อัปโหลดได้ครั้งละ 1 ไฟล์เท่านั้น'),
  notMp4Type: () => uploadError('not_mp4', 415, 'ไฟล์นี้ไม่ใช่วีดีโอ MP4 กรุณาเลือกไฟล์ .mp4'),
  storageFull: () => uploadError('storage_full', 507, 'พื้นที่เก็บไฟล์บนเซิร์ฟเวอร์เต็ม กรุณาติดต่อผู้ดูแลระบบ'),
  storageError: () => uploadError('storage_error', 500, 'บันทึกไฟล์ไม่สำเร็จ กรุณาลองใหม่ หรือติดต่อผู้ดูแลระบบ'),
  busy: () => uploadError('busy', 503, 'ระบบกำลังยุ่ง กรุณาลองใหม่อีกครั้ง'),
  aborted: () => uploadError('aborted', 400, 'การอัปโหลดถูกยกเลิก'),
};

function storageFailure(err) {
  console.error(`[upload] storage error: ${err.code ?? err.message}`);
  return ['ENOSPC', 'EDQUOT'].includes(err.code) ? UPLOAD_ERRORS.storageFull() : UPLOAD_ERRORS.storageError();
}

async function removeQuietly(file) {
  if (!file) return;
  await fs.promises.unlink(file).catch((err) => {
    if (err.code !== 'ENOENT') console.error(`[upload] could not remove ${path.basename(file)}: ${err.code}`);
  });
}

/**
 * Stream the single multipart file of `req` into tmpDir. Resolves once the request
 * body is fully consumed and the file is on disk; on any failure the temp file is
 * gone before the promise rejects (with a VideoFileError).
 * @returns {Promise<{ tmpFile: string, size: number }>}
 */
export function receiveFile(req, { tmpDir, limit, kind }) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      // busboy reports 'limit' as soon as fileSize bytes have arrived, so allow one
      // byte more: a file of exactly `limit` bytes passes, and the shared
      // checkVideoFile makes the final size > limit decision (same as CLI/browser).
      bb = busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: limit + 1, fields: 10, parts: 20, fieldSize: 1024 },
      });
    } catch {
      reject(UPLOAD_ERRORS.badRequest()); // not multipart/form-data
      req.resume();
      return;
    }

    let failure = null;
    let tmpFile = null;
    let ws = null;
    let size = 0;
    let fileSeen = false;
    let writeClosed = Promise.resolve();
    let settled = false;
    const fail = (err) => { failure ??= err; };

    const settle = async () => {
      if (settled) return;
      settled = true;
      await writeClosed;
      if (!failure && !fileSeen) failure = UPLOAD_ERRORS.noFile();
      if (failure) {
        await removeQuietly(tmpFile);
        reject(failure);
      } else {
        resolve({ tmpFile, size });
      }
    };

    bb.on('file', (name, stream, info) => {
      fileSeen = true;
      if (info.mimeType !== VIDEO_MIME) {
        fail(UPLOAD_ERRORS.notMp4Type());
        stream.resume();
        return;
      }
      tmpFile = path.join(tmpDir, `${Date.now()}-${randomBytes(6).toString('hex')}.part`);
      ws = fs.createWriteStream(tmpFile, { flags: 'wx' });
      writeClosed = new Promise((r) => { ws.once('close', r); });
      ws.on('error', (err) => {
        fail(storageFailure(err));
        stream.unpipe(ws);
        stream.resume(); // keep reading the request so we can still answer
        ws.destroy();
      });
      stream.on('data', (chunk) => { size += chunk.length; });
      stream.on('limit', () => { // busboy stops at fileSize: the file is too big
        fail(tooLargeError(kind));
        stream.unpipe(ws);
        stream.resume();
        ws.end();
      });
      stream.pipe(ws);
    });
    bb.on('filesLimit', () => fail(UPLOAD_ERRORS.tooManyFiles()));
    bb.on('partsLimit', () => fail(UPLOAD_ERRORS.badRequest()));
    bb.on('fieldsLimit', () => fail(UPLOAD_ERRORS.badRequest()));
    bb.on('error', () => {
      fail(UPLOAD_ERRORS.badRequest());
      ws?.destroy();
      settle();
    });
    bb.on('close', settle);

    // Client cancelled or the connection dropped mid-way: stop and clean up.
    const onAbort = () => {
      if (settled || req.complete) return;
      fail(UPLOAD_ERRORS.aborted());
      req.unpipe(bb);
      ws?.destroy();
      settle();
    };
    req.on('aborted', onAbort);
    req.on('close', onAbort);
    req.on('error', onAbort);
    req.pipe(bb);
  });
}

// Move tmp → videos/<slug>/<epoch-ms>.mp4 without ever overwriting a file
// (link fails with EEXIST; two uploads in the same millisecond get different names).
async function placeFile(storageDir, slug, tmpFile) {
  const dir = path.join(storageDir, 'videos', slug);
  await fs.promises.mkdir(dir, { recursive: true });
  for (let i = 0; i < 20; i++) {
    const key = `videos/${slug}/${Date.now() + i}.mp4`;
    const finalFile = path.join(storageDir, ...key.split('/'));
    try {
      await fs.promises.link(tmpFile, finalFile);
      await removeQuietly(tmpFile);
      return { key, finalFile };
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(err.code)) throw err;
      // File system without hard links: copy with COPYFILE_EXCL (fails instead of
      // overwriting an existing name), then drop the temp file.
      try {
        await fs.promises.copyFile(tmpFile, finalFile, fs.constants.COPYFILE_EXCL);
      } catch (copyErr) {
        if (copyErr.code === 'EEXIST') continue;
        await removeQuietly(finalFile);
        throw copyErr;
      }
      await removeQuietly(tmpFile);
      return { key, finalFile };
    }
  }
  throw Object.assign(new Error('no free file name'), { code: 'EEXIST' });
}

/**
 * Whole upload for one set. Returns { slug, key, size, video } after the commit; throws VideoFileError
 * (with HTTP status + Thai userMessage) for anything the customer should see.
 */
export async function handleUpload(req, { pool, storageDir, slug, username }) {
  if (!SLUG_RE.test(slug)) throw UPLOAD_ERRORS.notFound();
  const video = await findVideo(pool, slug);
  if (!video) throw UPLOAD_ERRORS.notFound();
  const limit = sizeLimit(video.kind);

  // Declared far bigger than allowed: refuse without storing anything.
  const declared = Number(req.get('content-length'));
  if (Number.isFinite(declared) && declared > limit + MULTIPART_SLACK) {
    req.resume();
    throw tooLargeError(video.kind);
  }

  const tmpDir = path.join(storageDir, TMP_DIRNAME);
  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
  } catch (err) {
    req.resume();
    throw storageFailure(err);
  }

  const { tmpFile, size } = await receiveFile(req, { tmpDir, limit, kind: video.kind });

  let placed = null;
  try {
    await checkVideoFile({ kind: video.kind, file: tmpFile, size });
    try {
      placed = await placeFile(storageDir, slug, tmpFile);
    } catch (err) {
      throw storageFailure(err);
    }
    // Short transaction (row lock on this set only); file I/O happens outside it.
    const { previousKey } = await withLockRetry(
      () => commitVideoFile(pool, { slug, key: placed.key, size, updatedBy: username }),
    );
    console.log(`[upload] ${slug} → ${placed.key} (${size} bytes) by ${username}`);
    await deleteOldFile(storageDir, previousKey, placed.key);
    return { slug, key: placed.key, size, video };
  } catch (err) {
    await removeQuietly(tmpFile);
    if (placed) await removeUnlessReferenced(pool, slug, placed);
    if (err instanceof ThrottleBusyError) throw UPLOAD_ERRORS.busy();
    throw err;
  }
}

// The commit failed (or its outcome is unknown, e.g. the connection dropped during
// COMMIT). Remove the placed file only if the database really does not point at
// it; if we cannot tell, keep it: an orphan file beats a set pointing at nothing.
async function removeUnlessReferenced(pool, slug, placed) {
  try {
    const [rows] = await pool.query('SELECT r2_key FROM videos WHERE slug = ?', [slug]);
    if (rows[0]?.r2_key === placed.key) {
      console.error(`[upload] ${slug}: commit reported an error but the set points at ${placed.key}; keeping it`);
      return;
    }
  } catch (err) {
    console.error(`[upload] ${slug}: could not re-check after a failed commit (${err.code ?? err.message}); keeping ${placed.key}`);
    return;
  }
  await removeQuietly(placed.finalFile); // never committed: no orphan
}

// Only after the commit; a failure is logged and never fails the request.
async function deleteOldFile(storageDir, previousKey, newKey) {
  if (!previousKey || previousKey === newKey) return;
  const old = await resolveMediaFile(storageDir, previousKey);
  if (!old) return;
  try {
    await fs.promises.unlink(old.file);
  } catch (err) {
    console.error(`[upload] could not delete old file ${previousKey}: ${err.code ?? err.message}`);
  }
}

// At startup: temp files left by a crash or a killed process, older than a day.
export async function cleanupStaleTmp(storageDir, { maxAgeMs = TMP_MAX_AGE_MS, now = Date.now() } = {}) {
  const dir = path.join(storageDir, TMP_DIRNAME);
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[upload] tmp cleanup: ${err.code}`);
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fs.promises.stat(file);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(file);
        removed += 1;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[upload] tmp cleanup ${name}: ${err.code}`);
    }
  }
  if (removed) console.log(`[upload] removed ${removed} stale temp file(s)`);
  return removed;
}
