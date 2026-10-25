// Cache busting for static assets. On Plesk nginx serves public/ directly (with its
// own caching), so pages reference them as /assets/<file>?v=<hash of the content>:
// a new deploy means a new URL.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function contentHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 10);
}

// Read once at createApp time (files only change with a deploy + restart). A missing
// file must not stop the app (the QR pages and back office still work): log it
// without the full path and fall back to the plain URL.
export function assetUrl(publicDir, rel, { log = console.error } = {}) {
  try {
    const content = readFileSync(path.join(publicDir, 'assets', ...rel.split('/')));
    return `/assets/${rel}?v=${contentHash(content)}`;
  } catch (err) {
    log(`[assets] missing assets/${rel} (${err.code ?? 'error'}); serving it without ?v=`);
    return `/assets/${rel}`;
  }
}

function pair(publicDir, base, log) {
  return { css: assetUrl(publicDir, `${base}.css`, { log }), js: assetUrl(publicDir, `${base}.js`, { log }) };
}

export function playerAssetUrls(publicDir, { log = console.error } = {}) {
  return pair(publicDir, 'player', log);
}

// Back office: admin.css (shared by every back-office page), admin.js (the video
// list), forms.js (login / change password: show-password toggle, busy button)
// and the self-hosted Sarabun font. The /v/<slug> player loads none of these.
export function adminAssetUrls(publicDir, { log = console.error } = {}) {
  return {
    ...pair(publicDir, 'admin', log),
    formsJs: assetUrl(publicDir, 'forms.js', { log }),
    fontCss: sarabunFontFaces(publicDir, log),
  };
}

// Sarabun (SIL OFL 1.1, from @fontsource/sarabun), weights 400 + 600, Thai + Latin
// subsets only; the browser downloads a subset only when the page uses it.
const SARABUN_RANGES = {
  thai: 'U+02D7,U+0303,U+0331,U+0E01-0E5B,U+200C-200D,U+25CC',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,'
    + 'U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
};
export const SARABUN_FILES = ['thai', 'latin'].flatMap((subset) => [400, 600]
  .map((weight) => ({ subset, weight, rel: `fonts/sarabun-${subset}-${weight}-normal.woff2` })));

function sarabunFontFaces(publicDir, log) {
  return SARABUN_FILES.map(({ subset, weight, rel }) => `@font-face{font-family:"Sarabun";font-style:normal;`
    + `font-weight:${weight};font-display:swap;src:url("${assetUrl(publicDir, rel, { log })}") format("woff2");`
    + `unicode-range:${SARABUN_RANGES[subset]}}`).join('\n');
}
