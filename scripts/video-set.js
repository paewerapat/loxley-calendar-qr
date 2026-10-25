// `npm run video:set -- <slug> <videos/<slug>/<epoch>.mp4>`
// On Plesk run it from Node.js → "Run Node.js commands". Uses DB_* and STORAGE_DIR
// from the environment only (no env file is loaded here).

import { loadConfig, ConfigError } from '../src/config.js';
import { createPool } from '../src/db.js';
import { setVideo, VideoSetError } from '../src/video-set.js';

const [slug, key] = process.argv.slice(2);
let pool;
try {
  const config = loadConfig(process.env, { scope: 'storage' }); // no SESSION_SECRET/PORT needed
  pool = createPool(config.db);
  const result = await setVideo({ pool, storageDir: config.storageDir, slug, key });
  console.log(`[video:set] ${result.slug} → ${result.key} (${result.size} bytes)`);
  if (result.previousKey && result.previousKey !== result.key) {
    console.log(`[video:set] ไฟล์เก่ายังอยู่ (ไม่ได้ลบ): ${result.previousKey} ใน STORAGE_DIR`);
  }
} catch (err) {
  if (err instanceof ConfigError || err instanceof VideoSetError) {
    console.error(`[video:set] ${err.message}`);
  } else {
    console.error(`[video:set] failed: ${err.code ?? ''} ${err.message}`.trim());
  }
  process.exitCode = 1;
} finally {
  await pool?.end().catch(() => {});
}
