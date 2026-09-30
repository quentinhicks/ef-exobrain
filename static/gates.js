// THE GATES DASHBOARD (2026-09-29, Quentin's instruction: bring the location
// gates back, 100% transparent — every setting in one place, the whole process
// visible and encapsulated there).
//
// Its own document and its own script, touching none of app.js: the NOW
// panel's arrangement (panel.js). That is also why a handful of small helpers
// here (the day arithmetic, the pointer drag, the undo stack) are written out
// again rather than shared — there is no build step and no module system, and
// a page that loads app.js is not encapsulated.
//
// THE RULES THIS FILE KEEPS, all of them the app's own:
//   * THE DAY IS SERVED, never mirrored. Every window, verdict, lock and price
//     below is what the server resolved through the judge's own functions
//     (/api/gates/day = _gate_day_payload per gate). Nothing here decides
//     whether a gate runs, when it closes or what it costs.
//   * A WRITE SENDS ITS DAY. The day view's writes carry G.date, the day on
//     screen; nothing writes "today" by default.
//   * HH:MM IS A BOUNDARY FORMAT. Windows arrive as minutes from midnight of
//     their own date (past 1440 = tomorrow); only the POST back is HH:MM.
//   * A GESTURE IS A BUTTON. A drag that moves a window and the call-off both
//     ship their inverse (pushUndo), because they are the money path.
//   * A REFUSAL IS SAID IN WORDS. The server refuses easings inside 24h, tag
//     gates with no live tag, etc.; its sentence is toasted, never a number.
'use strict';

const DAY_MIN = 1440;
const PX_PER_MIN = 0.8;
const SNAP_MIN = 5;
const HOLD_MS = 550;
// The judge runs on a timer every few minutes, so "recently" is the test.
const JUDGE_STALE_MIN = 30;
const ARM_CONFIRM_MS = 6000;

