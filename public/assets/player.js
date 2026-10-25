// /v/<slug> player. Same behaviour as the e-card page the client approved:
// - try to play with sound; if the browser blocks it, play muted and show a tap hint
// - first tap anywhere (while the hint is up) restarts from the beginning with sound
// - tapping the video toggles sound and flashes a speaker icon that fades out
// - when the video ends, show "ดูอีกครั้ง"
(() => {
  const video = document.getElementById('v');
  const stage = document.getElementById('stage');
  const sound = document.getElementById('sound');
  const replayBtn = document.getElementById('replay');
  const hint = document.getElementById('hint');
  if (!video) return;
  let waitingForTap = false;
  let fadeTimer;

  // Pop the speaker icon for the current state, then let CSS fade it out.
  function flashSound() {
    sound.dataset.state = video.muted ? 'off' : 'on';
    sound.setAttribute('aria-label', video.muted ? 'ปิดเสียงแล้ว' : 'เปิดเสียงแล้ว');
    sound.classList.add('show');
    void sound.offsetWidth;
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => sound.classList.remove('show'), 700);
  }

  function needTap() {
    waitingForTap = true;
    hint.hidden = false;
  }

  // Try with sound first; browsers that block it get muted autoplay plus a tap hint.
  async function start() {
    video.muted = false;
    try {
      await video.play();
    } catch {
      video.muted = true;
      needTap();
      try { await video.play(); } catch { /* autoplay fully blocked: first tap starts it */ }
    }
  }

  document.addEventListener('click', (e) => {
    if (waitingForTap) {
      // First tap anywhere: restart from the beginning with sound.
      waitingForTap = false;
      hint.hidden = true;
      replayBtn.hidden = true;
      video.currentTime = 0;
      video.muted = false;
      video.play().then(flashSound, needTap);
      return;
    }
    if (stage.contains(e.target)) {
      video.muted = !video.muted;
      if (video.paused && !video.ended) video.play().catch(needTap);
      flashSound();
    }
  });

  replayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    replayBtn.hidden = true;
    video.currentTime = 0;
    video.play().catch(needTap);
  });

  video.addEventListener('ended', () => { replayBtn.hidden = false; });

  start();
})();
