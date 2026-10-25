// Public routes: the QR landing page /v/<slug> and the video files under /media.

import { findVideo, resolveMediaFile, SLUG_RE } from './videos.js';
import { videoPage, comingSoonPage } from './pages.js';
import { playerAssetUrls } from './assets.js';

const IMMUTABLE = 'public, max-age=31536000, immutable';

export function mountVideoRoutes(app, { config, pool }) {
  const assets = playerAssetUrls(config.publicDir);

  // Express 5 routing is non-strict, so this also matches /v/<slug>/ (the printed
  // e-card QR has a trailing slash). No redirect either way.
  app.get('/v/:slug', async (req, res, next) => {
    res.set('Cache-Control', 'no-cache'); // also on 404: a new video shows up at once
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return next();

    const video = await findVideo(pool, slug);
    if (!video) return next();

    const media = video.r2_key ? await resolveMediaFile(config.storageDir, video.r2_key) : null;
    const html = media
      ? videoPage({ title: video.title, src: `/media/${video.r2_key}`, assets })
      : comingSoonPage({ title: video.title, kind: video.kind });
    res.status(200).type('html').send(html);
  });

  // GET/HEAD /media/videos/<slug>/<epoch>.mp4 → file under STORAGE_DIR, with Range.
  app.use('/media', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // req.path is still percent-encoded: a valid key never contains '%', so encoded
    // dots/slashes (%2e, %2f, %5c) are rejected before anything touches the disk.
    const key = req.path.slice(1);
    if (key.includes('%')) return next();
    const media = await resolveMediaFile(config.storageDir, key);
    if (!media) return next();

    res.set('Content-Type', 'video/mp4');
    // send streams the file and handles Range (206 / Content-Range / 416).
    res.sendFile(media.file, {
      acceptRanges: true,
      cacheControl: false,
      dotfiles: 'allow', // key is already restricted to videos/<slug>/<digits>.mp4
      headers: { 'Cache-Control': IMMUTABLE },
    }, (err) => {
      if (!err) return;
      if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' || res.headersSent) return;
      if (err.status === 416 || err.statusCode === 416) {
        // Content-Range: bytes */<size> is already set by send. Drop the video
        // headers so an error response is never cached for a year.
        res.removeHeader('Cache-Control');
        res.removeHeader('Content-Type');
        res.status(416).end();
        return;
      }
      if (err.status === 404 || err.code === 'ENOENT') {
        res.removeHeader('Content-Type');
        res.removeHeader('Cache-Control');
        next();
        return;
      }
      next(err);
    });
  });
}