const G = {
  date: null,          // the day being looked at (YYYY-MM-DD)
  day: null,           // /api/gates/day for G.date
  nodes: [],           // /api/accountability/nodes (the permanent config)
  billing: null,       // /api/gates/billing
  ledger: null,        // /api/gates/ledger
  events: [],          // /api/gcal — context only, never judged
  segments: [],        // /api/blocks/day — context only
  locations: [],
  flows: [],
  settings: {},
  sel: null,           // node id selected on the day view
  edit: null,          // the open editor: { id, v, tag, confirmDelete }
  taps: {},            // node id -> tap rows
  tokenCheck: null,    // the last explicit token verification
  armConfirmUntil: 0,
  foldOpen: false,     // the prices/account disclosure survives a repaint
  ledgerGate: '',
  undo: [],
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = c => '$' + (Number(c || 0) / 100).toFixed(2);
const pad = n => String(n).padStart(2, '0');

// ── Theme and privacy: the app's two documents' conventions, read here ──
// The theme is mirrored in localStorage by app.js; the db copy (settings.theme)
// is reconciled once settings arrive. Privacy is sessionStorage — this page is
// reached in the SAME tab, so the app's privacy state carries over and back.
function applyTheme(t) {
  document.documentElement.classList.toggle('theme-light', t === 'light');
}
try { applyTheme(localStorage.getItem('theme') || 'dark'); } catch (e) { /* private mode */ }
function setPrivacy(on) {
  document.documentElement.classList.toggle('priv-mode', !!on);
  try {
    if (on) sessionStorage.setItem('privacy', '1'); else sessionStorage.removeItem('privacy');
  } catch (e) { /* the class still applies */ }
}
try { if (sessionStorage.getItem('privacy') === '1') setPrivacy(true); } catch (e) { /* none */ }

// ── Days and minutes ──────────────────────────────────────────
function ymdOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// What time is it — the wall clock's date. Only ever the START of navigation;
// every write sends the day on screen instead.
function wallDay() { return ymdOf(new Date()); }
function plusDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return ymdOf(new Date(y, m - 1, d + n));
}
function dayDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
// Minutes from midnight of `ymd` for a LOCAL ISO stamp; past 1440 is tomorrow,
// negative is yesterday. Parsed as text, never through Date, so no zone applies.
function minOn(ymd, iso) {
  const s = String(iso || '');
  return dayDiff(ymd, s.slice(0, 10)) * DAY_MIN + (+s.slice(11, 13) || 0) * 60 + (+s.slice(14, 16) || 0);
}
function clock(min) {
  const w = ((min % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${pad(Math.floor(w / 60))}:${pad(w % 60)}`;
}
function clockLabel(min) { return clock(min) + (min >= DAY_MIN ? ' +1d' : ''); }
function hhmmMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
function dayLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short' });
}
function stamp(iso) { return iso ? String(iso).slice(0, 16).replace('T', ' ') : ''; }
function agoLabel(iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
const judgeStale = iso => !iso || (Date.now() - new Date(iso).getTime()) / 60000 > JUDGE_STALE_MIN;

// ── Talking to the server ─────────────────────────────────────
// A read falls back to what is already on screen, never to empty: "no gates"
// is a claim, and a failed fetch is not evidence for it.
async function getJSON(url, fallback) {
  try {
    const r = await fetch(url);
    if (!r.ok) return fallback;
    return await r.json();
  } catch (e) { return fallback; }
}
async function send(url, method, body) {
  try {
    const r = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'No connection — nothing was saved.' } };
  }
}
const refusal = (res, what) => (res.data && res.data.error) || `${what} (${res.status || 'offline'})`;

let toastTimer = null;
function toast(msg) {
  const el = $('#gd-toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}

async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
  catch (e) { toast(`Could not copy — select it by hand: ${text}`); }
}

// ── Undo: the day-level gestures only ─────────────────────────
// Session-local, LIFO, cap 30, like the app's. The permanent config in the
// editor is NOT undoable (the app's rule for its Settings surfaces): every
// easing there already waits 24h and can be called off from the same sheet.
function pushUndo(label, inverse) {
  G.undo.push({ label, inverse });
  if (G.undo.length > 30) G.undo.shift();
  paintUndo();
}
async function runUndo() {
  const u = G.undo.pop();
  paintUndo();
  if (!u) return;
  if (await u.inverse()) toast(`Undid: ${u.label}`);
}
function paintUndo() {
  const b = $('#gd-undo');
  b.disabled = !G.undo.length;
  b.title = G.undo.length ? `Undo: ${G.undo[G.undo.length - 1].label} (Ctrl+Z)` : 'Nothing to undo';
}

// ── Proof: what each kind actually proves ─────────────────────
// THE TRANSPARENCY HALF OF "SECURE" (Quentin's call, 2026-09-29: keep both,
// labelled). A link scan is a static token plus coordinates the phone's
// browser reports in the request body (qr_scan_server.scan) — both can be
// replayed or typed. Only the tag is unforgeable. The page says so on every
// gate rather than letting a green tick imply more than it proves.
const PROOF = {
  link: {
    name: 'Link + geofence', strength: 'honour system', cls: 'gd-weak',
    threat: 'The scan link never changes, and the location is whatever the phone reports. '
      + 'Anyone holding the link (a photo of the sticker is enough) can send any coordinates '
      + 'and clear this gate from anywhere. It keeps an honest person honest; it cannot '
      + 'stop a determined one.',
  },
  tag: {
    name: 'NFC tag only', strength: 'cryptographic', cls: 'gd-strong',
    threat: 'Each tap is signed with AES keys the tag never gives up, over a counter that '
      + 'only goes up, and the server claims each counter once — a copied tap URL is '
      + 'worthless. It proves the TAG was tapped: fixed in place, that is where you were. '
      + 'It cannot tell whether someone else carried a loose tag for you.',
  },
  routine: {
    name: 'Its routine, finished', strength: 'self-reported', cls: 'gd-weak',
    threat: 'Cleared by finishing the linked routine in this app. The server re-checks that '
      + 'every hard step was done, but nothing outside the app witnesses it.',
  },
  hours: {
    name: 'Hours reported', strength: 'self-reported', cls: 'gd-weak',
    threat: 'Cleared by the number of minutes you report. Nothing checks the number.',
  },
};
const proofOf = n => PROOF[(n && n.proof_mode) || 'link'] || PROOF.link;
function proofBadge(n) {
  const p = proofOf(n);
  const noFence = (n.proof_mode || 'link') === 'link' && n.geofence_lat == null;
  return `<span class="gd-badge ${p.cls}" title="${esc(p.threat)}">${esc(p.strength)}`
    + `${noFence ? ' · no place pinned' : ''}</span>`;
}

const GATE_FIELDS = {
  charge_cents: 'stake', window_start: 'from', window_end: 'to',
  window_end_offset_days: 'crosses midnight', days_of_week: 'days',
  geofence_lat: 'place', geofence_lng: 'place', geofence_radius_m: 'radius',
  weekly_windows: 'per-day times', active: 'state', source_uid: 'schedule',
  __delete__: 'delete gate', all_day: 'all day', proof_mode: 'proof', label: 'name',
  target_minutes: 'target',
};
const GATE_FENCE = ['geofence_lat', 'geofence_lng', 'geofence_radius_m'];
const falsyFlag = v => v === 0 || v === false || v === '0' || v === 'false' || v == null || v === '';
const GATE_REASONS = {
  absent: 'no scan', no_scan: 'no scan', geofence: 'scanned somewhere else',
  geofence_fail: 'scanned somewhere else', routine_incomplete: 'routine not done',
  routine_late: 'routine done late', hours_short: 'short of the hours',
  social_floor: 'social floor not met',
};
const GATE_STATUSES = {
  succeeded: 'charged', charging: 'charging…', failed: 'not charged (nothing was sent, or it was rejected)',
  unknown: 'unknown — may have charged', capped: 'skipped — weekly cap',
  dryrun: 'dry run — no money moved', would_fire: 'would have charged (not live)',
  stale: 'too old to charge — judged, unpaid', 'n/a': 'did not run',
};
const gateReason = r => GATE_REASONS[r] || (r || 'failed').replace(/_/g, ' ');
const gateStatus = st => GATE_STATUSES[st] || (st || '—').replace(/_/g, ' ');
const OUTCOME_WORD = { met: 'met', partial: 'half', missed: 'missed', off: 'off' };

// Queued changes as DECISIONS: the fence's three columns are one place, and
// calling off one of them would leave a fence in the sea.
function pendingGroups(pending) {
  const out = [];
  const fence = pending.filter(p => GATE_FENCE.includes(p.field));
  const days = [...new Set(fence.map(p => p.effective_date))];
  if (fence.length && days.length === 1) {
    const lat = (fence.find(p => p.field === 'geofence_lat') || {}).new_value;
    const loc = G.locations.find(l => String(l.lat) === String(lat));
    out.push({ label: 'place', text: loc ? loc.name : 'a new place',
               effective_date: days[0], fields: fence.map(p => p.field) });
  } else {
    fence.forEach(p => out.push({ label: GATE_FIELDS[p.field], text: String(p.new_value),
                                  effective_date: p.effective_date, fields: [p.field] }));
  }
  pending.filter(p => !GATE_FENCE.includes(p.field)).forEach(p => out.push({
    label: p.field === '__delete__' ? '' : (GATE_FIELDS[p.field] || p.field),
    text: p.field === '__delete__' ? 'the gate is deleted'
      : p.field === 'charge_cents' ? (p.new_value == null ? 'the default' : money(p.new_value))
      : p.field === 'active' ? (falsyFlag(p.new_value) ? 'paused' : 'active')
      : p.field === 'all_day' ? (falsyFlag(p.new_value) ? 'the window judges' : 'the whole day judges')
      : p.new_label || String(p.new_value),
    effective_date: p.effective_date, fields: [p.field],
  }));
  return out;
}

// ── Loading ───────────────────────────────────────────────────
// NEWEST READ WINS, PER FIELD. The gate reads take a while (every gate's days
// are resolved through the judge), so two loads overlap easily — a drag's
// re-read and its undo's — and they can finish in either order. Without this a
// stale answer landing last repainted the window the undo had just removed.
// Each loader claims the fields it writes; an answer is applied only if no
// later load has claimed that field since.
const loadSeq = {};
function claim(keys) {
  const c = {};
  keys.forEach(k => { c[k] = loadSeq[k] = (loadSeq[k] || 0) + 1; });
  return c;
}
const current = (c, k) => loadSeq[k] === c[k];

async function loadAll() {
  const date = G.date;
  const c = claim(['day', 'nodes', 'billing', 'ledger', 'segments', 'context']);
  const [day, nodes, billing, ledger, events, segments, locations, flows, settings] = await Promise.all([
    getJSON(`/api/gates/day?date=${date}`, G.day),
    getJSON('/api/accountability/nodes', G.nodes),
    getJSON('/api/gates/billing', G.billing),
    getJSON('/api/gates/ledger', G.ledger),
    getJSON('/api/gcal', G.events),
    getJSON(`/api/blocks/day?date=${date}&all=1`, G.segments),
    getJSON('/api/locations', G.locations),
    getJSON('/api/flows', G.flows),
    getJSON('/api/settings', G.settings),
  ]);
  if (G.date !== date) return;            // navigated away while reading
  if (current(c, 'day')) G.day = day;
  if (current(c, 'billing')) G.billing = billing;
  if (current(c, 'ledger')) G.ledger = ledger;
  if (current(c, 'nodes')) G.nodes = Array.isArray(nodes) ? nodes : G.nodes;
  if (current(c, 'segments')) G.segments = Array.isArray(segments) ? segments : G.segments;
  if (current(c, 'context')) {
    G.settings = settings || G.settings;
    G.events = Array.isArray(events) ? events : G.events;
    G.locations = Array.isArray(locations) ? locations : G.locations;
    G.flows = Array.isArray(flows) ? flows : G.flows;
  }
  if (G.settings.theme) {
    applyTheme(G.settings.theme);
    try { localStorage.setItem('theme', G.settings.theme); } catch (e) { /* none */ }
  }
  renderAll();
}

// After a day-level write: the day's own answers, and the nodes (their
// today_override and pending lists) — re-asked, never patched in place.
async function reloadDay() {
  const date = G.date;
  const c = claim(['day', 'nodes', 'segments']);
  const [day, nodes, segments] = await Promise.all([
    getJSON(`/api/gates/day?date=${date}`, G.day),
    getJSON('/api/accountability/nodes', G.nodes),
    getJSON(`/api/blocks/day?date=${date}&all=1`, G.segments),
  ]);
  if (G.date !== date) return;
  if (current(c, 'day')) G.day = day;
  if (current(c, 'nodes')) G.nodes = Array.isArray(nodes) ? nodes : G.nodes;
  if (current(c, 'segments')) G.segments = Array.isArray(segments) ? segments : G.segments;
  if (!current(c, 'day')) return;          // a newer read will paint
  renderDay();
  renderGates();
  if (G.edit) renderSheet();
}

async function reloadConfig() {
  const date = G.date;
  const c = claim(['day', 'nodes', 'billing', 'ledger']);
  const [nodes, day, billing, ledger] = await Promise.all([
    getJSON('/api/accountability/nodes', G.nodes),
    getJSON(`/api/gates/day?date=${date}`, G.day),
    getJSON('/api/gates/billing', G.billing),
    getJSON('/api/gates/ledger', G.ledger),
  ]);
  if (current(c, 'nodes')) G.nodes = Array.isArray(nodes) ? nodes : G.nodes;
  if (current(c, 'day') && G.date === date) G.day = day;
  if (current(c, 'billing')) G.billing = billing;
  if (current(c, 'ledger')) G.ledger = ledger;
  renderAll();
}

function renderAll() {
  renderMoney();
  renderDay();
  renderGates();
  renderLedger();
  renderRules();
  if (G.edit) renderSheet();
  writeRoute();
}

// ── The address: #date=…&gate=… ───────────────────────────────
// Derived from what is on screen, never kept beside it — the app's rule.
function writeRoute() {
  const parts = [];
  if (G.date && G.date !== wallDay()) parts.push(`date=${G.date}`);
  if (G.edit && G.edit.id) parts.push(`gate=${G.edit.id}`);
  else if (G.edit) parts.push('gate=new');
  else if (G.sel) parts.push(`sel=${G.sel}`);
  const h = parts.length ? '#' + parts.join('&') : '';
  if (location.hash !== h) history.replaceState(null, '', location.pathname + h);
}
function readRoute() {
  const p = new URLSearchParams(location.hash.slice(1));
  const d = p.get('date');
  G.date = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : wallDay();
  const sel = parseInt(p.get('sel'));
  G.sel = isNaN(sel) ? null : sel;
  return p.get('gate');
}

const sectionHead = (title, extra) =>
  `<div class="gd-sec-head"><h2>${esc(title)}</h2>${extra || ''}</div>`;

// ══ 1. MONEY — will this charge me, and what stops it ══════════
function moneyVerdict(b) {
  if (judgeStale(b.judge_last_run)) {
    return { cls: 'gd-bad', text: 'Judgment isn\'t running.',
      sub: `Nothing has been judged since ${agoLabel(b.judge_last_run)}, so no gate is being `
        + 'decided. Nothing below matters until the judge runs again.' };
  }
  if (b.charging_disabled) {
    return { cls: 'gd-good', text: 'Charging is disabled in the code. No money can move.',
      sub: 'qr_judge.CHARGING_DISABLED is on. Days are judged and priced; nothing here can arm it.' };
  }
  if (!b.live) {
    return { cls: 'gd-good', text: 'Not armed. No money moves.',
      sub: 'Every day is still judged, frozen and priced — the ledger below says what each '
        + 'would have cost ("would have charged").' };
  }
  if (!b.has_token || !b.has_user) {
    return { cls: 'gd-bad', text: 'Armed, but it cannot charge.',
      sub: `The Beeminder ${!b.has_token ? 'token' : 'user'} is missing, so every charge `
        + 'fails without sending anything.' };
  }
  if (b.dryrun) {
    return { cls: 'gd-good', text: 'Armed in dry run. No money moves.',
      sub: 'Every failure calls Beeminder with dryrun set — the whole pipeline, minus the money.' };
  }
  return { cls: 'gd-live', text: 'LIVE. A missed gate bills real money.',
    sub: `Bills ${esc(b.user)} — at most ${money(b.cap_cents)} in any 7 days, whatever happens.` };
}

function renderMoney() {
  const el = $('#gd-money');
  const b = G.billing;
  if (!b) {
    el.innerHTML = sectionHead('Money')
      + '<p class="gd-empty gd-bad-text">The billing state did not load, so nothing here is known. ↻ to retry.</p>';
    return;
  }
  const v = moneyVerdict(b);
  const mode = !b.live ? 'off' : b.dryrun ? 'dry' : 'live';
  const confirming = Date.now() < G.armConfirmUntil;
  const pct = b.cap_cents ? Math.min(100, Math.round(b.spent_cents / b.cap_cents * 100)) : 0;
  const tok = G.tokenCheck;
  const mark = (ok, idle) => idle ? '<span class="gd-mark gd-idle">○</span>'
    : `<span class="gd-mark ${ok ? 'gd-good' : 'gd-bad'}">${ok ? '✓' : '✗'}</span>`;
  const row = (m, name, val, hint) => `<div class="gd-row">${m}<div class="gd-row-main">
      <div class="gd-row-line"><span class="gd-row-name">${name}</span><span class="gd-row-val">${val}</span></div>
      ${hint ? `<div class="gd-hint">${hint}</div>` : ''}</div></div>`;

  el.innerHTML = sectionHead('Money')
    + `<div class="gd-verdict ${v.cls}"><div class="gd-vtext">${esc(v.text)}</div>
        <div class="gd-vsub">${v.sub}</div></div>`
    + `<div class="gd-seg" role="group" aria-label="Charging">
        <button data-mode="off" class="${mode === 'off' ? 'gd-on' : ''}">Off</button>
        <button data-mode="dry" class="${mode === 'dry' ? 'gd-on' : ''}">Dry run</button>
        <button data-mode="live" class="${mode === 'live' ? 'gd-on gd-on-live' : ''}${confirming ? ' gd-confirm' : ''}">${
          confirming ? `Tap again: bill ${esc(b.user || 'nobody')}` : 'Live'}</button>
      </div>
      <div class="gd-hint">Off is immediate. Live asks twice. Arming stamps the time it happened
        — a switch left on from before the 2026-09-07 disable does not count.</div>`
    + '<h3>The locks, in the order they are checked</h3>'
    + row(mark(!judgeStale(b.judge_last_run)), 'The judge', esc(agoLabel(b.judge_last_run)),
      'Runs on the server every few minutes and freezes each finished day. Stale = nothing is being decided.')
    + row(mark(!b.charging_disabled, !b.charging_disabled ? false : true), 'Code lock',
      b.charging_disabled ? 'ON — nothing can charge' : 'lifted',
      'qr_judge.CHARGING_DISABLED. When on, no request is ever built, whatever the rest says.')
    + row(mark(b.live, !b.live), 'Armed',
      b.live ? `since ${esc(stamp(b.armed_at))}`
        : (b.live_setting && !b.armed_at ? 'no — an old switch is on, never armed here' : 'no'),
      'Only this page\'s Dry run / Live buttons arm it, and the time is recorded.')
    + row(mark(true, !b.dryrun), 'Dry run', b.dryrun ? 'on — Beeminder is told not to bill' : 'off — real charges', '')
    + row(mark(b.has_user), 'Bills', b.has_user ? esc(b.user) : 'no Beeminder user set', '')
    + row(mark(tok ? tok.valid : b.has_token), 'Token',
      tok ? (tok.valid ? 'checked just now — valid' : esc(tok.reason || 'invalid'))
        : (b.has_token ? 'set — not checked' : 'not set'),
      'Kept in config.json on the server, never in the database or its backups. This page can '
        + 'set it or clear it, and can never read it back.')
    + `<div class="gd-actions"><button class="gd-btn" id="gd-verify">Check the token with Beeminder</button></div>`
    + `<details class="gd-fold"${G.foldOpen ? ' open' : ''}><summary>Prices and the Beeminder account — ${money(b.default_cents)} default stake, ${money(b.cap_cents)} weekly cap</summary>`
    + '<h3>Prices</h3>'
    + `<div class="gd-meter" title="${pct}% of the weekly cap"><span style="width:${pct}%"></span></div>
       <div class="gd-hint">${money(b.spent_cents)} charged in the last 7 days, of a ${money(b.cap_cents)} cap.
        A charge that would cross the cap is skipped whole and logged "capped".</div>`
    + `<div class="gd-form">
        <label>Default stake <span class="gd-money-in">$<input type="number" min="0" step="0.25" id="gd-default" value="${(b.default_cents / 100).toFixed(2)}"></span></label>
        <label>Card fee <span class="gd-money-in">$<input type="number" min="0" step="0.05" id="gd-fee" value="${(b.fee_cents / 100).toFixed(2)}"></span></label>
        <label>Weekly cap <span class="gd-money-in">$<input type="number" min="0" step="1" id="gd-cap" value="${(b.cap_cents / 100).toFixed(2)}"></span></label>
        <button class="gd-btn" id="gd-save-prices">Save prices</button>
      </div>
      <div class="gd-hint">The fee comes OUT of the stake: Beeminder is billed stake − fee (their
        floor is $1), while the ledger and the cap count the whole stake. Keep stakes at least fee + $1.</div>`
    + '<h3>Beeminder account</h3>'
    + `<div class="gd-form">
        <label>User <input type="text" id="gd-user" autocomplete="off" value="${esc(b.user || '')}"></label>
        <label>Token <input type="password" id="gd-token" autocomplete="new-password" placeholder="${b.has_token ? 'set — blank leaves it' : 'paste the auth token'}"></label>
        <button class="gd-btn" id="gd-save-cred">Save account</button>
        ${b.has_token ? '<button class="gd-btn gd-danger" id="gd-clear-token">Remove the token</button>' : ''}
      </div></details>`;

  el.querySelectorAll('[data-mode]').forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  el.querySelector('.gd-fold').addEventListener('toggle', e => { G.foldOpen = e.target.open; });
  $('#gd-verify').addEventListener('click', async () => {
    const r = await getJSON('/api/gates/billing?verify=1', null);
    if (!r) { toast('Could not reach the server'); return; }
    G.billing = r;
    G.tokenCheck = r.token || { valid: false, reason: 'no token set' };
    renderMoney();
  });
  $('#gd-save-prices').addEventListener('click', async () => {
    const cents = id => Math.round(parseFloat($(id).value || '0') * 100);
    const res = await send('/api/gates/billing', 'PATCH', {
      gate_charge_cents: cents('#gd-default'), gate_card_fee_cents: cents('#gd-fee'),
      gate_weekly_cap_cents: cents('#gd-cap') });
    if (!res.ok) { toast(refusal(res, 'Prices not saved')); return; }
    toast('Prices saved');
    await reloadConfig();
  });
  $('#gd-save-cred').addEventListener('click', async () => {
    const body = { beeminder_user: $('#gd-user').value.trim(), beeminder_auth_token: $('#gd-token').value.trim() };
    if (!body.beeminder_user && !body.beeminder_auth_token) { toast('Nothing typed — nothing changed'); return; }
    const res = await send('/api/gates/billing', 'PATCH', body);
    if (!res.ok) { toast(refusal(res, 'Account not saved')); return; }
    G.tokenCheck = null;
    toast(body.beeminder_auth_token ? 'Saved. The token is stored and will not be shown again.' : 'User saved');
    await reloadConfig();
  });
  const clr = $('#gd-clear-token');
  if (clr) clr.addEventListener('click', async () => {
    const res = await send('/api/config', 'PATCH', { beeminder_auth_token: '__clear__' });
    if (!res.ok) { toast(refusal(res, 'Token not removed')); return; }
    G.tokenCheck = null;
    toast('Token removed — nothing can be charged until a new one is saved');
    await reloadConfig();
  });
}

async function setMode(mode) {
  const b = G.billing || {};
  if (mode === 'live' && !(b.live && !b.dryrun)) {
    // Twice, deliberately: this is the one press on the page that turns on
    // real money. The second press has to land inside ARM_CONFIRM_MS.
    if (Date.now() >= G.armConfirmUntil) {
      G.armConfirmUntil = Date.now() + ARM_CONFIRM_MS;
      renderMoney();
      setTimeout(() => { if (Date.now() >= G.armConfirmUntil) renderMoney(); }, ARM_CONFIRM_MS + 50);
      return;
    }
  }
  G.armConfirmUntil = 0;
  const body = mode === 'off' ? { gate_charging_live: false }
    : { gate_charging_live: true, gate_charge_dryrun: mode === 'dry' };
  const res = await send('/api/gates/billing', 'PATCH', body);
  if (!res.ok) { toast(refusal(res, 'Charging not changed')); }
  else toast(mode === 'off' ? 'Disarmed. No money can move.'
    : mode === 'dry' ? 'Armed in dry run — no money moves' : 'LIVE — missed gates now bill real money');
  await reloadConfig();
}

// ══ 2. THE DAY — where each gate sits, moved against the calendar ══
function dayGates() {
  return G.day && G.day.date === G.date && Array.isArray(G.day.gates) ? G.day.gates : [];
}
const gateDay = id => dayGates().find(g => g.node_id === id);

function dayState(g) {
  if (g.judged) return g.verdict && g.verdict.passed ? 'met' : 'missed';
  if (g.skipped) return 'off';
  if (!g.active) return 'off';
  return g.verdict && g.verdict.met ? 'met' : 'open';
}

// Why this band cannot be dragged, in words — every reason is the server's.
function dragRefusal(g) {
  if (g.judged) return 'This day is judged and frozen.';
  if (g.skipped) return 'Called off — put the day back first.';
  if (g.window && g.window.closed) return 'This day has closed.';
  if (g.skip_locked) return 'Locked: this gate closes within 24h, which is exactly when the rule refuses changes.';
  return null;
}

function renderDay() {
  const el = $('#gd-day');
  const date = G.date;
  const gates = dayGates();
  const shown = gates.filter(g => g.applies || g.skipped);
  const idle = gates.filter(g => !g.applies && !g.skipped);
  const isToday = date === wallDay();

  const evs = G.events.filter(e => !e.allday).map(e => ({
    s: minOn(date, e.start), e: minOn(date, e.end), title: e.summary || '', color: e.color,
  })).filter(e => e.e > 0 && e.s < DAY_MIN);
  const allDayEvs = G.events.filter(e => e.allday && String(e.start).slice(0, 10) <= date
    && String(e.end || e.start).slice(0, 10) >= date);
  const segs = G.segments.filter(s => !s.cancelled);

  let lo = 6 * 60, hi = DAY_MIN;
  shown.forEach(g => { lo = Math.min(lo, g.window.start_min); hi = Math.max(hi, g.window.end_min); });
  evs.forEach(e => { lo = Math.min(lo, Math.max(0, e.s)); });
  lo = Math.max(0, Math.floor(lo / 60) * 60);
  hi = Math.min(2 * DAY_MIN, Math.ceil(hi / 60) * 60);
  const y = m => (m - lo) * PX_PER_MIN;

  const hours = [];
  for (let m = lo; m <= hi; m += 60) {
    hours.push(`<div class="gd-hour" style="top:${y(m)}px"><span>${clock(m)}</span></div>`);
  }
  const segHtml = segs.map(s => `<div class="gd-seg-band" style="top:${y(Math.max(lo, s.start))}px;height:${
    Math.max(2, y(Math.min(hi, s.end)) - y(Math.max(lo, s.start)))}px;--c:${esc(s.color || 'var(--border)')}">
      <span>${esc(s.label || '')}</span></div>`).join('');
  const evHtml = evs.map(e => {
    const s = Math.max(lo, e.s), en = Math.min(hi, e.e);
    return `<div class="gd-ev" style="top:${y(s)}px;height:${Math.max(12, y(en) - y(s))}px;--c:${esc(e.color || 'var(--text-secondary)')}"
      title="${esc(e.title)} ${clock(e.s)}–${clock(e.e)}"><span>${esc(e.title)}</span></div>`;
  }).join('');

  // Lanes, so two gates open at once sit side by side instead of on top.
  const items = shown.map(g => ({ g, s: g.window.start_min, e: g.window.end_min }))
    .sort((a, b) => a.s - b.s);
  const ends = [];
  items.forEach(it => {
    let i = ends.findIndex(e => e <= it.s);
    if (i < 0) { i = ends.length; ends.push(0); }
    ends[i] = it.e;
    it.lane = i;
  });
  const lanes = Math.max(1, ends.length);
  // A GRAB BAND MAY ONLY REACH INTO FREE TRACK (the plan spans' rule): each
  // edge overhangs its gate by up to GRAB_REACH px, but never more than half
  // the gap to the neighbour in its lane — where two gates abut it is 0, or a
  // finger on the shared boundary would move whichever was drawn later.
  const GRAB_REACH = 10;
  const reach = (it, dir) => {
    const gaps = items.filter(o => o !== it && o.lane === it.lane)
      .map(o => (dir < 0 ? it.s - o.e : o.s - it.e)).filter(d => d >= 0);
    const gap = gaps.length ? Math.min(...gaps) * PX_PER_MIN : Infinity;
    return Math.max(0, Math.min(GRAB_REACH, Math.floor(gap / 2)));
  };
  const gateHtml = items.map(it => {
    const { g, lane } = it;
    const st = dayState(g);
    const top = y(g.window.start_min), h = Math.max(22, y(g.window.end_min) - top);
    const locked = dragRefusal(g);
    const up = reach(it, -1), down = reach(it, 1);
    return `<div class="gd-gate gd-st-${st}${G.sel === g.node_id ? ' gd-picked' : ''}${g.skipped ? ' gd-skipped' : ''}${
      g.window.all_day ? ' gd-allday' : ''}${locked ? ' gd-locked' : ''}" data-gate="${g.node_id}"
      style="top:${top}px;height:${h}px;left:calc(${lane} * (100% / ${lanes}));width:calc(100% / ${lanes} - 4px)"
      title="${esc(locked || 'Drag the top or bottom edge to move this day only')}">
      ${locked ? '' : `<span class="gd-grab gd-grab-top" data-edge="start" style="top:${-up}px;height:${10 + up}px"></span>`}
      <div class="gd-gate-name">${esc(g.label)}</div>
      <div class="gd-gate-time">${clock(g.window.start_min)}–${clockLabel(g.window.end_min)}${
        g.window.all_day ? ' · all day' : ''}</div>
      ${locked ? '' : `<span class="gd-grab gd-grab-bot" data-edge="end" style="bottom:${-down}px;height:${10 + down}px"></span>`}
    </div>`;
  }).join('');

  const nowMin = isToday ? (new Date().getHours() * 60 + new Date().getMinutes()) : null;
  el.innerHTML = sectionHead('The day', `<div class="gd-daynav">
      <button class="gd-icon" id="gd-prev" title="Previous day">‹</button>
      <input type="date" id="gd-date" value="${date}">
      <button class="gd-icon" id="gd-next" title="Next day">›</button>
      ${isToday ? '' : '<button class="gd-btn gd-small" id="gd-today">Today</button>'}
    </div>`)
    + `<div class="gd-hint">${esc(dayLabel(date))}${isToday ? ' (today)' : ''}. Gates on the right, your
      calendar and blocks behind them for context — the calendar is never judged. Drag a gate's top
      or bottom edge to change THIS DAY only (on a phone, hold it first). Tap a gate to see how the
      judge sees the day.</div>`
    + (allDayEvs.length ? `<div class="gd-allday-evs">${allDayEvs.map(e =>
        `<span class="gd-chip">${esc(e.summary || '')}</span>`).join('')}</div>` : '')
    + (gates.length ? `<div class="gd-tl" style="height:${y(hi) + 8}px">
        ${hours.join('')}
        <div class="gd-ctx">${segHtml}${evHtml}</div>
        <div class="gd-lanes">${gateHtml}</div>
        ${nowMin != null && nowMin >= lo && nowMin <= hi ? `<div class="gd-now" style="top:${y(nowMin)}px"></div>` : ''}
      </div>` : '<p class="gd-empty">No gates yet — add one below.</p>')
    + (idle.length ? `<div class="gd-hint">Not running ${isToday ? 'today' : 'this day'}: ${
        idle.map(g => esc(g.label)).join(', ')}.</div>` : '')
    + '<div id="gd-detail"></div>';

  $('#gd-prev').addEventListener('click', () => goDay(plusDays(G.date, -1)));
  $('#gd-next').addEventListener('click', () => goDay(plusDays(G.date, 1)));
  $('#gd-date').addEventListener('change', e => { if (e.target.value) goDay(e.target.value); });
  const t = $('#gd-today');
  if (t) t.addEventListener('click', () => goDay(wallDay()));
  el.querySelectorAll('.gd-gate').forEach(band => {
    band.addEventListener('click', () => {
      if (band.dataset.dragged === '1') { delete band.dataset.dragged; return; }
      G.sel = +band.dataset.gate === G.sel ? null : +band.dataset.gate;
      renderDay();
      writeRoute();
    });
    band.querySelectorAll('.gd-grab').forEach(h => wireGrab(h, band));
  });
  renderDetail();
}

async function goDay(ymd) {
  G.date = ymd;
  writeRoute();
  await reloadDay();
}

// A DRAG ON A FINGER is a 550ms still hold, then a drag; on a mouse it starts
// at once. The page is held still only while a drag is LIVE (the touchmove
// preventDefault below): a touch decides whether it may pan at touchstart, so
// touch-action set when the hold arms is too late on its own. Same technique
// as app.js's onPointerDrag, written out again because this page is its own.
let liveDrag = null;
document.addEventListener('touchmove', e => { if (liveDrag) e.preventDefault(); }, { passive: false });
document.addEventListener('pointermove', e => {
  if (!liveDrag) return;
  e.preventDefault();
  liveDrag.move(e.clientY);
}, { passive: false });
['pointerup', 'pointercancel'].forEach(type => document.addEventListener(type, e => {
  if (!liveDrag) return;
  const d = liveDrag;
  liveDrag = null;
  d.end(e.type === 'pointerup');
}));

function wireGrab(handle, band) {
  handle.addEventListener('click', e => e.stopPropagation());
  handle.addEventListener('pointerdown', e => {
    e.stopPropagation();
    const g = gateDay(+band.dataset.gate);
    if (!g || dragRefusal(g)) return;
    const arm = () => {
      band.style.touchAction = 'none';
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* a nicety */ }
      band.classList.add('gd-dragging');
      liveDrag = startDrag(g, band, handle.dataset.edge, e.clientY, e.pointerId, handle);
    };
    if (e.pointerType === 'mouse') { e.preventDefault(); arm(); return; }
    const sx = e.clientX, sy = e.clientY;
    let down = true;
    const t = setTimeout(() => { if (down) arm(); }, HOLD_MS);
    const cancelOnMove = ev => {
      if (Math.abs(ev.clientY - sy) > 10 || Math.abs(ev.clientX - sx) > 10) clearTimeout(t);
    };
    const stop = () => {
      down = false;
      clearTimeout(t);
      document.removeEventListener('pointermove', cancelOnMove);
    };
    document.addEventListener('pointermove', cancelOnMove);
    ['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, stop, { once: true }));
  });
}

function startDrag(g, band, edge, y0, pid, handle) {
  const s0 = g.window.start_min, e0 = g.window.end_min;
  let ns = s0, ne = e0, moved = false;
  const timeEl = band.querySelector('.gd-gate-time');
  const lo = parseFloat(band.style.top) - s0 * PX_PER_MIN;   // px of minute 0
  return {
    move(cy) {
      const dy = cy - y0;
      if (!moved && Math.abs(dy) < 3) return;
      moved = true;
      const dm = Math.round(dy / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;
      if (edge === 'start') {
        // The opening stays on this date and at least 5 minutes before the close.
        ns = Math.max(0, Math.min(DAY_MIN - SNAP_MIN, e0 - SNAP_MIN, s0 + dm));
        ne = e0;
      } else {
        // The close may run into tomorrow, never more than a day past the opening.
        ns = s0;
        ne = Math.max(s0 + SNAP_MIN, Math.min(s0 + DAY_MIN - SNAP_MIN, 2 * DAY_MIN - SNAP_MIN, e0 + dm));
      }
      band.style.top = `${lo + ns * PX_PER_MIN}px`;
      band.style.height = `${Math.max(22, (ne - ns) * PX_PER_MIN)}px`;
      timeEl.textContent = `${clock(ns)}–${clockLabel(ne)}`;
    },
    async end(dropped) {
      band.classList.remove('gd-dragging');
      band.style.touchAction = '';
      try { if (handle.hasPointerCapture(pid)) handle.releasePointerCapture(pid); } catch (err) { /* none */ }
      if (!moved) return;
      band.dataset.dragged = '1';
      if (!dropped || (ns === s0 && ne === e0)) { renderDay(); return; }
      await writeWindow(g, G.date, ns, ne, edge);
    },
  };
}

// THIS DAY ONLY. What was in force before the drop is the day's own override
// row as the server stored it (or none, and then the undo DELETEs) — an
// override that merely agrees with the default is not an undo.
async function writeWindow(g, date, ns, ne, edge) {
  const prev = g.override && !g.override.skipped ? g.override : null;
  const res = await send(`/api/accountability/nodes/${g.node_id}/overrides`, 'POST', {
    date, window_start: clock(ns), window_end: clock(ne),
    window_end_offset_days: ne >= DAY_MIN ? 1 : 0,
  });
  if (!res.ok) { toast(refusal(res, 'Could not move it')); renderDay(); return; }
  pushUndo(`moved the ${edge === 'start' ? 'opening' : 'deadline'} of "${g.label}" on ${dayLabel(date)}`,
    () => restoreWindow(g.node_id, date, prev));
  await reloadDay();
}

async function restoreWindow(id, date, prev) {
  const res = prev
    ? await send(`/api/accountability/nodes/${id}/overrides`, 'POST', {
        date, window_start: prev.window_start, window_end: prev.window_end,
        window_end_offset_days: prev.window_end_offset_days || 0 })
    : await send(`/api/accountability/nodes/${id}/overrides/${date}`, 'DELETE');
  if (!res.ok) { toast(refusal(res, 'Could not undo that window')); return false; }
  if (date === G.date) await reloadDay();
  return true;
}

// CALLING A DAY OFF writes qr_override.skipped — the store the judge reads, so
// the day lands 'n/a' by the road a non-run weekday does. Skipping loosens and
// takes the 24h lock; putting it back re-commits and never waits.
async function setSkip(id, date, want) {
  const res = want
    ? await send(`/api/accountability/nodes/${id}/overrides`, 'POST', { date, skipped: true })
    : await send(`/api/accountability/nodes/${id}/overrides/${date}`, 'DELETE');
  if (!res.ok) {
    toast(refusal(res, want ? 'Could not call that day off' : 'Could not put that day back'));
    return false;
  }
  if (date === G.date) await reloadDay();
  return true;
}

function recordStrip(h) {
  if (!h) return '';
  const byDate = {};
  (h.days || []).forEach(d => { byDate[d.date] = d; });
  const cells = [];
  for (let d = h.from; d <= h.to; d = plusDays(d, 1)) {
    const r = byDate[d];
    const o = r ? r.outcome : 'none';
    cells.push(`<span class="gd-rec gd-rec-${o}" title="${esc(dayLabel(d))}: ${
      r ? esc(OUTCOME_WORD[o] || o) + (r.amount_cents ? ' · ' + money(r.amount_cents) : '') : 'not judged'}"></span>`);
  }
  return `<div class="gd-record">${cells.join('')}</div>
    <div class="gd-hint">Last 14 days, read back off the frozen rows: filled = met, hollow = did not run,
      red = missed, blank = not judged. ${money(h.charged_cents)} charged over them.</div>`;
}

