// Cache busting for the shared player assets. On Plesk nginx serves public/
// directly (with its own caching), so the page references them as
// /assets/player.js?v=<hash of the content>: a new deploy means a new URL.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function contentHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 10);
}

// Read once at createApp time (files only change with a deploy + restart).
export function playerAssetUrls(publicDir) {
  const url = (name) => {
    const content = readFileSync(path.join(publicDir, 'assets', name));
    return `/assets/${name}?v=${contentHash(content)}`;
  };
  return { css: url('player.css'), js: url('player.js') };
}
