// Task 05 AC1/AC2: public/assets/forms.js (login / change password) in a vm with a
// tiny fake DOM: show/hide password, busy submit button that cannot be pressed twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { APP_ROOT } from '../src/config.js';

const FORMS_JS = await readFile(path.join(APP_ROOT, 'public', 'assets', 'forms.js'), 'utf8');

function el(props = {}) {
  const listeners = {};
  const attrs = {};
  return {
    attrs,
    dataset: {},
    setAttribute(k, v) { attrs[k] = String(v); },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, event = {}) { for (const fn of listeners[type] ?? []) fn(event); },
    focus() { this.focused = true; },
    ...props,
  };
}

function setup() {
  const input = el({ type: 'password' });
  const toggle = el({ dataset: { togglePassword: 'password' } });
  const submit = el({ dataset: { busyText: 'กำลังเข้าสู่ระบบ...' }, textContent: 'เข้าสู่ระบบ', disabled: false });
  const form = el({ querySelector: (sel) => (sel === '[data-busy-text]' ? submit : null) });
  const plainForm = el({ querySelector: () => null }); // e.g. the logout form
  const win = el();
  vm.runInNewContext(FORMS_JS, {
    document: {
      querySelectorAll: (sel) => ({ '[data-toggle-password]': [toggle], form: [form, plainForm] })[sel] ?? [],
      getElementById: (id) => (id === 'password' ? input : null),
    },
    window: win,
  });
  return { input, toggle, submit, form, win };
}

test('show / hide password switches the input type and the Thai aria-label', () => {
  const { input, toggle } = setup();
  toggle.fire('click');
  assert.equal(input.type, 'text');
  assert.equal(toggle.attrs['aria-pressed'], 'true');
  assert.equal(toggle.attrs['aria-label'], 'ซ่อนรหัสผ่าน');
  assert.equal(input.focused, true);
  toggle.fire('click');
  assert.equal(input.type, 'password');
  assert.equal(toggle.attrs['aria-pressed'], 'false');
  assert.equal(toggle.attrs['aria-label'], 'แสดงรหัสผ่าน');
});

test('submit: button shows "กำลังเข้าสู่ระบบ...", is disabled, a second submit is blocked', () => {
  const { submit, form } = setup();
  const first = { prevented: false, preventDefault() { this.prevented = true; } };
  form.fire('submit', first);
  assert.equal(first.prevented, false, 'the first submit goes through');
  assert.equal(submit.disabled, true);
  assert.equal(submit.textContent, 'กำลังเข้าสู่ระบบ...');
  assert.equal(submit.attrs['aria-busy'], 'true');
  const second = { prevented: false, preventDefault() { this.prevented = true; } };
  form.fire('submit', second);
  assert.equal(second.prevented, true, 'double submit blocked');
});

test('coming back with the Back button (page from cache) re-enables the button', () => {
  const { submit, form, win } = setup();
  form.fire('submit', { preventDefault() {} });
  win.fire('pageshow', { persisted: true });
  assert.equal(submit.disabled, false);
  assert.equal(submit.textContent, 'เข้าสู่ระบบ');
  assert.equal(submit.attrs['aria-busy'], undefined);
});

// Round 2 ---------------------------------------------------------------------

function setupWithTimers() {
  const timers = [];
  const input = el({ type: 'password' });
  const toggle = el({ dataset: { togglePassword: 'password' } });
  const submit = el({ dataset: { busyText: 'กำลังเข้าสู่ระบบ...' }, textContent: 'เข้าสู่ระบบ', disabled: false });
  const form = el({ querySelector: (sel) => (sel === '[data-busy-text]' ? submit : null) });
  const win = el();
  vm.runInNewContext(FORMS_JS, {
    document: {
      querySelectorAll: (sel) => ({ '[data-toggle-password]': [toggle], form: [form] })[sel] ?? [],
      getElementById: (id) => (id === 'password' ? input : null),
    },
    window: win,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].cleared = true; },
  });
  return { input, toggle, submit, form, win, timers };
}

test('W2: submitting hides a shown password again (type=password, toggle reset)', () => {
  const { input, toggle, form } = setupWithTimers();
  toggle.fire('click');
  assert.equal(input.type, 'text');
  form.fire('submit', { preventDefault() {} });
  assert.equal(input.type, 'password');
  assert.equal(toggle.attrs['aria-pressed'], 'false');
  assert.equal(toggle.attrs['aria-label'], 'แสดงรหัสผ่าน');
});

test('W1: no new page within 20 s → the button comes back; leaving the page cancels that', () => {
  const { submit, form, win, timers } = setupWithTimers();
  form.fire('submit', { preventDefault() {} });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 20000);
  timers[0].fn(); // stalled
  assert.equal(submit.disabled, false);
  assert.equal(submit.textContent, 'เข้าสู่ระบบ');
  assert.equal(submit.attrs['aria-busy'], undefined);
  const again = { prevented: false, preventDefault() { this.prevented = true; } };
  form.fire('submit', again);
  assert.equal(again.prevented, false, 'can be sent again after the stall');
  win.fire('pagehide', {});
  assert.equal(timers[1].cleared, true, 'timer cancelled when the page goes away');
});