function renderDetail() {
  const el = $('#gd-detail');
  if (!el) return;
  const g = G.sel != null ? gateDay(G.sel) : null;
  if (!g) { el.innerHTML = ''; return; }
  const node = G.nodes.find(n => n.id === g.node_id) || { proof_mode: g.proof_mode };
  const p = proofOf(g);
  const w = g.window;
  const v = g.verdict || {};
  let verdict;
  if (g.judged) {
    verdict = v.passed ? `✓ Met — judged and frozen.`
      : `✗ ${esc(gateReason(g.judged.failure_reason))} — ${esc(gateStatus(g.judged.charge_status))}`
        + (g.judged.amount_cents ? ` · ${money(g.judged.amount_cents)}` : '');
  } else if (!g.applies) {
    verdict = g.skipped ? '○ Called off — this day lands "did not run".' : '○ Does not run this day.';
  } else {
    verdict = v.met ? '✓ Cleared. It settles at ' + esc(stamp(v.settles_at)) + '.'
      : `Not cleared yet. If the day ended now it would owe ${money(v.owed_cents)}`
        + `${g.live ? '' : ' (not live — nothing would be billed)'}. It settles at ${esc(stamp(v.settles_at))}.`;
  }
  const lockedWhy = g.skip_locked && !g.skipped ? 'Locked: this gate closes within 24h.' : '';
  const scans = (g.scans || []).map(sc => `<li class="${sc.satisfies && sc.in_window ? 'gd-good-text' : ''}">
      ${esc(sc.local_time || '?')} · ${sc.proof === 'tag' ? 'tag tap' : 'link scan'}${
      sc.distance_m != null ? ` · ${sc.distance_m} m away` : ''}${
      sc.accuracy_m != null ? ` (±${Math.round(sc.accuracy_m)} m, as the phone reported it)` : ''} · ${
      sc.in_window ? 'inside the window' : 'outside the window'} · ${
      sc.satisfies ? (sc.in_window ? 'counts' : 'would count, wrong time') : 'does not count'}</li>`).join('');
  const pend = pendingGroups(g.pending_changes || []);

  el.innerHTML = `<div class="gd-card">
    <div class="gd-card-head"><h3>${esc(g.label)}</h3>${proofBadge(node)}</div>
    <div class="gd-verdict-line">${verdict}</div>
    <dl class="gd-dl">
      <dt>Window</dt><dd>${clock(w.start_min)} – ${clockLabel(w.end_min)} · set by ${esc(w.from)}</dd>
      <dt>Judged on</dt><dd>${w.all_day ? 'the whole day — the window only places it here'
        : 'the window — proof after it closes is not proof'}</dd>
      <dt>Proof</dt><dd>${esc(p.name)}. ${esc(p.threat)}</dd>
      <dt>Stake</dt><dd>${money(g.stake_cents)}${g.live ? '' : ' (not live)'}</dd>
      ${g.location ? `<dt>Place</dt><dd>${esc(g.location.name || 'a pinned point')} · within ${
        esc(g.location.radius_m)} m of ${Number(g.location.lat).toFixed(5)}, ${Number(g.location.lng).toFixed(5)}</dd>` : ''}
      ${g.routine ? `<dt>Routine</dt><dd>${esc(g.routine.name)}${g.routine.deadline ? ` · due ${esc(g.routine.deadline)}` : ''}${
        g.routine.completed_at ? ` · done ${esc(stamp(g.routine.completed_at))}` : ' · not done'}</dd>` : ''}
      ${g.pawn && g.pawn.minutes ? `<dt>Pawned in</dt><dd>${g.pawn.minutes} min${
        g.pawn.applied ? `, opening moved ${g.pawn.taken_min} min earlier` : ' (a day change stands as written)'}</dd>` : ''}
      ${g.hours ? `<dt>Hours</dt><dd>${g.hours.logged_minutes || 0} of ${g.hours.required_minutes || 0} min${
        g.hours.frozen ? ' (frozen)' : ''}</dd>` : ''}
    </dl>
    <h4>Every scan and tap of the day</h4>
    ${scans ? `<ul class="gd-list">${scans}</ul>` : '<p class="gd-empty">None.</p>'}
    ${pend.length ? `<h4>Changes already scheduled</h4><ul class="gd-list">${pend.map(pg =>
      `<li>${pg.label ? esc(pg.label) + ' → ' : ''}${esc(pg.text)} from ${esc(pg.effective_date)}</li>`).join('')}</ul>` : ''}
    <h4>Record</h4>${recordStrip(g.history)}
    <div class="gd-actions">
      ${g.applies || g.skipped ? `<button class="gd-btn" id="gd-skip" ${lockedWhy || g.judged ? 'disabled' : ''}>${
        g.skipped ? 'Put this day back' : 'Call this day off'}</button>` : ''}
      ${g.override && !g.override.skipped && !g.judged ? `<button class="gd-btn" id="gd-unov" ${g.skip_locked ? 'disabled' : ''}>Remove this day's change</button>` : ''}
      <button class="gd-btn" id="gd-edit">Edit gate ›</button>
    </div>
    ${lockedWhy ? `<div class="gd-hint">${lockedWhy} Calling it off now is exactly what the rule refuses.</div>` : ''}
  </div>`;

  const skip = $('#gd-skip');
  if (skip) skip.addEventListener('click', async () => {
    const date = G.date, was = g.skipped, id = g.node_id, label = g.label;
    if (await setSkip(id, date, !was)) {
      pushUndo(`${was ? 'put back' : 'called off'} "${label}" on ${dayLabel(date)}`,
        () => setSkip(id, date, was));
    }
  });
  const unov = $('#gd-unov');
  if (unov) unov.addEventListener('click', async () => {
    const date = G.date, prev = g.override, id = g.node_id;
    const res = await send(`/api/accountability/nodes/${id}/overrides/${date}`, 'DELETE');
    if (!res.ok) { toast(refusal(res, 'Could not remove it')); return; }
    pushUndo(`removed "${g.label}"'s change on ${dayLabel(date)}`, () => restoreWindow(id, date, prev));
    await reloadDay();
  });
  $('#gd-edit').addEventListener('click', () => openEditor(g.node_id));
}

