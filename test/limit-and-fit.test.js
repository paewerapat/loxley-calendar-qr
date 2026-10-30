// Task 06: monthly limit 40 MiB ("40 MB" for customers) and the player always
// fitting the screen. Static checks (no database).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { APP_ROOT } from '../src/config.js';
import { SIZE_LIMITS, formatSize, formatSizeBinary } from '../src/videos.js';
import { tooLargeError, toAdminRow } from '../src/video-files.js';

test('AC1: one constant — monthly 40 MiB (41,943,040 bytes), e-card still 100 MiB', () => {
  assert.equal(SIZE_LIMITS.monthly, 41_943_040);
  assert.equal(SIZE_LIMITS.ecard, 104_857_600);
  assert.equal(formatSize(SIZE_LIMITS.monthly), '40 MB');
  assert.equal(formatSizeBinary(SIZE_LIMITS.monthly), '40 MiB');
  const row = toAdminRow({ slug: 'm01', title: 't', kind: 'monthly', sort_order: 1, r2_key: null });
  assert.equal(row.limitBytes, 41_943_040);
  assert.equal(row.limitLabel, '40 MB');
  assert.equal(tooLargeError('monthly', 41_943_041).userMessage, 'ไฟล์ใหญ่เกิน 40 MB (วีดีโอรายเดือนรับได้ไม่เกิน 40 MB)');
});

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(p));
    else if (/\.(js|css|html|md)$/.test(entry.name)) out.push(p);
  }
  return out;
}

test('AC2: no "20 MB" / "20 MiB" monthly limit left in src/, public/ or README.md', async () => {
  const files = [...await filesUnder(path.join(APP_ROOT, 'src')), ...await filesUnder(path.join(APP_ROOT, 'public')),
    path.join(APP_ROOT, 'README.md')];
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    assert.doesNotMatch(text, /\b20\s?(MB|MiB)\b|20 \* MIB|20971520/, path.relative(APP_ROOT, f));
  }
  const readme = await readFile(path.join(APP_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /วีดีโอรายเดือน ไม่เกิน \*\*40 MB\*\*/);
});

test('AC3: player.css keeps the whole video on screen (viewport-limited height, contain, dvh + vh fallback)', async () => {
  const css = await readFile(path.join(APP_ROOT, 'public', 'assets', 'player.css'), 'utf8');
  const video = css.match(/(^|\n)video\s*\{([^}]*)\}/)[2];
  assert.match(video, /width:\s*100%/, 'still full width (16:9 on portrait phones unchanged)');
  assert.match(video, /height:\s*auto/);
  assert.match(video, /object-fit:\s*contain/, 'the full frame is always visible');
  const vh = video.indexOf('max-height: calc(100vh - var(--chrome))');
  const dvh = video.indexOf('max-height: calc(100dvh - var(--chrome))');
  assert.ok(vh >= 0 && dvh > vh, 'dvh limit, after a vh fallback');
  // The room kept for the hint + page padding really covers them.
  const chrome = Number(css.match(/--chrome:\s*(\d+)px/)[1]);
  const gutter = Number(css.match(/--gutter:\s*(\d+)px/)[1]);
  const hint = css.match(/\.hint\s*\{([^}]*)\}/)[1];
  const hintMargin = Number(hint.match(/margin:\s*(\d+)px/)[1]);
  const hintLine = Number(hint.match(/font-size:\s*(\d+)px/)[1]) * Number(hint.match(/line-height:\s*([\d.]+)/)[1]);
  assert.ok(chrome >= 2 * gutter + hintMargin + hintLine, `--chrome ${chrome}px covers padding + hint`);
  // No scrollbars and the overlays stay centred on the video box.
  const body = css.match(/(^|\n)body\s*\{([^}]*)\}/)[2];
  assert.match(body, /overflow:\s*hidden/);
  assert.match(body, /box-sizing:\s*border-box/);
  assert.match(css, /\.stage\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.sound\s*\{[^}]*left:\s*50%;\s*top:\s*50%/);
  assert.match(css, /\.replay\s*\{[^}]*left:\s*50%;\s*top:\s*50%;\s*transform:\s*translate\(-50%,\s*-50%\)/);
});
