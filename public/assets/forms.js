// Login and change-password pages: show/hide password buttons, and a submit button
// that says "กำลัง..." and cannot be pressed twice while the form is being sent.
(() => {
  const STALL_MS = 20000; // no new page after this long (Stop pressed, network stall)

  const toggles = [];
  function setVisible(button, input, show) {
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', show ? 'true' : 'false');
    button.setAttribute('aria-label', show ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
  }

  for (const button of document.querySelectorAll('[data-toggle-password]')) {
    const input = document.getElementById(button.dataset.togglePassword);
    if (!input) continue;
    toggles.push([button, input]);
    button.addEventListener('click', () => {
      setVisible(button, input, input.type === 'password');
      input.focus();
    });
  }

  const hasTimers = typeof setTimeout === 'function';

  for (const form of document.querySelectorAll('form')) {
    const button = form.querySelector('[data-busy-text]');
    if (!button) continue; // only forms whose submit button has a "busy" label
    const label = button.textContent;
    let sending = false;
    let stallTimer;

    const restore = () => {
      sending = false;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = label;
    };

    form.addEventListener('submit', (event) => {
      if (sending) { event.preventDefault(); return; } // e.g. Enter pressed twice
      sending = true;
      // Never leave a password visible (or let the browser remember it as text).
      for (const [toggle, input] of toggles) setVisible(toggle, input, false);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = button.dataset.busyText;
      // If no new page arrives, give the button back so the form can be sent again.
      if (hasTimers) {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(restore, STALL_MS);
      }
    });
    // Leaving for the next page: the timer has no job any more.
    window.addEventListener('pagehide', () => { if (hasTimers) clearTimeout(stallTimer); });
    // Coming back with the browser's Back button restores the page as it was.
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      if (hasTimers) clearTimeout(stallTimer);
      restore();
    });
  }
})();