// ══ 3. THE GATES — the permanent configuration ═════════════════
function renderGates() {
  const el = $('#gd-gates');
  const rows = G.nodes.map(n => {
    const paused = !n.active || (n.pending_changes || []).some(p => p.field === 'active' && falsyFlag(p.new_value));
    const pend = (n.pending_changes || []).length;
    return `<button class="gd-gate-row${paused ? ' gd-dim' : ''}" data-open="${n.id}">
      <div class="gd-row-line"><span class="gd-row-name">${esc(n.label)}</span>
        <span class="gd-row-val">${n.charge_cents == null ? 'default stake' : money(n.charge_cents)}</span></div>
      <div class="gd-badges">${proofBadge(n)}${!n.active ? '<span class="gd-badge">paused</span>' : ''}${
        pend ? `<span class="gd-badge gd-pend">${pend} scheduled</span>` : ''}${
        n.all_day ? '<span class="gd-badge">all day</span>' : ''}</div>
      <div class="gd-hint">${esc(n.schedule_label || 'no schedule')}${n.routine ? ` · routine: ${esc(n.routine)}` : ''}</div>
    </button>`;
  }).join('');
  el.innerHTML = sectionHead('Gates', '<button class="gd-btn gd-small" id="gd-new">+ Gate</button>')
    + (rows || '<p class="gd-empty">No gates. A gate is a place and a time you commit to being there.</p>');
  $('#gd-new').addEventListener('click', () => openEditor(null));
  el.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openEditor(+b.dataset.open)));
}

