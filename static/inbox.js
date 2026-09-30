// /inbox — ONE FIELD (2026-09-29, Quentin's instruction). Enter files what is
// typed into the inbox (POST /api/inbox, the same write the global bar's
// captureToInbox makes) and clears the field for the next one. The app's
// capture rules, kept:
//   * Half-typed text is DATA: mirrored to localStorage on every keystroke and
//     restored on load, and a FAILED write keeps the text in the field.
//   * A create inverts to a delete: the receipt offers Undo for a few seconds.
'use strict';

const field = document.getElementById('ib-field');
const note = document.getElementById('ib-note');
const DRAFT_KEY = 'inboxPageDraft';
const RECEIPT_MS = 6000;
let noteTimer = null;

try {
  const t = localStorage.getItem('theme');
  document.documentElement.classList.toggle('theme-light', t === 'light');
  field.value = localStorage.getItem(DRAFT_KEY) || '';
} catch (e) { /* private mode: no draft to restore */ }

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, field.value); } catch (e) { /* none */ }
}

function say(html, bad) {
  clearTimeout(noteTimer);
  note.className = bad ? 'ib-bad' : '';
  note.innerHTML = html;
  // A refusal stays until the next try; a receipt fades.
  if (!bad) noteTimer = setTimeout(() => { note.innerHTML = ''; }, RECEIPT_MS);
}

const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function capture() {
  const content = field.value.trim();
  if (!content) return;
  let res = null;
  try {
    res = await fetch('/api/inbox', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (e) { res = null; }
  if (!res || !res.ok) {
    say('Not saved — ' + (res ? `the server said ${res.status}` : 'no connection')
      + '. Your text is still here.', true);
    return;
  }
  const item = await res.json().catch(() => ({}));
  // Only clear what was sent: anything typed while the request was in flight
  // stays.
  if (field.value.trim() === content) field.value = '';
  saveDraft();
  say(`Added “${esc(content)}” <button type="button" id="ib-undo">Undo</button>`);
  const undo = document.getElementById('ib-undo');
  if (undo && item.id != null) undo.addEventListener('click', async () => {
    const r = await fetch(`/api/inbox/${item.id}`, { method: 'DELETE' }).catch(() => null);
    say(r && r.ok ? `Removed “${esc(content)}”` : 'Could not undo — it is still in the inbox.', !(r && r.ok));
    field.focus();
  });
}

field.addEventListener('input', saveDraft);
field.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); capture(); }
});
field.focus();
