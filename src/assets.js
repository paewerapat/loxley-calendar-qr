// Cache busting for the shared player assets. On Plesk nginx serves public/
// directly (with its own caching), so the page references them as
// /assets/player.js?v=<hash of the content>: a new deploy means a new URL.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function contentHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 10);
}

// Read once at createApp time (files only change with a deploy + restart). A missing
// file must not stop the app (the QR pages and back office still work): log it
// without the full path and fall back to the plain URL.
function assetUrls(publicDir, base, log) {
  const url = (name) => {
    try {
      const content = readFileSync(path.join(publicDir, 'assets', name));
      return `/assets/${name}?v=${contentHash(content)}`;
    } catch (err) {
      log(`[assets] missing assets/${name} (${err.code ?? 'error'}); serving it without ?v=`);
      return `/assets/${name}`;
    }
  };
  return { css: url(`${base}.css`), js: url(`${base}.js`) };
}

export function playerAssetUrls(publicDir, { log = console.error } = {}) {
  return assetUrls(publicDir, 'player', log);
}

// Back-office page (public/assets/admin.css + admin.js), same ?v= scheme.
export function adminAssetUrls(publicDir, { log = console.error } = {}) {
  return assetUrls(publicDir, 'admin', log);
}
