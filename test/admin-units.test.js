// Task 04: small units (no database) — sizes, Thai time, QR file names, admin rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSize, formatSizeBinary, formatBytes, formatBangkok, SIZE_LIMITS } from '../src/videos.js';
import { qrFileNames, attachmentHeader, qrTargetUrl } from '../src/qr.js';
import { toAdminRow, tooLargeError } from '../src/video-files.js';

test('size labels: MB for customers (1024-based, like Windows), exact MiB for the CLI (AC8)', () => {
  assert.equal(SIZE_LIMITS.monthly, 40 * 1024 * 1024);
  assert.equal(SIZE_LIMITS.ecard, 100 * 1024 * 1024);
  assert.equal(formatSize(SIZE_LIMITS.monthly), '40 MB');
  assert.equal(formatSize(SIZE_LIMITS.ecard), '100 MB');
  assert.equal(formatSize(7654321), '7.3 MB');
  assert.equal(formatSize(2048), '2 KB');
  assert.equal(formatSizeBinary(SIZE_LIMITS.monthly), '40 MiB');
  assert.equal(formatSizeBinary(2048), '2 KiB');
  assert.equal(formatSize(10), '10 bytes');
  assert.equal(formatSize(null), '-');
  assert.equal(formatBytes(41943041), '41,943,041 bytes');
  const err = tooLargeError('monthly', 41943041);
  assert.equal(err.message, 'ไฟล์ใหญ่เกินกำหนด: 41,943,041 bytes (ชุด monthly รับได้ไม่เกิน 41,943,040 bytes = 40 MiB)');
  assert.equal(err.userMessage, 'ไฟล์ใหญ่เกิน 40 MB (วีดีโอรายเดือนรับได้ไม่เกิน 40 MB)');
  assert.equal(err.status, 413);
});

test('times are shown in Asia/Bangkok, the database stays UTC', () => {
  assert.equal(formatBangkok(new Date('2026-10-25T10:00:00Z')), '25 ต.ค. 2569 17:00 น.');
  assert.equal(formatBangkok(new Date('2026-12-31T20:30:00Z')), '1 ม.ค. 2570 03:30 น.');
  assert.equal(formatBangkok(null), '-');
});

test('QR file names: readable UTF-8 plus an ASCII fallback, safe characters only', () => {
  assert.deepEqual(qrFileNames({ slug: 'm01', kind: 'monthly', sort_order: 1, title: 'มกราคม 2570' }, 'png'),
    { utf8: 'QR-01-มกราคม.png', ascii: 'QR-01-m01.png' });
  assert.deepEqual(qrFileNames({ slug: 'm12', kind: 'monthly', sort_order: 12, title: 'ธันวาคม 2570' }, 'svg'),
    { utf8: 'QR-12-ธันวาคม.svg', ascii: 'QR-12-m12.svg' });
  assert.deepEqual(qrFileNames({ slug: 'ecard-lee', kind: 'ecard', sort_order: 13, title: 'e-card ปีใหม่ Lee' }, 'png'),
    { utf8: 'QR-ecard-Lee.png', ascii: 'QR-ecard-Lee.png' });
  const odd = qrFileNames({ slug: 'ecard-x', kind: 'ecard', sort_order: 14, title: 'การ์ด "พิเศษ"/ใหม่' }, 'png');
  assert.doesNotMatch(odd.utf8, /["/\\]/);
  assert.equal(odd.ascii, 'QR-ecard-x.png');
  assert.equal(
    attachmentHeader({ utf8: 'QR-01-มกราคม.png', ascii: 'QR-01-m01.png' }),
    "attachment; filename=\"QR-01-m01.png\"; filename*=UTF-8''QR-01-%E0%B8%A1%E0%B8%81%E0%B8%A3%E0%B8%B2%E0%B8%84%E0%B8%A1.png",
  );
  assert.equal(qrTargetUrl('https://wjasmin.site', 'm01'), 'https://wjasmin.site/v/m01');
});

test('admin rows carry what the page needs and nothing about storage', () => {
  const r = toAdminRow({
    slug: 'm01', title: 'มกราคม 2570', kind: 'monthly', sort_order: 1, r2_key: 'videos/m01/1792832980123.mp4',
    size_bytes: 1048576, updated_at: new Date('2026-10-25T10:00:00Z'), updated_by: 'client',
  });
  assert.equal(r.hasVideo, true);
  assert.equal(r.sizeLabel, '1 MB');
  assert.equal(r.updatedText, '25 ต.ค. 2569 17:00 น. โดย client');
  assert.equal(r.limitBytes, SIZE_LIMITS.monthly);
  assert.ok(!JSON.stringify(r).includes('videos/m01'));
  const empty = toAdminRow({ slug: 'm02', title: 'x', kind: 'monthly', sort_order: 2, r2_key: null, size_bytes: null, updated_at: null, updated_by: null });
  assert.equal(empty.statusLabel, 'ยังไม่มีวีดีโอ');
  assert.equal(empty.sizeLabel, '-');
  assert.equal(empty.updatedText, '-');
});