// ── The editor: one sheet per gate, every setting it has ──────
const WEEKDAYS = [['mo', 'M'], ['tu', 'T'], ['we', 'W'], ['th', 'T'], ['fr', 'F'], ['sa', 'S'], ['su', 'S']];

function openEditor(id) {
  const n = id == null ? null : G.nodes.find(x => x.id === id);
  if (id != null && !n) { toast('That gate no longer exists'); return; }
  const pausing = n && (n.pending_changes || []).some(p => p.field === 'active' && falsyFlag(p.new_value));
  const active = n ? (!!n.active && !pausing) : true;
  const v = n ? {
    label: n.label, active, active0: active,
    proof: n.proof_mode || 'link', proof0: n.proof_mode || 'link',
    allDay: n.all_day ? '1' : '0', allDay0: n.all_day ? '1' : '0',
    stake: n.charge_cents == null ? '' : (n.charge_cents / 100).toFixed(2),
    location: '', radius: n.geofence_radius_m || '',
    routine: n.routine_id == null ? '' : String(n.routine_id),
    routine0: n.routine_id == null ? '' : String(n.routine_id),
    offset: n.routine_offset_min == null ? '' : String(n.routine_offset_min),
    offset0: n.routine_offset_min == null ? '' : String(n.routine_offset_min),
    sched: false, days: [], from: '', to: '',
    effective: '',
  } : { label: '', sched: true, days: ['mo', 'tu', 'we', 'th', 'fr'], from: '09:00', to: '10:00',
        location: '', radius: '' };
  G.edit = { id: n ? n.id : null, v, tag: null, confirmDelete: false, error: '' };
  if (n) loadTaps(n.id);
  $('#gd-sheet').classList.remove('hidden');
  $('#gd-sheet-back').classList.remove('hidden');
  document.body.classList.add('gd-sheet-open');
  renderSheet();
  writeRoute();
}

function closeEditor() {
  G.edit = null;
  $('#gd-sheet').classList.add('hidden');
  $('#gd-sheet-back').classList.add('hidden');
  document.body.classList.remove('gd-sheet-open');
  writeRoute();
}

async function loadTaps(id) {
  const rows = await getJSON(`/api/accountability/nodes/${id}/taps`, G.taps[id] || null);
  G.taps[id] = rows || [];
  if (G.edit && G.edit.id === id) renderSheet();
}

function passesWhen(v, n) {
  if (v.proof === 'routine') {
    const f = G.flows.find(x => String(x.id) === v.routine);
    return f ? `"${f.name}" is finished, any time that day` : 'nothing — no routine is linked, so it does not run';
  }
  if (v.proof === 'hours') {
    return 'the minutes you report meet the day\'s requirement'
      + (v.allDay === '1' ? ', reported any time that day' : ', inside the window');
  }
  return [v.proof === 'tag' ? 'you tap one of its tags' : 'you open its scan link',
    v.allDay === '1' ? 'any time that day' : 'inside the window',
    v.proof !== 'tag' && n.geofence_lat != null ? `within ${n.geofence_radius_m} m of the pinned place` : null,
  ].filter(Boolean).join(', ');
}

function schedFields(v) {
  return `<div class="gd-days">${WEEKDAYS.map(([d, l]) =>
      `<button type="button" class="gd-day${v.days.includes(d) ? ' gd-on' : ''}" data-day="${d}" title="${d}">${l}</button>`).join('')}</div>
    <div class="gd-form gd-inline">
      <label>From <input type="time" data-k="from" value="${esc(v.from)}"></label>
      <label>To <input type="time" data-k="to" value="${esc(v.to)}"></label>
    </div>
    <div class="gd-hint">A "To" earlier than "From" closes the next morning.</div>`;
}

function locationSelect(v, keepLabel) {
  return `<select data-k="location"><option value="">${esc(keepLabel)}</option>${
    G.locations.filter(l => l.active || String(l.id) === v.location).map(l =>
      `<option value="${l.id}"${String(l.id) === v.location ? ' selected' : ''}>${esc(l.name)} (${l.radius_m} m)</option>`).join('')}</select>`;
}

