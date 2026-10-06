// THE HELPERS EVERY DOCUMENT SHARES (2026-10-05, Quentin's instruction:
// "enforce DRY abstractions as much as possible").
//
// Four documents — the app (app.js), the gates dashboard (gates.js), the NOW
// panel (panel.js) and the one-field inbox page (inbox.js) — each wrote its
// own escaper, fetch envelope, toast, copy, theme and privacy setter, undo
// stack and day/minute arithmetic. "No build step and no module system" was
// the reason given, and it was never true: a second plain <script> loaded
// FIRST is the whole of the sharing a no-build app needs. The copies had
// already drifted — gates' copy had no http fallback, so the one sheet where
// an NTAG key is ever readable could not copy it off localhost; app's escaper
// left `'` alone; the panel re-decided the midnight wrap by hand.
//
// RULES FOR THIS FILE: top-level function declarations and consts only, every
// one meaningful in all four documents. Nothing here may assume an element
// that only one document has, except behind a guard. A document-specific
// repaint (the app's privacy eye, the theme label) hangs off an event or a
// callback, never off a name this file reaches for.
'use strict';

// Minutes in a day. The one spelling of the wrap — client_rules_test bans a
// bare 1440 everywhere else.
const DAY_MIN = 1440;

const UNDO_MAX = 30;

function escHtml(s) {
  // Null and undefined render as nothing, never as the word: a missing field
  // is not text. `'` is escaped too, so an attribute quoted either way is safe.
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// What an empty list says instead of nothing (2026-10-05). Ten classes said it
// at four sizes and five paddings (.gtd-empty, .eg-empty, .be-empty,
// .gd-empty, …); .empty in style.css is the one look, and a list whose rows
// are inset sets --empty-x rather than growing an eleventh. `cls` is for a
// meaning the sentence carries (the dashboard's failed-load red), never a
// layout. Plain text only: a sentence with a link in it writes the class.
function emptyHtml(text, cls) {
  return `<div class="empty${cls ? ' ' + cls : ''}">${escHtml(text)}</div>`;
}

// ── Which day ─────────────────────────────────────────────────
function formatDateYMD(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// What time is it NOW — the wall clock's date. Never the day a write is filed
// under: a surface that writes a dated fact sends the day it is ABOUT (see
// app.js's WHICH DAY block for viewDay and the history behind the split).
function wallDay() {
  return formatDateYMD(new Date());
}

// ── SEMANTIC MINUTES (2026-08-17) ────────────────────────────
//
// THE RULE: HH:MM is a BOUNDARY FORMAT. Parse it once, through these, and
// compare minutes from then on. Do not order or compare HH:MM strings outside
// this block — lexicographic order is right only within one day, which is
// exactly the assumption that keeps breaking.
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToHHMM(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// End of a span that may cross midnight: an end at or before the start IS the
// wrap. Takes the two clock times, so the comparison happens in one place.
function spanEndMin(startHHMM, endHHMM) {
  const s = timeToMinutes(startHHMM);
  const e = timeToMinutes(endHHMM);
  return e < s ? e + DAY_MIN : e;
}

// A window whose end carries an explicit +1 day (a gate's offset_days, and the
// day-window payload's window_end_offset_days).
function windowEndMin(endHHMM, offsetDays) {
  return timeToMinutes(endHHMM) + (offsetDays ? DAY_MIN : 0);
}

// A semantic minute rendered back to a clock face. NEGATIVE-SAFE, which the
// bare `m % 1440` was not: a previous-day block continuation starts below zero
// and rendered as '-2:00'.
function clockHHMM(minutes) {
  return minutesToHHMM(((Math.round(minutes) % DAY_MIN) + DAY_MIN) % DAY_MIN);
}

// Minutes from `then` to `now` on a clock that may have crossed midnight since
// `then` was read: an end more than half a day AHEAD of the clock is a
// semantic minute from before midnight (a row ending at 1450 read at 00:20),
// so the day is added back. Anything else is the plain difference — a span
// that ended thirteen hours ago really did. (The NOW panel's overrun had this
// as a hand-rolled `if (d < -720) d += 1440`.)
function minutesSince(now, then) {
  const d = now - then;
  return d < -DAY_MIN / 2 ? d + DAY_MIN : d;
}

// ── Talking to the server ─────────────────────────────────────
//
// Two shapes, written once instead of per call site. They are deliberately
// TWO functions, not one, because callers have two different contracts:
//
// apiGet SWALLOWS and falls back. A fetch never blanks the surface it feeds,
// so a dead endpoint — or one that answers with an error — yields the CURRENT
// value, not []. Promise.all rejects as a unit, and one dead endpoint used to
// blank the whole day. "No gates" is a claim, and a failed fetch is not
// evidence for it.
//
// apiSend returns the RESPONSE, not the parsed body: callers read res.ok or
// res.status to decide what to say, and a helper that hid the response would
// send every one of them back to a raw fetch. Body omitted = no Content-Type
// header, which is what a bare DELETE always sent.
function apiGet(path, fallback) {
  // Written out, not via a helper: this IS the helper. (A mechanical sweep
  // once rewrote this body into a call to itself — twice.)
  return fetch(path).then(r => (r.ok ? r.json() : fallback)).catch(() => fallback);
}

function apiSend(path, method, body) {
  return fetch(path, body === undefined ? { method } : {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// apiSend with the body read and the network failure caught: `{ok, status,
// data}`, where a lost connection is status 0 and says so in `data.error`.
// For a surface whose every write toasts the server's sentence on refusal
// (the gates dashboard) — the same fetch, not a second one.
async function apiSendData(path, method, body) {
  try {
    const r = await apiSend(path, method, body);
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'No connection — nothing was saved.' } };
  }
}

// ── Toast ─────────────────────────────────────────────────────
// One element, made on first use, styled once in style.css (#app-toast). A
// long sentence — a server's refusal, which is said in words — stays up
// longer than a two-word receipt.
let toastTimer = null;

function toast(msg) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('toast-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast-on'),
                          Math.max(2600, 60 * String(msg).length));
}

// ── Copy ──────────────────────────────────────────────────────
// COPY THAT WORKS OFF LOCALHOST. navigator.clipboard is gated on a SECURE
// CONTEXT, so it is undefined over http://<tailnet-name>:5000 — which is every
// Windows and Mac client running in PT_SERVER mode. The old code was
// `navigator.clipboard?.writeText(...)` followed unconditionally by a success
// toast, so on those machines nothing was copied and the app said it had been.
// A lying confirmation is worse than a visible failure.
//
// The execCommand fallback is the same idiom the markdown editors already rely
// on. It needs a real selection in the document, so the textarea is attached,
// selected, copied and removed. Returns whether it actually worked, and every
// caller must respect that rather than assume.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through — a rejected permission is not a reason to give up */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen but NOT display:none: an unrendered field cannot be selected.
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    return false;
  }
}

