// Back office /admin: copy link, check the chosen file in the browser (type + size
// limit sent by the server in data attributes), upload with XMLHttpRequest (upload
// progress + cancel), then update the card without reloading.
(() => {
  const root = document.getElementById('admin');
  if (!root) return;
  const MIME = root.dataset.mime;
  let uploading = false; // one upload at a time for the whole page

  const MSG = {
    notMp4: 'ไฟล์นี้ไม่ใช่วีดีโอ MP4 กรุณาเลือกไฟล์ .mp4',
    tooLarge: (label) => `ไฟล์ใหญ่เกิน ${label} กรุณาบีบอัดไฟล์ก่อนแล้วลองใหม่`,
    expired: 'หมดเวลาล็อกอิน กรุณาเข้าสู่ระบบใหม่ (โหลดหน้านี้ใหม่) แล้วอัปโหลดอีกครั้ง',
    reload: 'กรุณาโหลดหน้านี้ใหม่แล้วลองอีกครั้ง',
    failed: 'ระบบขัดข้อง อัปโหลดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
    network: 'การเชื่อมต่อขาดหาย อัปโหลดไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
    cancelled: 'ยกเลิกการอัปโหลดแล้ว',
    checking: 'กำลังตรวจสอบ...',
    uploading: 'กำลังอัปโหลด... อย่าปิดหน้านี้จนกว่าจะเสร็จ',
    saving: 'กำลังบันทึก...',
    done: 'อัปโหลดเรียบร้อยแล้ว',
    copied: 'คัดลอกลิงก์แล้ว',
    busy: 'กำลังอัปโหลดไฟล์อื่นอยู่ กรุณารอให้เสร็จก่อน',
  };

  const field = (card, name) => card.querySelector(`[data-field="${name}"]`);
  const cards = () => root.querySelectorAll('[data-slug]');

  function say(card, text, kind) {
    const el = field(card, 'message');
    el.textContent = text;
    el.className = kind ? `msg ${kind}` : 'msg';
  }

  function setUploadingState(on) {
    uploading = on;
    for (const card of cards()) {
      card.querySelector('[data-action="upload"]').disabled = on;
      field(card, 'upload-label').setAttribute('aria-disabled', on ? 'true' : 'false');
    }
  }

  function render(card, v) {
    const status = field(card, 'status');
    status.textContent = v.statusLabel;
    status.className = `status ${v.hasVideo ? 'status-ok' : 'status-none'}`;
    field(card, 'size').textContent = v.sizeLabel;
    field(card, 'updated').textContent = v.updatedText;
    field(card, 'upload-text').textContent = v.hasVideo ? 'เปลี่ยนวีดีโอ' : 'อัปโหลดวีดีโอ';
  }

  // Same rules as the server: MP4 only, size within the limit of this set.
  function checkFile(card, file) {
    const isMp4 = file.type ? file.type === MIME : /\.mp4$/i.test(file.name);
    if (!isMp4) return MSG.notMp4;
    if (file.size > Number(card.dataset.limitBytes)) return MSG.tooLarge(card.dataset.limitLabel);
    return null;
  }

  function errorMessage(card, status, body) {
    if (status === 401) return MSG.expired;
    if (status === 403) return MSG.reload;
    if (body && typeof body.message === 'string') return body.message;
    if (status === 413) return MSG.tooLarge(card.dataset.limitLabel); // e.g. from the proxy
    if (status === 415) return MSG.notMp4;
    return MSG.failed;
  }

  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

  async function upload(card, input) {
    const file = input.files && input.files[0];
    if (!file) return;
    input.value = ''; // picking the same file again must fire "change"
    if (uploading) { say(card, MSG.busy, 'error'); return; }
    const problem = checkFile(card, file);
    if (problem) { say(card, problem, 'error'); return; }

    setUploadingState(true);
    say(card, MSG.checking);
    // Cheap session check first, so an expired login is reported before sending
    // a large file (the server would refuse it only at the end).
    try {
      const ping = await fetch('/api/admin/videos', { credentials: 'same-origin', cache: 'no-store' });
      if (ping.status === 401) { setUploadingState(false); say(card, MSG.expired, 'error'); return; }
    } catch {
      setUploadingState(false);
      say(card, MSG.network, 'error');
      return;
    }

    const xhr = new XMLHttpRequest();
    const progress = field(card, 'progress');
    const bar = field(card, 'bar');
    const percent = field(card, 'percent');
    const cancel = card.querySelector('[data-action="cancel"]');
    const finish = (text, kind) => {
      progress.hidden = true;
      cancel.onclick = null;
      setUploadingState(false);
      say(card, text, kind);
    };

    bar.value = 0;
    percent.textContent = '0%';
    progress.hidden = false;
    say(card, MSG.uploading);
    cancel.onclick = () => xhr.abort();

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.min(100, Math.floor((e.loaded / e.total) * 100));
      bar.value = pct;
      percent.textContent = `${pct}%`;
      // All bytes sent: the server is now checking and saving the file.
      if (pct === 100) say(card, MSG.saving);
    };
    xhr.onload = () => {
      const body = parse(xhr.responseText);
      if (xhr.status === 200 && body && body.video) {
        render(card, body.video);
        finish(MSG.done, 'ok');
      } else {
        finish(errorMessage(card, xhr.status, body), 'error');
      }
    };
    xhr.onerror = () => finish(MSG.network, 'error');
    xhr.onabort = () => finish(MSG.cancelled);

    const form = new FormData();
    // Some phones report no type for .mp4 files: label the part video/mp4 (no copy;
    // the server still checks the MP4 signature itself).
    form.append('file', file.type === MIME ? file : file.slice(0, file.size, MIME), file.name);
    xhr.open('POST', `/api/admin/videos/${encodeURIComponent(card.dataset.slug)}`);
    xhr.send(form);
  }

  async function copy(card, button) {
    const url = button.dataset.url;
    try {
      await navigator.clipboard.writeText(url);
      say(card, MSG.copied, 'ok');
    } catch {
      window.prompt('คัดลอกลิงก์นี้', url); // older browsers / no clipboard permission
    }
  }

  for (const card of cards()) {
    card.querySelector('[data-action="upload"]').addEventListener('change', (e) => upload(card, e.target));
    card.querySelector('[data-action="copy"]').addEventListener('click', (e) => copy(card, e.currentTarget));
  }
})();
