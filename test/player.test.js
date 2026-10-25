// Task 02 AC2: behaviour of public/assets/player.js, run in a vm with a tiny fake DOM
// (no browser available in CI). Real-device checks (iPhone/Android/LINE) stay manual.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { APP_ROOT } from '../src/config.js';

const PLAYER_JS = await readFile(path.join(APP_ROOT, 'public', 'assets', 'player.js'), 'utf8');

function makeEl(id, extra = {}) {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  return {
    id,
    hidden: false,
    dataset: {},
    attrs,
    offsetWidth: 0,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute(k, v) { attrs[k] = String(v); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, event = {}) { for (const fn of listeners[type] ?? []) fn(event); },
    ...extra,
  };
}

/**
 * @param {(call: { muted: boolean, n: number }) => boolean} allowPlay  decides
 *   whether video.play() resolves (true) or rejects with NotAllowedError (false)
 */
function setup(allowPlay) {
  const plays = [];
  const video = makeEl('v', {
    muted: false, paused: true, ended: false, currentTime: 12,
    play() {
      const call = { muted: this.muted, n: plays.length };
      plays.push(call);
      if (allowPlay(call)) { this.paused = false; return Promise.resolve(); }
      const err = new Error('blocked'); err.name = 'NotAllowedError';
      return Promise.reject(err);
    },
  });
  const sound = makeEl('sound');
  const replay = makeEl('replay', { hidden: true });
  const hint = makeEl('hint', { hidden: true });
  const body = makeEl('body');
  const stage = makeEl('stage', { contains: (t) => [stage, video, sound, replay].includes(t) });
  const els = { v: video, stage, sound, replay, hint };
  const docListeners = [];
  const document = {
    getElementById: (id) => els[id] ?? null,
    addEventListener: (type, fn) => { if (type === 'click') docListeners.push(fn); },
  };
  // Dispatch a click like the browser: target listeners first, then bubble to document.
  const click = (target) => {
    let stopped = false;
    target.fire('click', { target, stopPropagation: () => { stopped = true; } });
    if (!stopped) for (const fn of docListeners) fn({ target });
  };
  const timers = [];
  vm.runInNewContext(PLAYER_JS, {
    document,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  return { video, sound, replay, hint, body, stage, plays, click, timers };
}

const flush = () => new Promise((r) => setImmediate(r));

test('autoplay with sound allowed (desktop): plays unmuted, no tap hint', async () => {
  const p = setup(() => true);
  await flush();
  assert.equal(p.plays.length, 1);
  assert.equal(p.plays[0].muted, false);
  assert.equal(p.video.muted, false);
  assert.equal(p.hint.hidden, true);
});

test('sound blocked (mobile): falls back to muted autoplay and shows the tap hint', async () => {
  const p = setup((c) => c.muted);
  await flush();
  assert.deepEqual(p.plays.map((c) => c.muted), [false, true]);
  assert.equal(p.video.muted, true);
  assert.equal(p.hint.hidden, false);
});

test('first tap anywhere restarts from the beginning with sound and hides the hint', async () => {
  let unmutedAllowed = false;
  const p = setup((c) => c.muted || unmutedAllowed);
  await flush();
  unmutedAllowed = true; // a user gesture unlocks sound
  p.click(p.body);
  await flush();
  assert.equal(p.video.currentTime, 0);
  assert.equal(p.video.muted, false);
  assert.equal(p.plays.at(-1).muted, false);
  assert.equal(p.hint.hidden, true);
  assert.equal(p.sound.dataset.state, 'on');
});

test('all autoplay blocked: the first tap starts playback with sound', async () => {
  let gesture = false;
  const p = setup(() => gesture);
  await flush();
  assert.equal(p.hint.hidden, false);
  gesture = true;
  p.click(p.body);
  await flush();
  assert.equal(p.video.muted, false);
  assert.equal(p.plays.at(-1).muted, false);
  assert.equal(p.video.paused, false);
});

test('tapping the video toggles sound and flashes the speaker icon with a Thai label', async () => {
  const p = setup(() => true);
  await flush();
  p.click(p.video);
  assert.equal(p.video.muted, true);
  assert.equal(p.sound.dataset.state, 'off');
  assert.equal(p.sound.attrs['aria-label'], 'ปิดเสียงแล้ว');
  assert.ok(p.sound.classList.contains('show'));
  p.timers.at(-1)(); // fade-out timer
  assert.ok(!p.sound.classList.contains('show'));
  p.click(p.video);
  assert.equal(p.video.muted, false);
  assert.equal(p.sound.dataset.state, 'on');
  assert.equal(p.sound.attrs['aria-label'], 'เปิดเสียงแล้ว');
  assert.equal(p.video.currentTime, 12, 'toggling sound does not restart');
});

test('tapping outside the video (after the first tap) does not toggle sound', async () => {
  const p = setup(() => true);
  await flush();
  p.click(p.body);
  assert.equal(p.video.muted, false);
});

test('ended → "ดูอีกครั้ง" shows; pressing it restarts without toggling sound', async () => {
  const p = setup(() => true);
  await flush();
  p.video.fire('ended');
  assert.equal(p.replay.hidden, false);
  const before = p.plays.length;
  p.click(p.replay);
  await flush();
  assert.equal(p.replay.hidden, true);
  assert.equal(p.video.currentTime, 0);
  assert.equal(p.plays.length, before + 1);
  assert.equal(p.video.muted, false, 'replay keeps the current sound state');
});

test('no-op on a page without the player (coming-soon page)', () => {
  assert.doesNotThrow(() => vm.runInNewContext(PLAYER_JS, {
    document: { getElementById: () => null, addEventListener: () => { throw new Error('should not bind'); } },
    setTimeout, clearTimeout,
  }));
});