// One place decides what a copy SAYS, so a failure can never be reported as a
// success. On failure the text is shown, because a link you can select by hand
// beats a button that quietly does nothing.
async function copyAndSay(text, label) {
  if (await copyText(text)) { toast(`${label} copied`); return true; }
  toast(`Could not copy — ${text}`);
  return false;
}

// ── Undo ──────────────────────────────────────────────────────
// Session-local, LIFO, capped. Inverses are closures, so they capture the
// exact prior value rather than guessing it later. An inverse that returns
// `false` was REFUSED and has already said why (a server's sentence), so no
// "Undone" goes over the top of it — before this was shared, the app's
// calendar call-off undo toasted its refusal and then "Undone" a line later.
// `onChange(top, size)` repaints the document's own button.
function makeUndoStack(onChange) {
  const entries = [];
  const changed = () => {
    if (onChange) onChange(entries.length ? entries[entries.length - 1] : null, entries.length);
  };
  return {
    push(label, inverse) {
      entries.push({ label, inverse });
      if (entries.length > UNDO_MAX) entries.shift();
      changed();
    },
    async run() {
      const entry = entries.pop();
      changed();
      if (!entry) { toast('Nothing to undo'); return; }
      try {
        if ((await entry.inverse()) !== false) toast('Undone: ' + entry.label);
      } catch (e) {
        toast("Couldn't undo " + entry.label);
      }
    },
    get size() { return entries.length; },
  };
}

// ── Theme ─────────────────────────────────────────────────────
// ONE CLASS ON <html>. The setting table is the source of truth, mirrored to
// localStorage so a document can read it before the first paint; each
// document calls this itself (the NOW panel never does — it is deliberately
// light always). The label and icons exist only in the app's Settings, hence
// the guard.
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.classList.toggle('theme-light', light);
  const label = document.getElementById('theme-label');
  if (!label) return;  // another document, or the app before its shell parses
  label.textContent = light ? 'Light' : 'Dark';
  document.getElementById('theme-icon-sun').classList.toggle('hidden', !light);
  document.getElementById('theme-icon-moon').classList.toggle('hidden', light);
}

function storedTheme() {
  try { return localStorage.getItem('theme') || 'dark'; } catch (e) { return 'dark'; }
}

// ── Privacy mode ──────────────────────────────────────────────
// SOMEBODY IS STANDING BEHIND YOU (2026-09-16, Quentin's instruction). The
// whole document washes out to a quarter of its contrast: still legible to the
// one person leaning into it, not to a room. Ctrl+Alt+P in every window.
//
// ONE CLASS ON <html>, the theme's idiom — and a filter on the ROOT element is
// the one place a filter does NOT make a containing block for fixed
// descendants, which every sheet, every overlay and the global bar depend on.
//
// sessionStorage, not localStorage: a reload must not drop the guard while the
// person is still standing there, and a fresh launch must not come up grey
// with nobody remembering why. Nothing is stored server-side for the same
// reason — this is a fact about the room, not about the day. A document that
// paints something of its own for it listens for `privacychange`.
function privacyOn() {
  return document.documentElement.classList.contains('priv-mode');
}

function setPrivacy(on) {
  document.documentElement.classList.toggle('priv-mode', !!on);
  try {
    if (on) sessionStorage.setItem('privacy', '1');
    else sessionStorage.removeItem('privacy');
  } catch (e) { /* private mode: the class is still on, which is the feature */ }
  document.dispatchEvent(new Event('privacychange'));
}

// Read synchronously, before the first paint: a washed screen that paints
// bright first has failed at the one moment it existed for.
try {
  if (sessionStorage.getItem('privacy') === '1') {
    document.documentElement.classList.add('priv-mode');
  }
} catch (e) { /* no store, no memory — it starts off */ }

// Ctrl+Alt+P (⌘ on a Mac) — the same chord in every document.
function isPrivacyChord(e) {
  return e.altKey && (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'p' || e.key === 'P');
}