function renderSheet() {
  const el = $('#gd-sheet');
  const E = G.edit;
  if (!E) return;
  const v = E.v;
  const n = E.id != null ? G.nodes.find(x => x.id === E.id) : null;
  if (E.id != null && !n) { closeEditor(); return; }
  // A focused text field is half-typed text: never rebuilt under the cursor.
  const focused = document.activeElement;
  if (focused && el.contains(focused) && focused.matches('input[type=text],input[type=number],input[type=password],input:not([type])')
      && !E.forceRender) return;
  E.forceRender = false;

  let body;
  if (!n) {
    body = `<label class="gd-field">Name <input type="text" data-k="label" value="${esc(v.label)}" placeholder="e.g. Gym"></label>
      <div class="gd-field"><div class="gd-flabel">When it runs</div>${schedFields(v)}</div>
      <div class="gd-form gd-inline">
        <label>Place ${locationSelect(v, '— no place —')}</label>
        <label>Radius <input type="number" min="10" data-k="radius" value="${esc(v.radius)}" placeholder="the place's"></label>
      </div>
      <div class="gd-hint">A new gate starts as a link gate: it prints as a QR code, and a scan inside
        the window (and the place, if you pin one) clears it. Make it tag-only once its tag is set up —
        that is the only proof that cannot be faked.</div>`;
  } else {
    const p = PROOF[v.proof] || PROOF.link;
    const scanKind = v.proof === 'link' || v.proof === 'tag';
    const pend = pendingGroups((n.pending_changes || []));
    const dailyFlows = G.flows.filter(f => (f.period || 'day') === 'day');
    const linked = dailyFlows.find(f => String(f.id) === v.routine);
    const scanUrl = `${G.settings.gate_scan_url || ''}/scan/${n.token}`;
    const taps = G.taps[n.id];
    body = `
      <label class="gd-field">Name <input type="text" data-k="label" value="${esc(v.label)}"></label>

      <div class="gd-field"><div class="gd-flabel">Passes when</div>
        <div class="gd-strong-line">${esc(passesWhen(v, n))}.</div></div>

      <label class="gd-field">Proof
        <select data-k="proof" data-rerender="1">
          ${Object.entries(PROOF).map(([k, pp]) => `<option value="${k}"${v.proof === k ? ' selected' : ''}>${esc(pp.name)} — ${esc(pp.strength)}</option>`).join('')}
        </select></label>
      <div class="gd-threat ${p.cls}"><b>${esc(p.strength)}.</b> ${esc(p.threat)}</div>
      <div class="gd-hint">${v.proof === 'tag' ? 'Going back to the link is an easing, so it waits 24h.'
        : 'Switching to tag-only applies at once, and is refused until a tag with its keys is live.'}</div>

      ${v.proof === 'routine' ? '<div class="gd-field"><div class="gd-flabel">Judged on</div>the whole day — a routine gate never has a deadline inside it</div>'
        : `<label class="gd-field">Judged on
        <select data-k="allDay" data-rerender="1">
          <option value="0"${v.allDay === '0' ? ' selected' : ''}>Inside the window</option>
          <option value="1"${v.allDay === '1' ? ' selected' : ''}>Any time that day</option>
        </select></label>
        <div class="gd-hint">${v.allDay === '1' ? 'The times only place it on the day. Putting the window back in charge applies at once.'
          : 'The window IS the deadline. Making it all-day is the largest easing there is, so it waits 24h.'}</div>`}

      <div class="gd-field"><div class="gd-flabel">When it runs</div>
        <div>${esc(n.schedule_label || 'no schedule')}</div>
        ${v.sched ? schedFields(v) + '<div class="gd-hint">Saving writes a NEW weekly schedule and points the gate at it; the old one is left untouched for everything else using it. Fewer days or a shorter window apply at once; anything easier waits 24h.</div>'
          : '<button type="button" class="gd-btn gd-small" id="gd-sched">Replace with a weekly schedule</button>'}
      </div>

      ${v.proof === 'link' ? `<div class="gd-form gd-inline">
        <label>Place ${locationSelect(v, n.geofence_lat != null ? '— keep the current place —' : '— none —')}</label>
        <label>Radius <input type="number" min="10" data-k="radius" value="${esc(v.radius)}"></label>
      </div>
      <div class="gd-hint">${n.geofence_lat != null ? `Pinned at ${Number(n.geofence_lat).toFixed(5)}, ${Number(n.geofence_lng).toFixed(5)}. ` : 'No place pinned: a scan from anywhere counts. '}Widening the radius or moving the place waits 24h.</div>` : ''}

      <label class="gd-field">Stake <span class="gd-money-in">$<input type="number" min="0" step="0.25" data-k="stake" value="${esc(v.stake)}" placeholder="${G.billing ? (G.billing.default_cents / 100).toFixed(2) : 'default'}"></span></label>
      <div class="gd-hint">What failing this gate costs, whole or nothing. Blank uses the default. Raising it applies now; lowering waits 24h.</div>

      <label class="gd-field">${v.proof === 'routine' ? 'The routine' : 'Linked routine'}
        <select data-k="routine" data-rerender="1"><option value="">${v.proof === 'routine' ? '— none, so the gate cannot run —' : '— none —'}</option>
          ${dailyFlows.map(f => `<option value="${f.id}"${String(f.id) === v.routine ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}
        </select></label>
      <div class="gd-hint">${v.proof === 'routine' ? 'This routine IS the gate: finishing it on the day clears it, and nothing else does.'
        : 'On a scan gate a routine is only a deadline reference and a place in the runner — it never fails or delays the gate. To put money on it, give it its own gate with Proof set to the routine.'}</div>
      ${linked && v.routine === v.routine0 && v.proof !== 'routine' && linked.window_open_min == null ? `
      <label class="gd-field">Routine due <span class="gd-money-in"><input type="number" step="5" data-k="offset" value="${esc(v.offset)}"> min after the gate closes</span></label>
      <div class="gd-hint">Negative means before. A later deadline is an easing and waits 24h.</div>` : ''}

      ${scanKind ? `<div class="gd-field"><div class="gd-flabel">Scan link</div>
        <div class="gd-mono gd-wrap">${esc(scanUrl)}</div>
        <button type="button" class="gd-btn gd-small" data-copy="${esc(scanUrl)}" data-what="Scan link">Copy</button>
        <div class="gd-hint">The QR code to print. ${v.proof === 'tag' ? 'On a tag-only gate a link scan is logged and does NOT clear it.'
          : 'Anyone with this link can clear the gate — keep it out of photos and chats.'}</div></div>
        ${tagsHtml(n)}
        <div class="gd-field"><div class="gd-flabel">Last taps <button type="button" class="gd-btn gd-small" id="gd-taps">Refresh</button></div>
          ${taps == null ? '<p class="gd-empty">reading…</p>' : taps.length ? `<ul class="gd-list gd-mono">${taps.map(t =>
            `<li class="${t.ok ? 'gd-good-text' : 'gd-bad-text'}">${t.ok ? '✓' : '✗'} ${esc(t.at || '??')} · ${esc(t.orphan ? 'unidentified tag' : (t.tag_label || 'tag'))} · ${
              t.ok ? 'read ' + esc(t.counter) : esc(t.reason || 'refused')}</li>`).join('')}</ul>`
            : '<p class="gd-empty">None yet. Every tap of /t is written down, refused ones with the reason.</p>'}
        </div>
        <details class="gd-field"><summary>How to program a tag</summary>${TAG_STEPS}</details>` : ''}

      <label class="gd-field">State
        <select data-k="active"><option value="1"${v.active ? ' selected' : ''}>Active</option><option value="0"${!v.active ? ' selected' : ''}>Paused</option></select></label>
      <div class="gd-hint">Pausing is an easing: it takes effect in 24h, and setting it back to Active before then calls it off.</div>

      <label class="gd-field">Takes effect <input type="date" data-k="effective" value="${esc(v.effective)}"></label>
      <div class="gd-hint">Blank: now, with easings waiting their 24h. A date moves the whole save to that day; an easing dated sooner than 24h still waits. Nothing reaches back into a day already judged.</div>

      ${pend.length ? `<div class="gd-field"><div class="gd-flabel">Scheduled</div>${pend.map((pg, i) =>
        `<div class="gd-pend-row"><span>${pg.label ? esc(pg.label) + ' → ' : ''}${esc(pg.text)} from ${esc(pg.effective_date)}</span>
          <button type="button" class="gd-btn gd-small" data-calloff="${i}">Call off</button></div>`).join('')}
        <div class="gd-hint">Anything that makes a gate easier waits 24h, so it cannot be loosened in the moment you want to dodge it.</div></div>` : ''}`;
  }

  el.innerHTML = `<div class="gd-sheet-head">
      <h2>${n ? esc(n.label) : 'New gate'}</h2>
      <button class="gd-icon" id="gd-close" title="Close (Esc)">✕</button></div>
    <div class="gd-sheet-body">${body}
      ${E.error ? `<div class="gd-error">${esc(E.error)}</div>` : ''}
    </div>
    <div class="gd-sheet-foot">
      ${n ? `<button class="gd-btn gd-danger" id="gd-delete">${E.confirmDelete ? 'Tap again to delete' + (n.active ? ' (in 24h)' : '')
        : 'Delete gate'}</button>` : ''}
      <button class="gd-btn gd-primary" id="gd-save">${n ? 'Save' : 'Create gate'}</button>
    </div>`;

  wireSheet(n);
}

function tagsHtml(n) {
  const E = G.edit;
  const tags = n.tags || [];
  const tf = E.tag;
  const tagState = t => !t.keys_set ? 'no keys yet'
    : t.pending_live_at ? `starts counting ${stamp(t.pending_live_at)}`
    : !t.active ? 'paused' : !t.last_tap_at ? 'live, never tapped' : `last tap ${stamp(t.last_tap_at)}`;
  return `<div class="gd-field"><div class="gd-flabel">Tags</div>
    ${n.tap_url ? `<div class="gd-mono gd-wrap">${esc(n.tap_url)}</div>
      <button type="button" class="gd-btn gd-small" data-copy="${esc(n.tap_url)}" data-what="Tap URL">Copy tap URL</button>
      <div class="gd-hint">Write this to the tag as its NDEF URL, zeros included — the tag overwrites them on every tap.</div>`
      : '<div class="gd-hint">Set a Scan URL in the app\'s Settings → Connections first — a tag needs somewhere to point.</div>'}
    ${tags.map(t => `<div class="gd-tag">
        <div class="gd-row-line"><span class="gd-row-name">${esc(t.label)}</span><span class="gd-mono">${esc(t.uid)}</span></div>
        <div class="gd-hint">${esc(tagState(t))}${t.keys_set ? ' · keys set (write-only)' : ''}</div>
        <div class="gd-actions">
          <button type="button" class="gd-btn gd-small" data-tagkeys="${t.id}">${t.keys_set ? 'Replace keys' : 'Set keys'}</button>
          <button type="button" class="gd-btn gd-small" data-tagactive="${t.id}" data-to="${t.active ? 0 : 1}">${t.active ? 'Pause' : 'Resume'}</button>
          <button type="button" class="gd-btn gd-small gd-danger" data-tagdel="${t.id}">Delete</button>
        </div></div>`).join('')}
    ${tf ? `<div class="gd-tagform">
        ${tf.id ? `<div class="gd-flabel">Keys for "${esc((tags.find(t => t.id === tf.id) || {}).label)}"</div>`
          : `<label>Name <input type="text" data-tk="label" value="${esc(tf.label)}" placeholder="e.g. Gym door"></label>
             <label>UID <input type="text" data-tk="uid" value="${esc(tf.uid)}" placeholder="7 bytes, 14 hex chars" class="gd-mono"></label>`}
        ${tf.reveal ? `<div class="gd-keyrow"><span>Meta key</span><span class="gd-mono gd-wrap">${esc(tf.meta)}</span>
            <button type="button" class="gd-btn gd-small" data-copy="${esc(tf.meta)}" data-what="Meta key">Copy</button></div>
          <div class="gd-keyrow"><span>File key</span><span class="gd-mono gd-wrap">${esc(tf.mac)}</span>
            <button type="button" class="gd-btn gd-small" data-copy="${esc(tf.mac)}" data-what="File key">Copy</button></div>
          <div class="gd-hint">Copy BOTH into your tag writer before saving — once stored they are never shown again.
            The way back is a new pair and a rewritten tag, not a lookup.</div>`
          : `<label>Meta key <input type="password" data-tk="meta" autocomplete="off" placeholder="32 hex chars" class="gd-mono"></label>
             <label>File key <input type="password" data-tk="mac" autocomplete="off" placeholder="32 hex chars" class="gd-mono"></label>`}
        <div class="gd-actions">
          <button type="button" class="gd-btn gd-small" id="gd-genkeys">${tf.reveal ? 'Regenerate' : 'Generate both keys'}</button>
          <button type="button" class="gd-btn gd-small gd-primary" id="gd-tagsave">${tf.id ? 'Save keys' : 'Add tag'}</button>
          <button type="button" class="gd-btn gd-small" id="gd-tagcancel">Cancel</button>
        </div>
        <div class="gd-hint">Generated keys come from this device's cryptographic random source and are stored in
          config.json on the server — never the database, which is backed up. On a tag-only gate a NEW tag starts
          counting in 24h: it is another way to clear the gate.</div>
      </div>` : '<button type="button" class="gd-btn gd-small" id="gd-tagadd">+ Tag</button>'}
  </div>`;
}

// TWO AES-128 KEYS, FROM THE CSPRNG AND NOWHERE ELSE. Refuses rather than
// falling back: a weaker key looks exactly like a strong one.
function randomKey() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function wireSheet(n) {
  const el = $('#gd-sheet');
  const E = G.edit;
  const v = E.v;
  el.querySelector('#gd-close').addEventListener('click', closeEditor);
  el.querySelectorAll('[data-k]').forEach(inp => {
    const k = inp.dataset.k;
    const ev = inp.tagName === 'SELECT' || inp.type === 'date' || inp.type === 'time' ? 'change' : 'input';
    inp.addEventListener(ev, () => {
      v[k] = k === 'active' ? inp.value === '1' : inp.value;
      if (inp.dataset.rerender) { E.forceRender = true; renderSheet(); }
    });
  });
  el.querySelectorAll('[data-tk]').forEach(inp => inp.addEventListener('input', () => { E.tag[inp.dataset.tk] = inp.value; }));
  el.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
    const d = b.dataset.day;
    v.days = v.days.includes(d) ? v.days.filter(x => x !== d) : v.days.concat(d);
    E.forceRender = true;
    renderSheet();
  }));
  el.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copy, b.dataset.what)));
  const sched = el.querySelector('#gd-sched');
  if (sched) sched.addEventListener('click', () => {
    v.sched = true;
    v.days = v.days.length ? v.days : ['mo', 'tu', 'we', 'th', 'fr'];
    v.from = v.from || (n && n.window_start) || '09:00';
    v.to = v.to || (n && n.window_end) || '10:00';
    E.forceRender = true;
    renderSheet();
  });
  const taps = el.querySelector('#gd-taps');
  if (taps) taps.addEventListener('click', () => loadTaps(n.id));
  el.querySelectorAll('[data-calloff]').forEach(b => b.addEventListener('click', async () => {
    const grp = pendingGroups(n.pending_changes || [])[+b.dataset.calloff];
    // Every field of the decision, or none: half a moved fence is nowhere.
    for (const f of grp.fields) {
      const res = await send(`/api/accountability/nodes/${n.id}/pending/${f}`, 'DELETE');
      if (!res.ok) { toast(refusal(res, 'Could not call it off')); break; }
    }
    await reloadConfig();
  }));

  // Tags
  const add = el.querySelector('#gd-tagadd');
  if (add) add.addEventListener('click', () => {
    E.tag = { id: null, label: '', uid: '', meta: '', mac: '', reveal: false };
    E.forceRender = true; renderSheet();
  });
  el.querySelectorAll('[data-tagkeys]').forEach(b => b.addEventListener('click', () => {
    E.tag = { id: +b.dataset.tagkeys, meta: '', mac: '', reveal: false };
    E.forceRender = true; renderSheet();
  }));
  const cancel = el.querySelector('#gd-tagcancel');
  if (cancel) cancel.addEventListener('click', () => { E.tag = null; E.forceRender = true; renderSheet(); });
  const gen = el.querySelector('#gd-genkeys');
  if (gen) gen.addEventListener('click', () => {
    if (!(window.crypto && crypto.getRandomValues)) {
      toast('This browser has no cryptographic random source — paste keys from your tag writer instead.');
      return;
    }
    E.tag.meta = randomKey();
    E.tag.mac = randomKey();
    E.tag.reveal = true;
    E.forceRender = true; renderSheet();
  });
  const tsave = el.querySelector('#gd-tagsave');
  if (tsave) tsave.addEventListener('click', () => saveTag(n));
  el.querySelectorAll('[data-tagactive]').forEach(b => b.addEventListener('click', async () => {
    const res = await send(`/api/accountability/tags/${b.dataset.tagactive}`, 'PATCH', { active: +b.dataset.to });
    if (!res.ok) { toast(refusal(res, 'That change was refused')); return; }
    if (res.data && res.data.pending) toast(`It starts counting ${stamp(res.data.apply_at)}`);
    await reloadConfig();
  }));
  el.querySelectorAll('[data-tagdel]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again'; return; }
    const res = await send(`/api/accountability/tags/${b.dataset.tagdel}`, 'DELETE');
    if (!res.ok) { toast(refusal(res, 'Delete refused')); return; }
    await reloadConfig();
  }));

  const del = el.querySelector('#gd-delete');
  if (del) del.addEventListener('click', async () => {
    if (!E.confirmDelete) { E.confirmDelete = true; E.forceRender = true; renderSheet(); return; }
    const q = v.effective ? `?effective_from=${encodeURIComponent(v.effective)}` : '';
    const res = await send(`/api/accountability/nodes/${n.id}${q}`, 'DELETE');
    if (!res.ok) { toast(refusal(res, 'Delete refused')); return; }
    if (res.data && res.data.pending) toast(`Deleted from ${res.data.effective_date} — it runs until then`);
    else { toast('Gate deleted'); closeEditor(); }
    await reloadConfig();
  });
  el.querySelector('#gd-save').addEventListener('click', () => (n ? saveGate(n) : createGate()));
}

async function saveTag(n) {
  const E = G.edit;
  const t = E.tag;
  const putKeys = async id => {
    if (!t.meta && !t.mac) return null;
    const r = await send(`/api/accountability/tags/${id}/keys`, 'PUT', { meta: t.meta, mac: t.mac });
    return r.ok ? null : refusal(r, 'Those keys were refused');
  };
  let err;
  if (!t.id) {
    if (!(t.label || '').trim()) { toast('A tag needs a name'); return; }
    const res = await send(`/api/accountability/nodes/${n.id}/tags`, 'POST', { label: t.label.trim(), uid: t.uid });
    if (!res.ok) { toast(refusal(res, 'Could not add it')); return; }
    err = await putKeys(res.data.id);
    if (!err && res.data.pending_live_at) toast(`Added — it starts counting ${stamp(res.data.pending_live_at)}`);
  } else {
    if (!t.meta || !t.mac) { toast('Both keys, or neither'); return; }
    err = await putKeys(t.id);
  }
  if (err) { toast(err); return; }
  E.tag = null;
  E.forceRender = true;
  await reloadConfig();
}

// A weekly schedule as the picker writes one: a rule source anchored today.
// Always a NEW source — PATCHing the one the gate points at would rewrite every
// day that follows it, with no 24h test (the stated LIMIT of the dated-change
// work); pointing the gate at a new one goes through schedule_node_patch.
async function createWeeklySource(v, title) {
  const s = hhmmMin(v.from), e = hhmmMin(v.to);
  if (s == null || e == null) return { error: 'Set both times.' };
  if (!v.days.length) return { error: 'Pick at least one day.' };
  let dur = e - s;
  if (dur <= 0) dur += DAY_MIN;
  const res = await send('/api/schedules', 'POST', {
    kind: 'rule', title: null,
    start: `${wallDay()}T${clock(s)}:00`,
    duration: `PT${Math.floor(dur / 60)}H${dur % 60}M`,
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly',
      byDay: WEEKDAYS.map(([d]) => d).filter(d => v.days.includes(d)).map(day => ({ '@type': 'NDay', day })) }],
  });
  if (!res.ok || !res.data.uid) return { error: refusal(res, 'The schedule was not saved') };
  return { uid: res.data.uid };
}

async function createGate() {
  const E = G.edit;
  const v = E.v;
  const fail = msg => { E.error = msg; E.forceRender = true; renderSheet(); toast(msg); };
  if (!v.label.trim()) return fail('A gate needs a name.');
  const src = await createWeeklySource(v);
  if (src.error) return fail(src.error);
  const loc = G.locations.find(l => String(l.id) === String(v.location));
  const radius = parseInt(v.radius);
  const res = await send('/api/accountability/nodes', 'POST', {
    label: v.label.trim(), source_uid: src.uid,
    geofence_lat: loc ? loc.lat : null, geofence_lng: loc ? loc.lng : null,
    geofence_radius_m: loc ? (isNaN(radius) ? loc.radius_m : radius) : null,
  });
  if (!res.ok) return fail(refusal(res, 'Create failed'));
  await reloadConfig();
  toast('Gate created — its scan link is in the sheet');
  openEditor(res.data.id);
}

async function saveGate(n) {
  const E = G.edit;
  const v = E.v;
  const fail = msg => { E.error = msg; E.forceRender = true; renderSheet(); toast(msg); };
  const body = {};
  // Only what MOVED: an unchanged field in the patch would be classified,
  // queued and reported as a decision nobody made.
  if (v.label.trim() && v.label.trim() !== n.label) body.label = v.label.trim();
  if (v.proof !== v.proof0) body.proof_mode = v.proof;
  if (v.allDay !== v.allDay0 && v.proof !== 'routine') body.all_day = v.allDay === '1' ? 1 : 0;
  const stake = String(v.stake).trim() === '' ? null : Math.round(parseFloat(v.stake) * 100);
  if (stake !== (n.charge_cents == null ? null : n.charge_cents)) body.charge_cents = stake;
  const radius = parseInt(v.radius);
  if (v.proof === 'link' && !isNaN(radius) && radius !== n.geofence_radius_m) body.geofence_radius_m = radius;
  if (v.location) {
    const loc = G.locations.find(l => String(l.id) === String(v.location));
    if (loc) {
      body.geofence_lat = loc.lat;
      body.geofence_lng = loc.lng;
      if (isNaN(radius) || n.geofence_lat == null) body.geofence_radius_m = isNaN(radius) ? loc.radius_m : radius;
    }
  }
  if (v.sched) {
    const src = await createWeeklySource(v);
    if (src.error) return fail(src.error);
    body.source_uid = src.uid;
  }
  // The routine link lives on the FLOW, so moving it is two writes.
  if (v.routine !== v.routine0) {
    if (v.routine0) {
      const r = await send(`/api/flows/${v.routine0}`, 'PATCH', { qr_node_id: null });
      if (!r.ok) return fail(refusal(r, 'Could not unlink the old routine'));
    }
    if (v.routine) {
      const r = await send(`/api/flows/${v.routine}`, 'PATCH', { qr_node_id: n.id });
      if (!r.ok) return fail(refusal(r, 'Could not link the routine'));
    }
  } else if (v.routine && v.offset !== v.offset0 && String(v.offset).trim() !== '') {
    const r = await send(`/api/flows/${v.routine}`, 'PATCH', { offset_min: parseInt(v.offset) });
    if (!r.ok) return fail(refusal(r, 'Could not move the routine deadline'));
  }
  const messages = [];
  if (Object.keys(body).length) {
    if (v.effective) body.effective_from = v.effective;
    const res = await send(`/api/accountability/nodes/${n.id}`, 'PATCH', body);
    if (!res.ok) return fail(refusal(res, 'Not saved'));
    // What the server actually decided, per field — the date asked for is not
    // always the day it starts, and saying the real day is the honest answer.
    const out = res.data || {};
    if ((out.immediate || []).length) {
      messages.push(`${out.immediate.map(f => GATE_FIELDS[f] || f).join(', ')}: now`);
    }
    if ((out.pending || []).length) {
      const days = [...new Set(out.pending.map(f => (out.scheduled[f] || {}).effective_date))];
      messages.push(`${[...new Set(out.pending.map(f => GATE_FIELDS[f] || f))].join(', ')}: from ${days.join(' / ')}`
        + (v.effective && !days.includes(v.effective) ? ` (not ${v.effective} — an easing waits 24h)` : ''));
    }
  }
  if (v.active !== v.active0) {
    const route = v.active ? 'activate' : 'disable';
    const res = await send(`/api/accountability/nodes/${n.id}/${route}`, 'PATCH',
      v.active || !v.effective ? undefined : { effective_from: v.effective });
    if (!res.ok) return fail(refusal(res, v.active ? 'Resume refused' : 'Pause refused'));
    messages.push(v.active ? 'active' : `paused from ${(res.data && res.data.effective_date) || 'in 24h'}`);
  }
  E.error = '';
  toast(messages.length ? messages.join(' · ') : 'Nothing changed');
  await reloadConfig();
  openEditor(n.id);
}

// ══ 4. THE LEDGER — every judged day, and what it cost ═════════
function renderLedger() {
  const el = $('#gd-ledger');
  const L = G.ledger;
  if (!L) { el.innerHTML = sectionHead('Ledger') + '<p class="gd-empty gd-bad-text">The ledger did not load. ↻ to retry.</p>'; return; }
  const rows = L.rows.filter(r => !G.ledgerGate || String(r.node_id) === G.ledgerGate);
  const sum = st => rows.filter(r => st.includes(r.charge_status)).reduce((t, r) => t + (r.amount_cents || 0), 0);
  const gates = [...new Map(L.rows.map(r => [r.node_id, r.label])).entries()];
  el.innerHTML = sectionHead('Ledger', gates.length > 1 ? `<select id="gd-lgate"><option value="">every gate</option>${
      gates.map(([id, label]) => `<option value="${id}"${String(id) === G.ledgerGate ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>` : '')
    + `<div class="gd-hint">Every day the judge has frozen from ${esc(L.from)} to ${esc(L.to)} — met, missed and
      called off. A frozen row is never re-scored under later settings. Charged: ${money(sum(['succeeded']))}${
      sum(['unknown']) ? ` · unknown (may have charged): ${money(sum(['unknown']))}` : ''} · would have charged if live:
      ${money(sum(['would_fire', 'dryrun']))}.</div>`
    + (rows.length ? `<div class="gd-ledger">${rows.map(r => `<div class="gd-lrow gd-lo-${esc(r.outcome)}">
        <span class="gd-ldate">${esc(r.date)}</span>
        <span class="gd-lgate">${esc(r.label)}</span>
        <span class="gd-lout">${esc(OUTCOME_WORD[r.outcome] || r.outcome)}${r.failure_reason ? ' · ' + esc(gateReason(r.failure_reason)) : ''}</span>
        <span class="gd-lcharge">${r.outcome === 'met' || r.outcome === 'off' ? '' : esc(gateStatus(r.charge_status))}${
          r.amount_cents ? ' · ' + money(r.amount_cents) : ''}${r.charge_id ? ` · <span class="gd-mono">#${esc(r.charge_id)}</span>` : ''}</span>
        ${r.window_start ? `<span class="gd-lwin">judged against ${esc(r.window_start)}–${esc(r.window_end)}${r.offset_days ? ' +1d' : ''}</span>` : ''}
      </div>`).join('')}</div>` : '<p class="gd-empty">Nothing judged in this range.</p>');
  const sel = $('#gd-lgate');
  if (sel) sel.addEventListener('change', () => { G.ledgerGate = sel.value; renderLedger(); });
}

// ══ 5. THE RULES — how a day becomes a charge, in words ════════
function renderRules() {
  const b = G.billing || {};
  $('#gd-rules').innerHTML = sectionHead('How it works') + `<ol class="gd-rules">
    <li><b>Where a day's window comes from.</b> This day's change (a drag above) beats the schedule, which beats
      the weekly window, which beats the gate's default. The day view says which one set each window.</li>
    <li><b>Easing waits 24h; tightening is immediate.</b> Anything that makes a gate easier — a later deadline, a
      wider radius, a lower stake, pausing, deleting, all-day, link instead of tag — lands 24h later and can be
      called off until then. A tightening applies at once and cancels the pending easing on that field.</li>
    <li><b>Near the deadline, nothing moves.</b> Within 24h of a gate's close its day cannot be dragged or
      called off. Putting a called-off day back is always allowed.</li>
    <li><b>A judged day is frozen.</b> After a day settles the judge writes one row for it — met, missed, or did
      not run — stamped with the window it was judged against. Later settings never rewrite it. Only yesterday
      and today can move money; an older day found unjudged is judged "too old to charge".</li>
    <li><b>One gate, one proof, one price.</b> A day either costs the whole stake or nothing. A routine linked to
      a scan gate never fails it.</li>
    <li><b>The money rails.</b> The ${money(b.cap_cents)} weekly cap counts the last 7 days, and a charge that
      would cross it is skipped whole. A lost response is logged "unknown", counts against the cap, and is never
      retried — a retry of a charge that went through bills twice. Beeminder is billed the stake minus the
      ${money(b.fee_cents)} card fee.</li>
    <li><b>What each proof is worth.</b> A tag tap is cryptographic. A link scan and its geofence are an honour
      system — the phone reports its own location. Routines and hours are self-reported.</li>
    <li><b>Who can change this page.</b> It has no login: any device on your tailnet can open it and change
      anything here, including arming. The tailnet is the whole boundary. The only public part is the scan
      server, which serves the scan and tap routes and can read nothing but a gate's name.</li>
    <li><b>Secrets.</b> The Beeminder token and every tag's keys live in config.json on the server, never in the
      database or its backups. This page can set or clear them and can never read them back.</li>
  </ol>`;
}

// How to program a tag — moved here with the tag apparatus (it was the app's
// TAG_SETUP_INFO; the dashboard is now the only place a tag is set up).
const TAG_STEPS = `<ol class="gd-rules">
  <li>Read the tag with NFC.cool to get its UID — the 7-byte, 14-hex-character value.</li>
  <li>Add the tag here NOW (+ Tag → name, UID, then Generate both keys), so a half-failed write never leaves
    you holding a configured tag whose keys are nowhere. Copy both keys while the form is open.</li>
  <li>Copy the tap URL. The zeros are placeholders; the tag overwrites them on every tap.</li>
  <li>In NFC.cool Tools, write the full tap URL as the NDEF URL, zeros included.</li>
  <li>Turn on SUN / SDM on the NDEF file (file 02): encrypted PICC data mirror at the e= zeros with UID and
    read-counter mirroring on (not the plain uid=…&amp;ctr=… variant — it is rejected deliberately); SDMMAC mirror
    at the c= zeros; no encrypted file data; MAC input offset = MAC offset; NDEF read access free; the SDM Meta
    Read key and SDM File Read key set to the two keys.</li>
  <li>Change the keys LAST, entered as hex, not as a passphrase. If you also change key 0, write it down
    somewhere durable. Leave it in AES mode, not LRP.</li>
  <li>Back here: set Proof to "NFC tag only". It refuses until the tag and its keys are in place — that refusal
    is the check working.</li>
  <li>Tap it. You should see "Logged — &lt;tag&gt;, read N". If not, Last taps above says which stage failed.
    Nothing there at all means the tap never reached the server.</li>
</ol>`;

// ── Keys ──────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.altKey && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault();
    setPrivacy(!document.documentElement.classList.contains('priv-mode'));
    return;
  }
  const typing = e.target.matches && e.target.matches('input, textarea, select');
  if (e.key === 'Escape') {
    if (liveDrag) return;
    if (G.edit && G.edit.tag) { G.edit.tag = null; G.edit.forceRender = true; renderSheet(); return; }
    if (G.edit) { closeEditor(); return; }
    if (G.sel != null) { G.sel = null; renderDay(); writeRoute(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z' && !typing) {
    e.preventDefault();
    runUndo();
  }
});

$('#gd-undo').addEventListener('click', runUndo);
$('#gd-reload').addEventListener('click', () => { G.tokenCheck = null; loadAll(); });
$('#gd-sheet-back').addEventListener('click', closeEditor);
// Coming back to the page re-reads it: the day may have moved on, the judge
// may have frozen something.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !liveDrag && !G.edit) loadAll();
});

(async function start() {
  const gate = readRoute();
  paintUndo();
  await loadAll();
  if (gate === 'new') openEditor(null);
  else if (gate && G.nodes.some(n => String(n.id) === gate)) openEditor(+gate);
})();
