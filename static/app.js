// DAY_MIN, the minute and day helpers, the fetch envelope, toast, copy, the
// undo stack, the theme and privacy setters all live in static/common.js
// (2026-10-05), loaded before this file and shared with gates.js, panel.js
// and inbox.js.

// ── Theme ─────────────────────────────────────────────────────
// The setting table is the source of truth (it lands in state.settings with
// everything else), but it arrives a fetch late — long enough to paint the
// dark theme first and flash. So the choice is mirrored into localStorage and
// read synchronously here, before the first paint, with the fetched value
// reconciling it afterwards. Only the MAIN window has a theme: the NOW panel
// is its own document and is deliberately light always.
applyTheme(storedTheme());

// ── Privacy mode ──────────────────────────────────────────────
// The class, its sessionStorage mirror and the pre-paint read are common.js's
// (setPrivacy / privacyOn); app.py drives `setPrivacy(...)` in this window by
// name. What is the APP's own is the eye in Engage's header, repainted on the
// event setPrivacy fires.
document.addEventListener('privacychange', () => paintPrivacyEye());

// The eye now says PRIVACY, not the panel: struck through means hidden, which
// is what the mode does, and the panel's own state is read in Settings where
// it is set. Patched in place, never through renderEngage — the hotkey must
// not repaint the day (or the focused capture input under it).
function paintPrivacyEye() {
  const eg = document.getElementById('eg-panel-btn');
  if (!eg) return;
  eg.innerHTML = panelEyeSvg(privacyOn());
  eg.title = privacyEyeTitle();
  eg.classList.toggle('eg-priv-on', privacyOn());
}

function privacyEyeTitle() {
  return `${privacyOn() ? 'Privacy mode — on' : 'Privacy mode'} (Ctrl+Alt+P)`
    + ` · right-click or long-press for ${window.pywebview ? 'the NOW panel' : 'NOW'}`;
}

async function togglePrivacy() {
  const on = !privacyOn();
  setPrivacy(on);
  // The NOW panel is its own document in its own window, and it is the one
  // always on top of everything else — so it follows, down the same road the
  // global hotkeys already drive it with.
  if (window.pywebview) {
    if (window.pywebview.api && window.pywebview.api.set_privacy) {
      await window.pywebview.api.set_privacy(on);
    } else {
      await apiSend('/api/panel/privacy', 'POST', { on });
    }
  }
  toast(on ? 'Privacy mode on · Ctrl+Alt+P' : 'Privacy mode off');
}

function initThemeToggle() {
  applyTheme(storedTheme());  // now that the icons exist
  document.getElementById('theme-toggle').addEventListener('click', async () => {
    const theme = document.documentElement.classList.contains('theme-light') ? 'dark' : 'light';
    applyTheme(theme);
    localStorage.setItem('theme', theme);
    state.settings = await apiSend('/api/settings', 'PATCH', { theme }).then(r => r.json());
  });
}

// ── NOW panel toggle ─────────────────────────────────────────
// Persistent, unlike Ctrl+Alt+M's 10-second hide: the setting survives
// restarts (app.py creates the panel window hidden when it is set).

// The eye, open or struck through. One drawing, two surfaces: the Settings row
// and Engage's header button, which is the one actually reached day to day.
function panelEyeSvg(hidden) {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2">${hidden ? `
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
    <line x1="1" y1="1" x2="23" y2="23"/>` : `
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`}
  </svg>`;
}

function paintPanelToggle(hidden) {
  // Settings only. Engage's eye USED to say which state the panel is in; it
  // says privacy now (2026-09-16), and the panel's state is read where it is
  // set. One drawing cannot carry two states, and the eye's own drawing —
  // struck through for hidden — is the truer picture of the mode that hides
  // the screen than of the window that sits beside it.
  const label = document.getElementById('panel-toggle-label');
  if (!label) return;
  label.textContent = hidden ? 'Panel off' : 'Panel';
  document.getElementById('panel-icon-on').classList.toggle('hidden', hidden);
  document.getElementById('panel-icon-off').classList.toggle('hidden', !hidden);
}

// One toggle for both launch modes: in client mode (PT_SERVER) the window
// lives in THIS process, so the pywebview api call both persists the setting
// on the server and hides/shows locally; the HTTP route covers local mode
// and plain browsers.
async function togglePanel() {
  let hidden;
  if (window.pywebview && window.pywebview.api && window.pywebview.api.toggle_panel) {
    hidden = await window.pywebview.api.toggle_panel();
  } else {
    const res = await apiSend('/api/panel/toggle', 'POST').then(r => r.json());
    hidden = res.hidden;
  }
  state.settings.panel_hidden = hidden ? '1' : '0';
  paintPanelToggle(hidden);
}

// One switch moves the WHOLE app: the server re-dates every calculation in
// the new zone and re-expands the calendar (stored gcal times are naive
// local), while the phone/laptop clocks follow the device as they always did.
// The zone actually in force: the setting when there is one, else the device's,
// which is what an unset setting means. The Display row used to say "local"
// while the pane's select showed the resolved zone — one fact, two answers.
function currentTimezone() {
  return state.settings.timezone
    || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
}

async function initTimezone() {
  const sel = document.getElementById('tz-select');
  if (!sel) return;
  const zones = await apiGet('/api/timezones', []);
  const current = currentTimezone();
  sel.innerHTML = zones.map(z =>
    `<option value="${escHtml(z)}"${z === current ? ' selected' : ''}>${escHtml(z)}</option>`).join('');
  sel.addEventListener('change', async () => {
    sel.disabled = true;
    state.settings = await apiSend('/api/settings', 'PATCH', { timezone: sel.value }).then(r => r.json());
    toast(`Timezone → ${sel.value}. Re-reading the calendar…`);
    // The server re-expands calendars in the background; give it a beat, then
    // repaint everything that renders times.
    setTimeout(async () => {
      await loadAll();
      await refreshEngage();
      sel.disabled = false;
      toast('Day re-shifted to ' + sel.value);
    }, 3000);
  });
}

function initPanelToggle() {
  document.getElementById('panel-toggle').addEventListener('click', togglePanel);
}

// Surfaces register the DAY-LEVEL verbs their objects have, by kind. Declared
// here rather than beside the menu that reads it: the registrations are
// top-level statements next to the surfaces they describe, and a `const` in
// the middle of the file would still be in its temporal dead zone when the
// first of them ran.
const objectVerbProviders = new Map();

// KEYED BY SURFACE, not appended: Engage rebuilds its verbs on every render
// (they close over the day IT is showing), and a list would grow one stale
// provider per repaint, each answering for a day that has since moved.
function registerObjectVerbs(name, fn) { objectVerbProviders.set(name, fn); }

// ── ONE SHEET LIFECYCLE (2026-10-05) ──────────────────────────
// Eight sheets each hand-wrote the same four things: show `#x` and
// `#x-backdrop`, hide both, wire the backdrop's tap-off, and add a rung to
// initHub's Esc ladder. Three of them wired the backdrop INSIDE their render,
// so every repaint stacked one more click listener on it (the entry sheet's
// date form set `onclick` on top as well), and the schedule picker had no
// tap-off and no rung at all — Esc went past it and closed the settings sheet
// it was standing on. Now a sheet is DEFINED once: `defineSheet(id, {rank,
// isOpen, close})` wires its backdrop once and puts its rung on the ladder;
// `showSheet` / `hideSheet` are the class toggling. client_rules_test holds
// that every `.sheet` in index.html is defined here.
//
// THE ESC LADDER IS ONE RANKED LIST. A rung is `peel()` → true when it took
// the key. Sheets register theirs through defineSheet; initHub registers the
// non-sheet rungs (read-outs, menus, overlays) on the same scale, so the whole
// peel order reads in one place — the table above initHub. Declared here for
// objectVerbProviders' reason: the definitions are top-level statements beside
// their sheets, and run long before initHub.
const SHEETS = {};
const ESC_RUNGS = [];

function escRung(rank, peel) {
  ESC_RUNGS.push({ rank, peel });
  ESC_RUNGS.sort((a, b) => a.rank - b.rank);   // stable: equal ranks keep their order
}

function defineSheet(id, spec) {
  SHEETS[id] = spec;
  document.getElementById(id + '-backdrop').addEventListener('click', () => spec.close());
  escRung(spec.rank, () => {
    if (!spec.isOpen()) return false;
    spec.close();
    return true;
  });
}

function showSheet(id) {
  document.getElementById(id).classList.remove('hidden');
  document.getElementById(id + '-backdrop').classList.remove('hidden');
}

function hideSheet(id) {
  document.getElementById(id).classList.add('hidden');
  document.getElementById(id + '-backdrop').classList.add('hidden');
}

// THE GATES DASHBOARD IS WHERE A GATE IS CHANGED (2026-09-29, Quentin's
// instruction). Its configuration, its day-level moves and call-offs, its
// tags and the money switches all live on /gates (templates/gates.html +
// static/gates.js) and nowhere in this file: one editor, so two cannot drift.
// This window still DRAWS gates and reads them out; every door that used to
// write one now opens the dashboard at that gate and day.
// SETTINGS → GATES (2026-10-05, Quentin: put Gates into Settings, no Gates
// tab). The dashboard is MOUNTED there as a frame (/gates?embed=1) — the same
// document and the same gates.js, so it is still the one editor — and every
// door that opened /gates opens that section, at the gate and day it named.
function gatesFrameSrc(nodeId, date) {
  const parts = [];
  if (date && date !== wallDay()) parts.push(`date=${date}`);
  if (nodeId != null) parts.push(`sel=${nodeId}`);
  return '/gates?embed=1' + (parts.length ? '#' + parts.join('&') : '');
}

// Loaded once and left alone after that, so a Settings repaint never reloads
// it mid-edit; only a door naming a gate or a day points it somewhere new.
function mountGatesFrame(src) {
  const frame = document.getElementById('gates-frame');
  if (!frame) return;
  if (src) frame.src = src;
  else if (!frame.getAttribute('src')) frame.src = gatesFrameSrc(null, null);
}

async function openGatesDashboard(nodeId, date) {
  mountGatesFrame(gatesFrameSrc(nodeId, date));
  await goRoute('settings/qr', true);
}

const state = {
  currentDate: new Date(),
  gcalEvents: [],
  calendars: [],
  blocks: [],
  areas: [],
  domains: [],
  todo: null,
  yesterdayTodo: null,
  overrides: [],
  // The VIEWED day's resolved blocks, keyed by the date they answer for —
  // see fetchOverridesForDate. Never read without checking that date.
  viewSegments: { date: null, segments: [] },
  inbox: [],
  projects: [],
  activeBlock: null,
  // activeAreaId is the block calendar's current area; activeDomainId is that
  // area's domain, and the domain is what section 2 lists.
  activeAreaId: null,
  activeDomainId: null,
  activeDomainItems: [],
  section2OverrideDomainId: null,
  section2OverrideItems: null,
  inboxMode: 'capture',
  lastFetched: null,
  planningState: 'unstarted',
  timerSeconds: 600,
  timerInterval: null,
  accountabilityNodes: null,
  qrPageOverrides: {},
  // THE SELECTED GATE and the day the SERVER resolved for it (2026-08-24,
  // Quentin's instruction). One at a time; null means none. `day` is the
  // /day payload verbatim — the same one the read-out renders — because the
  // lines are resolution answers (the window ladder, the offset) and a client
  // that recomputed them would draw a day the judge does not believe in.
  gateSel: null,
  qrOutcomes: {},
  locations: [],
  // Location-bound tags (tag_location) + the last geolocation fix. FAIL-OPEN:
  // geo.ok false (denied, no hardware, plain-http pywebview) hides nothing.
  tagLocations: [],
  // The other two binding axes (see the ctx sheet). `schedules` are the named
  // sources from /api/schedules; each carries the wall-clock INTERVALS it
  // covers the viewed date, computed by schedule.py, so the client is only ever
  // asked "is now inside one of these" — the half a phone can answer.
  tagDevices: [],
  // Which tags are asked about each morning, and today's answers.
  tagDaily: { tags: [], answers: {} },
  tagTimes: [],
  schedules: [],
  allSources: [],
  geo: { ok: false },
  settings: {},
  view: { start: 0, end: DAY_MIN },
  // Right-click day-level view dismissals: blocks keyed `id:date`, events
  // keyed `uid|start`. Undo lives on the global stack (see pushUndo).
  // Blocks and events only. A GATE used to be dismissible here too, which
  // made the pill vanish while the judge charged the day exactly as before:
  // this is a VIEW store, and a gate's day-level state is a fact the judge has
  // to see. Calling a gate's day off is a real write, made on /gates.
  tlHidden: { block: {}, event: {} },
};

// Every fetch here catches, and that is load-bearing rather than defensive:
// Promise.all rejects as a unit, so ONE failure used to take out the whole
// render and leave the empty shell — the offline shape of this screen. With the
// service worker in front these resolve from the last good fetch; the catches
// are what happens when even that is missing (a first-ever offline load, or
// pywebview over plain http, where no worker can register). They fall back to
// the CURRENT state rather than [] so a drop mid-session doesn't blank a day
// that is already on screen; on first load the initialiser makes that [].
async function loadAll() {
  const dateStr = viewDay();
  const [blocks, projects, domains, gcal, overrides, inbox, accountabilityNodes, calendars, settings, qrOutcomes, dismissals, locations, tagLocations, tagDevices, tagTimes, tagDaily, viewSegments, viewGates] = await Promise.all([
    apiGet('/api/blocks', state.blocks),
    apiGet('/api/areas', state.areas),
    apiGet('/api/domains', state.domains),
    apiGet('/api/gcal', state.gcalEvents),
    apiGet(`/api/overrides?date=${dateStr}`, state.overrides),
    apiGet('/api/inbox', state.inbox),
    apiGet('/api/accountability/nodes', []),
    apiGet('/api/calendars', []),
    apiGet('/api/settings', ({})),
    apiGet(`/api/accountability/outcomes?from=${localDatePlusDays(dateStr, -4)}&to=${dateStr}`, []),
    apiGet('/api/dismissals', []),
    apiGet('/api/locations', state.locations),
    apiGet('/api/tag-locations', state.tagLocations),
    apiGet('/api/tag-devices', state.tagDevices),
    apiGet('/api/tag-times', state.tagTimes),
    apiGet('/api/tag-daily', state.tagDaily),
    // The day's blocks as the SERVER resolves them, for the date being looked
    // at. Fetched here as well as on every nav so the first paint has it.
    apiGet(`/api/blocks/day?date=${dateStr}&all=1`, viewSegmentsFor(dateStr)),
    apiGet(`/api/gates/day?date=${dateStr}`, null),
  ]);
  setViewGates(dateStr, viewGates);

  state.viewSegments = { date: dateStr, segments: Array.isArray(viewSegments) ? viewSegments : [] };
  state.locations = Array.isArray(locations) ? locations : [];
  state.tagLocations = Array.isArray(tagLocations) ? tagLocations : [];
  state.tagDevices = Array.isArray(tagDevices) ? tagDevices : [];
  state.tagTimes = Array.isArray(tagTimes) ? tagTimes : [];
  if (tagDaily && Array.isArray(tagDaily.tags)) state.tagDaily = tagDaily;
  state.blocks = blocks;
  state.areas = projects;
  state.domains = domains;
  state.gcalEvents = gcal;
  state.overrides = overrides;
  state.inbox = inbox;
  state.accountabilityNodes = Array.isArray(accountabilityNodes) ? accountabilityNodes : [];
  state.calendars = calendars;
  state.settings = settings;
  // The strip's Social tab, closed the moment the flag lands. Done here rather
  // than in the markup because the answer is the SERVER's -- the template must
  // not carry a second opinion about whether the feature exists.
  // The `hidden` CLASS, not the attribute: .tn-tab sets display:flex, which
  // beats the UA's [hidden] rule, and .hidden is display:none !important.
  const soBtn = document.getElementById('tn-social');
  if (soBtn) soBtn.classList.toggle('hidden', !socialEnabled());
  paintPanelToggle(settings.panel_hidden === '1');
  // The db is authoritative; the localStorage mirror only exists to beat the
  // flash, so re-sync it in case another window (or a restore) changed it.
  if (settings.theme) {
    localStorage.setItem('theme', settings.theme);
    applyTheme(settings.theme);
  }
  state.qrOutcomes = {};
  (Array.isArray(qrOutcomes) ? qrOutcomes : []).forEach(o => { state.qrOutcomes[`${o.node_id}:${o.date}`] = o.outcome; });
  state.tlHidden = { block: {}, event: {} };
  (Array.isArray(dismissals) ? dismissals : []).forEach(d => {
    if (!state.tlHidden[d.type]) return;
    state.tlHidden[d.type][d.key] = true;
  });
  state.lastFetched = new Date();

  const activeBlock = detectCurrentStandardBlock();
  state.activeBlock = activeBlock;
  state.section2OverrideDomainId = null;
  state.section2OverrideItems = null;
  state.activeAreaId = activeBlock ? activeBlock.area_id || null : null;
  state.activeDomainId = filingDomainId(activeBlock);
  state.projects = await apiGet('/api/projects', state.projects);
  if (state.activeDomainId) {
    state.activeDomainItems = await apiGet(`/api/inbox/active?domain_id=${state.activeDomainId}`, state.activeDomainItems);
  } else {
    state.activeDomainItems = [];
  }

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const lastRefresh = parseInt(localStorage.getItem('lastExternalRefresh') || '0');
  const anyNeverFetched = state.calendars.some(c => !c.last_fetched_at);
  if (anyNeverFetched || Date.now() - lastRefresh > SIX_HOURS) {
    refreshExternal();
  }

  renderAll();
}

function renderAll() {
  renderTimeline();
  renderInbox();
}

// ── Timeline ─────────────────────────────────────────────────

let fetchFailed = false;
let currentTimeTick = null;

function renderTimeline() {
  state.view = computeViewWindow();
  renderGrid();
  renderDateLabel();
  renderAlldayStrip();
  const bodyH = document.getElementById('tl-body').clientHeight || 600;
  renderPlanLayer(bodyH);
  renderPlanBar();
  renderBlocksLayer(bodyH);
  renderGcalLayer(bodyH);
  renderQrLayer();
  updateCurrentTimeLine();
  updateFetchStatus();
  startCurrentTimeTick();
  settleTimelineLabels();
  // The week reads the same stores (events, dismissals, settings), so any
  // repaint of the day repaints the week while it is the one on screen.
  if (calWeek.on) renderCalWeek();
}

// ── WHAT A TIMELINE BOX HAS ROOM TO SAY (2026-09-15, Quentin's instruction) ──
//
// A box's text is sized to the box's own height, in tiers, rather than being
// cut mid-word: `full` (every line it has — a block's area and place, an
// event's time, a span's place), `title` (the one line that names it), `short`
// (its first word; a span's length) and `none`. Nothing is lost by the lower
// tiers: every box is still tappable, and its menu or read-out names it in full.
// `lines` is how many lines the full tier would print.
const TL_LINE_PX = 17;

// The title keeps its whole line down to ~70% of a line's height: the text may
// run a few pixels past a short box, which reads fine, and cutting a meeting to
// its first word at half an hour was worse than that.
function tlTier(px, lines) {
  if (px >= lines * TL_LINE_PX + 2) return 'full';
  if (px >= 12) return 'title';
  if (px >= 7) return 'short';
  return 'none';
}

function tlShort(text) {
  return String(text || '').trim().split(/\s+/)[0] || '';
}

// ── TWO LABELS NEVER SHARE SPACE (2026-09-15, Quentin's instruction) ──
//
// The timeline draws three kinds of thing on one strip — planned hours under
// blocks (a span is MEANT to overlap the block it plans), blocks, events — and
// each positions its text by its own time, so a span's "1h · Study" printed
// straight over the block label beside it. The BOXES may overlap; their text
// may not. Every box's text is one `.tl-text` element, and this walks them all,
// across the three layers, in order down the day: any label that would touch
// one already placed is pushed down below it, and the push carries on down the
// column. Only a collision moves anything, and only the TEXT moves — the box
// still starts and ends when it does, so the text is allowed to run past the
// bottom of its box (it paints its own ground when it does).
//
// Measured, not computed: widths come from the rendered text, so a short label
// beside a long one does not collide just because the column could hold more.
// When two start at the same height the block keeps its place, then the span,
// then the event (`data-tl-rank`). The calendar has to be ON SCREEN to measure;
// a hidden render leaves the text where its times put it and openM settles it
// the moment the calendar is shown.
function settleTimelineLabels() {
  const body = document.getElementById('tl-body');
  if (!body || !body.offsetHeight) return;
  const labels = [...body.querySelectorAll('.tl-text')];
  labels.forEach(el => { el.style.transform = ''; el.classList.remove('tl-text-pushed'); });
  const items = labels.map(el => ({ el, r: el.getBoundingClientRect(),
                                    rank: parseInt(el.dataset.tlRank) || 0 }))
    .filter(x => x.r.width > 0 && x.r.height > 0)
    .sort((a, b) => (Math.abs(a.r.top - b.r.top) > 1 ? a.r.top - b.r.top : 0)
                    || a.rank - b.rank || a.r.left - b.r.left);
  const placed = [];
  for (const it of items) {
    let top = it.r.top;
    for (let moved = true; moved;) {
      moved = false;
      for (const q of placed) {
        if (it.r.left < q.right && q.left < it.r.right
            && top < q.bottom + 1 && q.top < top + it.r.height) {
          top = q.bottom + 1;
          moved = true;
        }
      }
    }
    const dy = Math.round(top - it.r.top);
    if (dy > 0) {
      it.el.style.transform = `translateY(${dy}px)`;
      it.el.classList.add('tl-text-pushed');
    }
    placed.push({ left: it.r.left, right: it.r.right, top, bottom: top + it.r.height });
  }
}

// Touch has no right-click and no ⌘-click: a ~550ms STILL press is the same
// gesture. Cancels on movement (so scrolling/dragging never fires it) and
// swallows the click that follows a fired hold, so a long-press can't also
// toggle/cancel whatever a plain tap on that element means. Mouse pointers
// are ignored — they have the real right-click.
// WHEN the last long press fired, as a clock time rather than a flag on an
// element. The flag below still suppresses the click that follows the press —
// but only while the element it was attached to still exists, and a long-press
// handler that re-renders (startedToggle does) destroys its own guard. The
// browser then delivers the touch's synthesized click to the FRESH node, which
// has no memory of the press.
//
// On the pool checkbox that meant a 550ms hold marked the item in progress and
// then COMPLETED it — the most destructive thing on the surface, reached by
// the gesture meant to be the gentle one. A timestamp survives the re-render;
// an element flag cannot.
let lastLongPressAt = 0;

function justLongPressed() {
  return Date.now() - lastLongPressAt < 800;
}

// AND WHEN THE LAST DRAG MOVED — the same question one gesture along, and a
// timestamp for the same reason: the element that was dragged is usually
// re-rendered by the write the drop made, so a flag on it dies with it. A
// mouse drag ends with a click on whatever it dropped on, and every
// `data-obj-tap` artifact opens its menu on a click, so without this a block
// bar or a plan span popped its menu open every time it was moved. Read by
// initObjectDoors; set by onPointerDrag when a live drag actually moves.
let lastPointerDragAt = 0;

function justPointerDragged() {
  // Shorter than justLongPressed's 800ms on purpose: this turns away the click
  // a mouse-up dispatches immediately, and a longer window would eat a real
  // tap on the thing you just moved — which is the one you are most likely to
  // want the menu of.
  return Date.now() - lastPointerDragAt < 400;
}

// ── ONE INLINE RENAME, ONE TAP-OR-DOUBLE (2026-10-05) ─────────
// Six places each built the same field: an input in place of the text,
// focused and selected, a settled guard so Enter and the blur that follows
// cannot both save, Enter commits, Esc cancels (stopped, or the same keydown
// reaches initHub's ladder and peels the page behind the field), blur
// commits. Now `inlineEdit(span, {value, className, onCommit, onCancel, row,
// allowBlank})`: onCommit(v) runs when the trimmed text changed (and is not
// blank unless allowBlank), onCancel() otherwise — each owns the repaint. A
// row being renamed is not draggable while it is (MAP, the pool), and a
// click inside the field belongs to the field, not to the row's tap. Returns
// the input, so a caller can still mark it. The field lets go of focus the
// moment it settles: the repaint guards (renderEngage's eg-renaming, the plan
// layer's) stand down for an unfocused field, so the repaint that follows
// lands.
function inlineEdit(span, { value, className, onCommit, onCancel, row, allowBlank }) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = className || 's2-rename-input';
  input.value = value;
  if (row) row.draggable = false;
  span.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async save => {
    if (settled) return;
    settled = true;
    input.blur();
    if (row) row.draggable = true;
    const v = input.value.trim();
    if (save && v !== value && (v || allowBlank)) await onCommit(v);
    else await onCancel();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
  return input;
}

// A click that waits out the double-click window before it acts, so a
// double-click (a rename) is not first taken as a tap (an open) that repaints
// the text out from under it. Five copies of this timer existed. `within`
// narrows both gestures to part of the element; a click trailing a long
// press or a drag is not a tap.
const DBL_WAIT_MS = 220;

function onTapOrDouble(el, tap, dbl, within) {
  let t = null;
  el.addEventListener('click', e => {
    if (within && !e.target.closest(within)) return;
    if (justLongPressed() || justPointerDragged()) return;
    if (e.detail > 1) return;
    clearTimeout(t);
    t = setTimeout(() => tap(e), DBL_WAIT_MS);
  });
  el.addEventListener('dblclick', e => {
    if (within && !e.target.closest(within)) return;
    clearTimeout(t);
    dbl(e);
  });
}

function onLongPress(el, fn) {
  let t = null, sx = 0, sy = 0, fired = false;
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    // A descendant drag surface claimed this press (see onPointerDrag): the
    // hold belongs to it, not to this element's long-press verb.
    if (e.pointerDragClaim) return;
    fired = false;
    sx = e.clientX; sy = e.clientY;
    t = setTimeout(() => { fired = true; lastLongPressAt = Date.now(); fn(); }, 550);
  });
  el.addEventListener('pointermove', e => {
    if (t && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) {
      clearTimeout(t); t = null;
    }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
    el.addEventListener(ev, () => { clearTimeout(t); t = null; }));
  el.addEventListener('click', e => {
    if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
  }, true);
}

// A DRAG that touch can start too: on a mouse it begins on press, exactly as a
// mouse drag always did; on a finger it begins after a 550ms still hold — the
// same long press that stands in for right-click everywhere else (onLongPress).
//
// The press is what disambiguates. Touch cannot tell "grab this" from "scroll
// the page" at pointerdown, so movement before the timer cancels the gesture and
// lets the page scroll; once armed, the element takes pointer capture and
// `touch-action: none` so the browser cannot steal the gesture mid-drag. Both
// are restored on release, or a scroll would stay dead afterwards.
//
// `spec.start(e)` returns null to decline the gesture, else the handlers for it:
// {move(clientY), end(clientY, e)}. That shape is what lets one drag body serve
// both input paths instead of a mouse copy and a touch copy drifting apart.
// THE DOCUMENT HALF IS INSTALLED ONCE (2026-09-30, Quentin's report: moving a
// gate lagged). It used to be installed per CALL — three document listeners
// for every element wired, never removed — and the calendar re-wires every
// block, event and gate on each repaint, four repaints a refresh. After ten
// refreshes of a week one pointermove ran ~1000 handlers, each holding a
// detached copy of the grid alive. Only one drag is ever live, so its state is
// one object and one set of listeners serves every element.
const pointerDrag = { live: null, el: null, pid: null, prevTouch: null, moved: false };

function pointerDragRelease() {
  const d = pointerDrag;
  if (d.el) {
    if (d.prevTouch !== null) d.el.style.touchAction = d.prevTouch;
    if (d.pid != null && d.el.hasPointerCapture && d.el.hasPointerCapture(d.pid)) {
      d.el.releasePointerCapture(d.pid);
    }
  }
  d.el = null; d.pid = null; d.prevTouch = null;
}

let pointerDragWired = false;
function wirePointerDragDocument() {
  if (pointerDragWired) return;
  pointerDragWired = true;
  // A TOUCH'S SCROLLING IS DECIDED AT touchstart, so the `touch-action: none`
  // set when the hold ARMS (550ms later) is too late to hold the page still:
  // the browser has already ruled this touch may pan, and the first move after
  // the arm arrives as a pointercancel. The drag then died one step in — the
  // plan draw wrote a 35-minute stub of the span being drawn and every other
  // finger drag stopped where it started. preventDefault on POINTERMOVE does
  // not stop a pan (only touchmove's does, and the first touchmove after a
  // still hold is still cancelable), which is why the handler below never
  // helped. So the page is held HERE, and only while a drag is live — a
  // surface that declines the press, or one still counting to 550ms, scrolls
  // exactly as it did.
  document.addEventListener('touchmove', e => {
    if (pointerDrag.live) e.preventDefault();
  }, { passive: false });

  document.addEventListener('pointermove', e => {
    if (!pointerDrag.live) return;
    e.preventDefault();
    pointerDrag.moved = true;
    pointerDrag.live.move(e.clientY);
  }, { passive: false });

  ['pointerup', 'pointercancel'].forEach(ev =>
    document.addEventListener(ev, e => {
      const done = pointerDrag.live;
      if (!done) return;
      pointerDrag.live = null;
      // Stamped from the DROP, not from the last move: what it turns away is
      // the click this release is about to send. Only if the drag actually
      // moved — a press that never moved IS a tap, and on a `data-obj-tap`
      // artifact that tap is how the menu opens.
      if (pointerDrag.moved) lastPointerDragAt = Date.now();
      pointerDrag.moved = false;
      pointerDragRelease();
      done.end(e.clientY, e);
    }));
}

function onPointerDrag(el, spec) {
  wirePointerDragDocument();
  let t = null;

  const arm = e => {
    const live = spec.start(e);
    if (!live) return;
    pointerDragRelease();
    pointerDrag.live = live;
    pointerDrag.moved = false;
    pointerDrag.el = el;
    pointerDrag.pid = e.pointerId;
    pointerDrag.prevTouch = el.style.touchAction;
    el.style.touchAction = 'none';
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
  };

  el.addEventListener('pointerdown', e => {
    // THIS PRESS IS CLAIMED. A drag surface is usually a child of something
    // that long-presses for its own verb (a block's bar inside the block, an
    // event's bar inside the event), and BOTH would arm on one 550ms hold: the
    // finger dragged the thing and hid it in the same gesture. `spec.start`'s
    // stopPropagation cannot prevent that — on touch it runs at 550ms, long
    // after the pointerdown finished bubbling. The flag is set here, in the
    // same dispatch, and onLongPress reads it. Guarding a child against a
    // parent has to happen at POINTERDOWN; this is that rule, one level up.
    e.pointerDragClaim = true;
    if (e.pointerType === 'mouse') {
      arm(e);
      // preventDefault on POINTERDOWN cancels the click that follows it. That
      // is what a handle wants (the bar swallows clicks anyway) and exactly
      // what a whole-element drag surface must not do: a press that never
      // moves is still a TAP, and on an event box that tap opens its occasion.
      // `keepClick` is how such a surface says so; the drag's own suppressor
      // (lpDragged) still turns away the click that TRAILS a real drag.
      if (pointerDrag.live && pointerDrag.el === el && !spec.keepClick) e.preventDefault();
      return;
    }
    // Touch: hold still for 550ms to grab it.
    const sy = e.clientY, sx = e.clientX;
    // The watchers live on DOCUMENT, not on el, and the timer checks that the
    // finger is still down. Both because a finger that slides off the row — or
    // lifts off it — fires neither move nor up on el, so the timer used to arm
    // a drag for a touch that was already over: `touch-action: none` and a
    // preventDefaulting pointermove handler left behind, which is a page that
    // has stopped scrolling for no reason the user can see. They are removed
    // together when the finger lifts, so a press leaves nothing behind.
    let down = true;
    const cancelOnMove = ev => {
      if (t && (Math.abs(ev.clientY - sy) > 10 || Math.abs(ev.clientX - sx) > 10)) {
        clearTimeout(t); t = null;
      }
    };
    const stop = () => {
      down = false;
      clearTimeout(t); t = null;
      document.removeEventListener('pointermove', cancelOnMove);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
    };
    t = setTimeout(() => { t = null; if (down) arm(e); }, 550);
    document.addEventListener('pointermove', cancelOnMove);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
  });

  // A long press that became a drag must not also fire the element's click.
  el.addEventListener('click', e => {
    if (el.dataset.lpDragged === '1') {
      delete el.dataset.lpDragged;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

// THE PER-OCCURRENCE KEY of a fetched event, and the one thing a local move
// may not change: dismissals, moves and the drag all hang off it, so it is the
// start GOOGLE published (`orig_start`), never where the day has since put it.
// Rows fetched before moves existed carry no orig_start and fall back to start,
// which is the same value for everything that was never moved.
function eventKey(e) {
  return `${e.uid}|${e.orig_start || e.start}`;
}

// Right-click a block / event / gate to drop it from the day's view. No backend
// or config change — it returns next day (blocks/qr) or on restart. Ctrl+Z undoes.
function hideTimelineItem(type, key, label) {
  if (state.tlHidden[type][key]) return;
  state.tlHidden[type][key] = true;
  apiSend('/api/dismissals', 'POST', { type, key }).catch(() => {});
  renderTimeline();
  renderEngage();   // Engage shares the event dismissal set (⌘-click there)
  pushUndo(`hid "${label || 'item'}"`, async () => {
    delete state.tlHidden[type][key];
    await apiSend('/api/dismissals', 'DELETE', { type, key }).catch(() => {});
    renderTimeline();
    renderEngage();
  });
}

// View window in semantic minutes (0..2880: past-midnight sleep = end + 1440).
// Hard-clips the timeline to wake→sleep when both gates are chosen in settings.
function computeViewWindow() {
  const nodes = state.accountabilityNodes || [];
  const wake = nodes.find(n => String(n.id) === String(state.settings.qr_wake_node_id));
  const sleep = nodes.find(n => String(n.id) === String(state.settings.qr_sleep_node_id));
  if (!wake || !sleep) return { start: 0, end: DAY_MIN };
  const pageDate = viewDay();
  const viewingToday = isToday(state.currentDate);
  const deadlineMin = (node) => {
    // The served day first — the same deadline the week and the judge use.
    const served = viewGatesFor(pageDate).find(g => g.node_id === node.id);
    if (served && served.window && served.window.end_min != null) return served.window.end_min;
    const ov = viewingToday ? node.today_override : (state.qrPageOverrides[`${node.id}:${pageDate}`] || null);
    const def = nodeWindowForDate(node, pageDate);
    const end = ov ? ov.window_end : def.window_end;
    const offset = ov ? ov.window_end_offset_days : def.window_end_offset_days;
    return windowEndMin(end, offset);
  };
  const start = deadlineMin(wake);
  let end = deadlineMin(sleep);
  // A sleep deadline at/before wake means past midnight, offset flag or not
  if (end <= start) end += DAY_MIN;
  return gateSelBounds({ start, end });
}

// A SELECTED GATE'S LINES ARE ALWAYS ON SCREEN (2026-08-24, asked for). The
// day is clipped to wake→sleep, and a scan window that opens before you wake
// or closes after you sleep would otherwise be marked off the top or bottom
// edge — a dotted line you cannot see is not an explanation. So while
// a gate is selected the window STRETCHES to the outermost line it draws, and
// snaps back when the selection is dropped. Nothing is written: this is the
// same view preference the wake/sleep clip already is.
function gateSelBounds(win) {
  const mins = gateSelLines().map(l => l.min);
  if (!mins.length) return win;
  // A hair of room, so a line ON the boundary is not half a pixel off it.
  const pad = 10;
  return {
    start: Math.min(win.start, Math.min(...mins) - pad),
    end: Math.max(win.end, Math.max(...mins) + pad),
  };
}

// The lines the selected gate draws, in the order they read: its scan window.
// Empty unless a gate is selected
// on the day being LOOKED AT — a selection is about one date, and browsing to
// another must not stretch that day around a window it does not have.
function gateSelLines() {
  const sel = state.gateSel;
  if (!sel || sel.date !== viewDay() || !sel.day) return [];
  const w = sel.day.window || {};
  const lines = [];
  if (w.start_min != null) {
    lines.push({ kind: 'scan-open', min: w.start_min, label: 'scan opens' });
  }
  if (w.end_min != null) {
    lines.push({ kind: 'scan-close', min: w.end_min, label: 'scan closes' });
  }
  return lines;
}

function minutesToViewPercent(mins) {
  return ((mins - state.view.start) / (state.view.end - state.view.start)) * 100;
}

function renderGrid() {
  const grid = document.getElementById('tl-grid');
  if (!grid) return;
  const { start, end } = state.view;
  const win = `${start}-${end}`;
  if (grid.dataset.win === win) return;
  grid.dataset.win = win;
  let html = '';
  for (let h = Math.ceil(start / 60); h * 60 <= end; h++) {
    const pct = minutesToViewPercent(h * 60);
    if (pct < 1) continue;
    // 24h, zero-padded — the design's gutter. Every hour is then the same
    // width, which is the point of setting them in mono: the column reads as a
    // ruler instead of a ragged list. (Event times stay 12h: they are read as
    // words inside a sentence, not scanned down an edge.)
    const hh = h % 24;
    const label = `${String(hh).padStart(2, '0')}:00`;
    html += `<div class="tl-hour" style="top:${pct}%">
      <span class="tl-hour-label">${label}</span>
      <div class="tl-hour-line"></div>
    </div>`;
  }
  grid.innerHTML = html;
}

// The day header's ‹ day › is the shared stepper (dateNavHtml, 2026-10-05),
// so the whole row is drawn here — the bounds and the Today button are a
// fact about the day being drawn. initTimeline listens on the row, not the
// buttons, because the buttons are replaced every paint.
function renderDateLabel() {
  const host = document.getElementById('tl-nav');
  if (!host) return;
  // The weekday is what you read; the date is what you check. Two weights, the
  // design's — and the date in mono so the digits line up as you page through.
  const d = state.currentDate;
  const diff = dayOffset(d);
  const bounds = navBounds();
  host.innerHTML = dateNavHtml({
    prev: 'id="nav-prev"', next: 'id="nav-next"',
    today: diff === 0 ? null : 'id="nav-today"',
    prevDisabled: diff <= bounds.min, nextDisabled: diff >= bounds.max,
    label: `<span id="tl-date-label"><span class="tl-dow">${escHtml(weekdayOf(d).long)}</span>`
      + `<span class="tl-dm">${d.getDate()} ${escHtml(_MONTHS_SHORT[d.getMonth()])}</span></span>`,
  });
}


// ── THE PLAN: hours drawn on the day, before they are worked ─────────────
//
// The PLAN half of the study-hours system (2026-09-02, Quentin's design). The
// other half is study_entry, the minutes actually worked, and they are two
// stores on purpose: a drawn span is a claim about the future, a logged minute
// a claim about the past, and merging them would force the record to lie —
// a plan later "confirmed" is not evidence the work happened.
//
// NOTHING JUDGES A SPAN. qr_judge never reads plan_span, so drawing five hours
// costs and earns exactly nothing. That is what keeps the plan free to be
// optimistic, which is what makes it worth drawing at all; the priming is the
// point, and the accountability lives entirely in the other store.
//
// Drawing is a MODE, and that is a considered exception to the rule that sent
// the edit mode to the gallows. What made THAT mode wrong was invisible state:
// the same tap meant different things and nothing on screen said which. This
// one paints a banner across the top for as long as it is on, changes the
// track's own cursor, and adds a gesture on EMPTY space rather than
// overloading one that already means something — no existing tap changes
// meaning while it is on.
function planModeOn() {
  return !!state.planMode;
}

async function refreshPlan(dateStr) {
  const d = dateStr || viewDay();
  const [plan, hours] = await Promise.all([
    apiGet(`/api/plan/spans?date=${d}`, null),
    // The requirement is the hours GATE's, resolved by the server. The plan
    // surface never works out what the day owes: that number decides money in
    // qr_judge, and a second answer to it here would eventually disagree with
    // the one that charges.
    (function () {
      const node = (state.accountabilityNodes || []).find(n => n.proof_mode === 'hours');
      return node ? apiGet(`/api/accountability/nodes/${node.id}/hours?date=${d}`, null)
                  : Promise.resolve(null);
    })(),
  ]);
  state.plan = plan || { date: d, spans: [], planned_minutes: 0 };
  state.planHours = hours;
}

// The banner. It is the visible half of the mode, and it says the one thing
// the drawing is FOR: how the hours drawn compare with what the day owes.
function renderPlanBar() {
  const bar = document.getElementById('tl-plan-bar');
  const btn = document.getElementById('tl-plan-mode');
  if (!bar) return;
  if (btn) btn.classList.toggle('tl-plan-on', planModeOn());
  bar.classList.toggle('hidden', !planModeOn());
  document.getElementById('tl-body')?.classList.toggle('tl-planning', planModeOn());
  if (!planModeOn()) return;
  const planned = (state.plan || {}).planned_minutes || 0;
  const h = state.planHours;
  let against = '';
  if (h) {
    const owed = h.required_minutes;
    against = owed <= 0
      ? ' · the day owes nothing, the bucket covers it'
      : planned >= owed
        ? ` · that covers the ${humanMinutes(owed)} it owes`
        : ` · ${humanMinutes(owed - planned)} short of the ${humanMinutes(owed)} it owes`;
  }
  // (The "drawing for" domain chips went with domains, 2026-10-01: a span is
  // drawn unfiled, and its own menu files it under an area.)
  bar.innerHTML = `<span class="tl-plan-sum">${planned
    ? humanMinutes(planned) + ' planned' : 'nothing planned yet'}${escHtml(against)}</span>`
    + '<span class="tl-plan-hint">drag an empty stretch to draw · drag a span to move it'
      + ' · tap it for its menu, double-click to type where</span>';
}


function renderPlanLayer(bodyH = 600) {
  const layer = document.getElementById('tl-plan-layer');
  if (!layer) return;
  const dateStr = viewDay();
  const plan = state.plan && state.plan.date === dateStr ? state.plan : null;
  const spans = (plan && plan.spans) || [];

  // A span's location being typed into is HALF-TYPED TEXT, and this layer is
  // rebuilt by the 60s tick, every day change and every write. innerHTML would
  // destroy the box mid-word — the `checkActiveBlock` rule, one surface along.
  if (document.activeElement && document.activeElement.classList.contains('tl-plan-loc-input')
      && layer.contains(document.activeElement)) return;

  // THE EDGE TARGET REACHES OUTSIDE THE SPAN (2026-09-16, Quentin's report:
  // dragging an edge on a phone was too hard). Inside the box a finger got
  // THIRDS, and below ~36px no sub-target at all — which at a day-long zoom is
  // most spans, so the commonest one could not be resized by hand at all. The
  // grab band now OVERHANGS the top and bottom edges: the target is the edge
  // itself rather than a share of the box, so a 20-minute span is as grabbable
  // as an hour and the thirds stay as they were for the spans big enough.
  //
  // It only overhangs into FREE TRACK. Spans abut exactly (planClamp snaps a
  // drag to a neighbour's edge), and a band reaching over a shared boundary
  // would resize whichever of the two happened to be drawn later — the ONE
  // pixel-level ambiguity this could introduce, so each side gets min(8, gap/2)
  // and none at all where there is no room for it.
  const geom = spans.map(s => [
    Math.max(0, minutesToViewPercent(s.start_min)) * bodyH / 100,
    Math.min(100, minutesToViewPercent(s.end_min)) * bodyH / 100]);
  const grabBand = (i, edge) => {
    let gap = Infinity;
    geom.forEach(([t, b], j) => {
      if (j === i) return;
      const d = edge === 'top' ? geom[i][0] - b : t - geom[i][1];
      if (d >= 0) gap = Math.min(gap, d);
    });
    const px = Math.min(8, Math.floor(gap / 2));
    return px >= 3 ? px : 0;
  };

  layer.innerHTML = spans.map((s, i) => {
    const top = Math.max(0, minutesToViewPercent(s.start_min));
    const bottom = Math.min(100, minutesToViewPercent(s.end_min));
    if (bottom - top <= 0) return '';
    const what = filingLabel(s);
    const px = (bottom - top) * bodyH / 100;
    const tight = px < 18;
    const tier = tlTier(px, s.location ? 2 : 1);
    const len = humanMinutes(s.end_min - s.start_min);
    const color = planSpanColor(s);
    return `<div class="tl-plan-span${tight ? ' tl-event-tight' : ''}"
                 data-span-id="${s.id}" data-obj="planspan:${s.id}" data-obj-dbl="1"
                 data-start-min="${s.start_min}" data-end-min="${s.end_min}"
                 style="top:${top}%;height:${bottom - top}%;--grab-top:${
                   grabBand(i, 'top')}px;--grab-bot:${grabBand(i, 'bot')}px${
                   color ? `;--plan-color:${color}` : ''}">
              <div class="tl-plan-bar-grip"></div>${tier === 'none' ? '' : `
              <div class="tl-text" data-tl-rank="1"><span class="tl-plan-label">${escHtml(len)}${
                what && tier !== 'short' ? ' · ' + escHtml(what) : ''}</span>${s.location && tier === 'full'
                ? `<span class="tl-plan-sublabel">📍︎ ${escHtml(s.location)}</span>` : ''}</div>`}
            </div>`;
  }).join('');

  wirePlanSpanDrags(layer, dateStr);
  wirePlanDraw(layer);
}

// A SPAN'S COLOUR IS ITS DOMAIN'S (2026-09-10, Quentin's instruction). The
// colour hangs on the DOMAIN, not on the span: one edit re-colours every hour
// ever drawn for that domain and the day reads as domains at a glance. A
// colour written on the span would be a second answer to "what is this
// stretch for".
//
// A domain with no colour of its own returns null and the span keeps the
// accent it has always drawn in: nothing has to be coloured for the surface
// to work.
function planSpanColor(span) {
  const did = filingDomainId(span);
  if (!did) return null;
  const d = (state.domains || []).find(x => String(x.id) === String(did));
  return (d && d.color) || null;
}

// Minutes under a pointer, snapped to 5 — the same grain the block drag uses,
// and asked of the SAME view window everything else on the timeline is drawn
// against, so a span lands where the finger is at any zoom.
function planMinuteAt(clientY) {
  const body = document.getElementById('tl-body');
  const r = body.getBoundingClientRect();
  const span = state.view.end - state.view.start;
  const frac = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  return Math.round((state.view.start + frac * span) / 5) * 5;
}

// The occupied stretches of the day: every OTHER span. A new span clamps to
// the gap it was started in rather than being refused — a refusal that only
// renders in a bar reads as a dead button on a phone, and here there is not
// even a bar to render it in. Blocks and events are deliberately NOT obstacles:
// planning to work through a block you own is a real intention, and the plan
// is not a booking system.
function planOccupied(exceptId) {
  return ((state.plan || {}).spans || [])
    .filter(s => String(s.id) !== String(exceptId))
    .map(s => [s.start_min, s.end_min])
    .sort((a, b) => a[0] - b[0]);
}

function planClamp(lo, hi, exceptId) {
  for (const [a, b] of planOccupied(exceptId)) {
    if (hi > a && lo < b) {
      if (lo >= a) lo = Math.max(lo, b);      // started inside: push past it
      else hi = Math.min(hi, a);              // grew into it: stop at its edge
    }
  }
  return [lo, hi];
}

// ONCE. renderPlanLayer replaces the layer's innerHTML but not the layer
// ITSELF, so binding here on every render stacked one live handler per repaint
// and a single drag drew three spans at once — the timeline repaints on the
// 60s tick, on every day change and after each write, so the count grew all
// day. The span drags below are bound to elements innerHTML just created and
// are new every time; this one is not, and the mapWired flag is the idiom.
//
// The date is read at DRAG TIME rather than closed over, which is what lets
// the handler outlive the render that made it without ever writing a span to
// the day it was bound on.
let planDrawWired = false;

function wirePlanDraw(layer) {
  if (planDrawWired) return;
  planDrawWired = true;
  onPointerDrag(layer, { start(e) {
    if (!planModeOn()) return null;
    const dateStr = viewDay();
    if (e.pointerType === 'mouse' && e.button !== 0) return null;
    // A press that landed on an existing span belongs to that span.
    if (e.target.closest && e.target.closest('.tl-plan-span')) return null;
    const anchor = planMinuteAt(e.clientY);
    let lo = anchor, hi = anchor;
    const ghost = document.createElement('div');
    ghost.className = 'tl-plan-span tl-plan-ghost';
    layer.appendChild(ghost);

    function paint() {
      const top = Math.max(0, minutesToViewPercent(lo));
      const bottom = Math.min(100, minutesToViewPercent(hi));
      ghost.style.top = `${top}%`;
      ghost.style.height = `${Math.max(0, bottom - top)}%`;
      ghost.textContent = hi - lo >= 5 ? humanMinutes(hi - lo) : '';
    }
    paint();

    return {
      move(clientY) {
        const m = planMinuteAt(clientY);
        [lo, hi] = planClamp(Math.min(anchor, m), Math.max(anchor, m), null);
        paint();
      },
      async end() {
        ghost.remove();
        if (hi - lo < 5) { renderTimeline(); return; }
        const res = await apiSend('/api/plan/spans', 'POST',
          { date: dateStr, start_min: lo, end_min: hi, domain_id: state.planDomainId });
        if (!res.ok) { toast('Could not draw that span'); renderTimeline(); return; }
        const row = await res.json();
        // A GESTURE IS A BUTTON: a create inverts to a delete of the row it
        // made, registered in the handler that made it.
        pushUndo(`drew ${humanMinutes(hi - lo)}`, async () => {
          await apiSend(`/api/plan/spans/${row.id}`, 'DELETE');
          await refreshPlan(dateStr);
          renderTimeline();
        });
        await refreshPlan(dateStr);
        renderTimeline();
        renderPlanBar();
      },
    };
  } });
}

// THE WHOLE SPAN IS THE HANDLE (2026-09-05, Quentin's report: a drawn region
// could not be dragged on a phone). It was the 14px rail alone, which is a
// mouse target — the app's own rule is thirds, not edges, and below ~36px the
// sub-target is dropped rather than offered where a finger cannot hit it. The
// rail stays as the affordance that says "this can be grabbed"; it is no
// longer the only thing that can be.
//
// What made the body free to become a drag surface is that a span's menu opens
// on a TAP (`data-obj-tap`), so the 550ms hold that every other artifact spends
// on its menu is spare here — and a press on a span already meant nothing else.
// `keepClick` keeps the mouse's tap alive (a press that never moves is still a
// tap, and the tap is the menu); justPointerDragged turns away the click that
// TRAILS a real drag.
function wirePlanSpanDrags(layer, dateStr) {
  layer.querySelectorAll('.tl-plan-span').forEach(el => {
    el.dataset.objTap = '1';        // a tap opens its menu; nothing here mutates bare
    const origStart = parseInt(el.dataset.startMin);
    const origEnd = parseInt(el.dataset.endMin);
    const id = el.dataset.spanId;

    onPointerDrag(el, { keepClick: true, start(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return null;
      // A press in the location box is placing a caret or selecting a word.
      if (e.target.closest('.tl-plan-loc-input')) return null;
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      // Thirds for a finger, a 10px edge for a mouse — the block bar's rule,
      // and below ~36px the sub-targets are dropped rather than offered
      // where they cannot be hit. OUTSIDE the box is the edge itself: the
      // overhanging band renderPlanLayer sized (which is why this asks about
      // the rect and not about a class), and it is the only target a short
      // span has, so it answers before the height rule does.
      const touch = e.pointerType !== 'mouse';
      const mode = e.clientY < r.top ? 'start'
        : e.clientY > r.bottom ? 'end'
        : touch
        ? (r.height < 36 ? 'move'
          : e.clientY - r.top < r.height / 3 ? 'start'
          : r.bottom - e.clientY < r.height / 3 ? 'end' : 'move')
        : ((e.clientY - r.top < 10) ? 'start' : (r.bottom - e.clientY < 10) ? 'end' : 'move');
      const startM = planMinuteAt(e.clientY);
      let curS = origStart, curE = origEnd, dragged = false;

      return {
        move(clientY) {
          dragged = true;
          const delta = planMinuteAt(clientY) - startM;
          let lo = curS, hi = curE;
          if (mode === 'move') { lo = origStart + delta; hi = origEnd + delta; }
          else if (mode === 'start') lo = Math.min(origStart + delta, origEnd - 5);
          else hi = Math.max(origEnd + delta, origStart + 5);
          [curS, curE] = planClamp(lo, hi, id);
          el.style.top = `${Math.max(0, minutesToViewPercent(curS))}%`;
          el.style.height = `${Math.min(100, minutesToViewPercent(curE))
            - Math.max(0, minutesToViewPercent(curS))}%`;
        },
        async end() {
          // A PRESS THAT NEVER MOVED IS A TAP, and the tap is how this span's
          // menu opens — so the whole-span drag must leave it alone. Repainting
          // here would eat it: renderTimeline rebuilds the layer, and the click
          // the mouse-up is about to send then lands on a detached node with no
          // `data-obj-tap` above it. Only a drag that MOVED owes a repaint,
          // and one that moved back to where it started owes just the snap.
          if (!dragged) return;
          if (curS === origStart && curE === origEnd) { renderTimeline(); return; }
          const res = await apiSend(`/api/plan/spans/${id}`, 'PATCH',
            { start_min: curS, end_min: curE });
          if (!res.ok) { toast('Could not move that span'); renderTimeline(); return; }
          // The inverse is the geometry it had BEFORE the drop, read before
          // the write — scoped to this drop, so a sibling handler's undo
          // cannot vouch for it.
          pushUndo('moved a planned span', async () => {
            await apiSend(`/api/plan/spans/${id}`, 'PATCH',
              { start_min: origStart, end_min: origEnd });
            await refreshPlan(dateStr);
            renderTimeline();
          });
          await refreshPlan(dateStr);
          renderTimeline();
          renderPlanBar();
        },
      };
    } });
  });
}

// Deleting one, with its inverse: the row comes back with its ORIGINAL id, so
// anything still pointing at it points at the same span rather than a copy.
async function deletePlanSpan(span) {
  const res = await apiSend(`/api/plan/spans/${span.id}`, 'DELETE');
  if (!res.ok) { toast('Could not remove that span'); return; }
  pushUndo(`removed ${humanMinutes(span.end_min - span.start_min)}`, async () => {
    await apiSend('/api/plan/spans', 'POST', {
      id: span.id, date: span.date, start_min: span.start_min,
      end_min: span.end_min, area_id: span.area_id, domain_id: span.domain_id,
      location: span.location });
    await refreshPlan(span.date);
    renderTimeline();
  });
  await refreshPlan(span.date);
  renderTimeline();
  renderPlanBar();
}

// DOUBLE-CLICK A SPAN AND TYPE WHERE (2026-09-14, Quentin's instruction). The
// span's second line becomes a text box, in place: no sheet, no picker, and
// nothing from Settings' locations, which are geofences and not the words you
// would use for a place you mean to work. Enter or leaving the box saves,
// Esc puts the words back, blank clears. One edit, one undo entry.
function editPlanSpanLocation(id, el) {
  const span = ((state.plan || {}).spans || []).find(s => String(s.id) === String(id));
  if (!span || el.querySelector('.tl-plan-loc-input')) return;
  const was = span.location || '';
  const sub = el.querySelector('.tl-plan-sublabel');
  if (sub) sub.remove();
  // The field takes the second line's place (a slot, since a span with no
  // location has no line to replace). Blank CLEARS, so it is allowed.
  const slot = document.createElement('span');
  el.appendChild(slot);
  const input = inlineEdit(slot, {
    value: was,
    className: 'tl-plan-loc-input',
    allowBlank: true,
    onCancel: () => renderTimeline(),
    onCommit: async now => {
      const res = await apiSend(`/api/plan/spans/${span.id}`, 'PATCH', { location: now });
      if (!res.ok) { toast('Could not save where'); renderTimeline(); return; }
      pushUndo(now ? `set where to "${now}"` : 'cleared where', async () => {
        await apiSend(`/api/plan/spans/${span.id}`, 'PATCH', { location: was });
        await refreshPlan(span.date);
        renderTimeline();
      });
      await refreshPlan(span.date);
      renderTimeline();
    },
  });
  input.placeholder = 'where?';
  input.setAttribute('aria-label', 'Where this span happens');
}

registerObjectVerbs('timeline-plan-span', (kind, id) => {
  if (kind !== 'planspan') return [];
  const span = ((state.plan || {}).spans || []).find(s => String(s.id) === String(id));
  if (!span) return [];
  return [{ label: 'Remove this span', danger: true, run: () => deletePlanSpan(span) }];
});

function renderBlocksLayer(bodyH = 600) {
  const layer = document.getElementById('tl-blocks-layer');
  if (!layer) return;
  const projectsById = Object.fromEntries(state.areas.map(p => [p.id, p]));
  const dateStr = viewDay();

  // SERVED, not re-derived: which blocks this date runs, their times with any
  // override applied, and yesterday's overnight tail arriving at a negative
  // start. A block scheduled to move or pause on a future date is already
  // resolved into this, which is what makes the change visible before it
  // lands rather than the moment it does.
  const segments = drawnSegments(viewSegmentsFor(dateStr)).map(segmentRow);

  if (!segments.length && !state.blocks.some(b => b.active)) {
    layer.innerHTML = '<div class="tl-placeholder">No blocks yet — open Block Editor to add your schedule</div>';
    return;
  }

  // Hard-clip to the view window
  const visible = segments.map(s => {
    const top = Math.max(0, minutesToViewPercent(s.startMin));
    const bottom = Math.min(100, minutesToViewPercent(s.endMin));
    return { ...s, top, height: bottom - top };
  }).filter(s => s.height > 0 && !state.tlHidden.block[`${s.b.id}:${dateStr}`]);

  const blocksHtml = visible.map(seg => {
    const { b, top, height, cancelled, label, cont, startMin, endMin } = seg;
    const purpose = blockPurpose(seg);
    const proj = b.area_id ? projectsById[b.area_id] : null;
    const px = height * bodyH / 100;
    const tight = px < 18;
    const tier = tlTier(px, 1 + (proj ? 1 : 0) + (b.location_name ? 1 : 0));
    const labelSpan = `<span class="tl-block-label${cancelled ? ' tl-cancelled-text' : ''}">${
      escHtml(tier === 'short' ? tlShort(label) : label)}</span>`;
    const locLabel = b.location_name
      ? `<span class="tl-block-sublabel"${b.location_id ? ` data-obj="location:${b.location_id}"` : ''
        }>📍︎ ${escHtml(b.location_name)}</span>` : '';
    const subs = tier !== 'full' ? '' : `${proj
      ? `<span class="tl-block-sublabel" data-obj="area:${proj.id}">${escHtml(proj.name)}</span>` : ''}${locLabel}`;
    const inner = `<div class="tl-block-bar"></div>${tier === 'none' ? ''
      : `<div class="tl-text" data-tl-rank="0">${labelSpan}${subs}</div>`}`;
    return `<div class="tl-block${cancelled ? ' tl-block-cancelled' : ''}${cont ? ' tl-block-cont' : ''}${tight ? ' tl-event-tight' : ''}${seg.dayBlockId ? ' tl-block-day' : ''}"
                 ${blockObjAttrs(seg)} data-purpose="${escHtml(purpose)}"
                 ${blockCatAttrs(seg)}
                 data-start-min="${startMin}" data-end-min="${endMin}"
                 style="top:${top}%;height:${height}%;cursor:${cont ? 'default' : 'pointer'};
                        --block-color:${b.color}">${inner}</div>`;
  }).join('');

  // Overlaps are allowed — a striped zone marks each intersection
  const act = visible.filter(s => !s.cancelled);
  let zonesHtml = '';
  for (let i = 0; i < act.length; i++) {
    for (let j = i + 1; j < act.length; j++) {
      const lo = Math.max(act[i].startMin, act[j].startMin);
      const hi = Math.min(act[i].endMin, act[j].endMin);
      if (hi <= lo) continue;
      const top = Math.max(0, minutesToViewPercent(lo));
      const bottom = Math.min(100, minutesToViewPercent(hi));
      if (bottom - top <= 0) continue;
      zonesHtml += `<div class="tl-conflict-zone" style="top:${top}%;height:${bottom - top}%"></div>`;
    }
  }

  layer.innerHTML = blocksHtml + zonesHtml;

  // A BARE CLICK NO LONGER CANCELS YOUR DAY, and since 2026-09-30 it does not
  // open the menu either: it lights up the block's CATEGORY (initCalBlockPin),
  // and the menu is on that bar's ⋯. The right-click and the long press still
  // cancel it for the day (openObjectMenuOrRemove), wired once on the
  // document by initObjectDoors.
  initBlockBarDrag(layer, dateStr);
}

// CANCEL A BLOCK FOR ONE DAY, or put it back — for the day the SURFACE is
// showing, passed in (Engage browses its own day, a week column is its own
// date). It was Engage's alone; the week needed it too, and a third copy of a
// money-adjacent write is how two surfaces start filing under different days.
// The day view had exactly that third copy (toggleBlockOverride) — with no
// undo — until right-click made it one gesture (2026-09-30); it asks here now.
// `overrides` is that day's override rows, read before the write so the undo
// is the state the day was in.
async function toggleBlockCancelOn(blockId, dateStr, overrides, after) {
  const existing = (overrides || []).find(o => o.block_id === blockId && o.date === dateStr);
  const hasTimes = existing && (existing.start_time || existing.end_time);
  const label = (state.blocks.find(b => b.id === blockId) || {}).label || 'block';
  if (existing && existing.cancelled === 1 && !hasTimes) {
    // Un-cancel with nothing else on the row — drop the override entirely
    // (same rule as the timeline's toggle).
    await apiSend(`/api/overrides/${existing.id}`, 'DELETE');
    pushUndo(`restored "${label}"`, async () => {
      await apiSend('/api/overrides', 'POST', { block_id: blockId, date: dateStr, cancelled: true });
      await refreshAfterUndo();
    });
  } else {
    const target = !(existing && existing.cancelled === 1);
    await apiSend('/api/overrides', 'POST', { block_id: blockId, date: dateStr, cancelled: target });
    pushUndo(`${target ? 'cancelled' : 'restored'} "${label}"`, async () => {
      await apiSend('/api/overrides', 'POST', { block_id: blockId, date: dateStr, cancelled: !target });
      await refreshAfterUndo();
    });
  }
  await after();
}

// A WEEK COLUMN'S VERBS for a block: the same two the day view offers, for
// the column's own date.
registerObjectVerbs('week-block', (kind, id, el) => {
  if (kind !== 'block' || !el.closest('#cal-week')) return [];
  const blockEl = el.closest('.tl-block') || el;
  const d = blockEl.dataset.date;
  if (!d) return [];
  const overrides = (calWeek.days[d] || {}).overrides || [];
  const ov = overrides.find(o => o.block_id === parseInt(id) && o.date === d);
  const cancelled = ov && ov.cancelled === 1;
  const label = blockEl.querySelector('.tl-block-label')?.textContent || 'Block';
  return [
    ...purposeItem(blockEl),
    { label: cancelled ? 'Restore for this day' : 'Cancel for this day',
      danger: !cancelled, rightClick: true,
      run: () => toggleBlockCancelOn(parseInt(id), d, overrides, refreshCalWeek) },
    { label: 'Hide for this day',
      run: () => hideTimelineItem('block', `${id}:${d}`, label) },
  ];
});

// THE TIMELINE'S OWN VERBS for a block, handed to the object menu. They need
// the DAY being looked at, which is the surface's to know and not the menu's —
// so the surface registers them rather than the menu reaching for a date.
registerObjectVerbs('timeline-block', (kind, id, el) => {
  if (kind !== 'block' || !el.closest('#tl-qr-layer, #tl-body')) return [];
  const dateStr = viewDay();
  const blockEl = el.closest('.tl-block') || el;
  const label = blockEl.querySelector('.tl-block-label')?.textContent || 'Block';
  const ov = (state.overrides || []).find(o => o.block_id === parseInt(id) && o.date === dateStr);
  const cancelled = ov && ov.cancelled === 1;
  return [
    ...purposeItem(blockEl),
    { label: cancelled ? 'Restore for today' : 'Cancel for today',
      danger: !cancelled, rightClick: true,
      run: () => toggleBlockCancelOn(parseInt(id), dateStr, state.overrides, async () => {
        await fetchOverridesForDate(state.currentDate);
        renderTimeline();
      }) },
    { label: 'Hide for today',
      run: () => {
        hideTimelineItem('block', `${id}:${dateStr}`, label);
        renderTimeline();
      } },
  ];
});

// HOW A CALENDAR SURFACE MAPS PIXELS TO MINUTES (2026-09-29). The day view is
// percent-positioned inside #tl-body; a week column is pixel-positioned at
// WK_HOUR_PX. The block and event drags take this as a parameter so ONE drag
// body serves both — a week copy of them would be the parallel implementation
// that agrees until one of them grows a step (a clamp, a slop, an undo).
//   start/end   the minutes the surface shows
//   px()        its height in pixels, measured at drag start
//   place()     draw an element at a span while it is being dragged
//   overrides() the day's block overrides — what a drop's undo restores
//   dropped()   re-read the surface after a block drop wrote
//   repaint()   put a drag that wrote nothing back where it was
function dayDragGeo() {
  const body = document.getElementById('tl-body');
  return {
    start: state.view.start, end: state.view.end,
    px: () => body.getBoundingClientRect().height,
    place: (el, s, e) => {
      el.style.top = `${Math.max(0, minutesToViewPercent(s))}%`;
      el.style.height = `${Math.min(100, minutesToViewPercent(e)) - Math.max(0, minutesToViewPercent(s))}%`;
    },
    overrides: () => state.overrides,
    dropped: async (blockId, dateStr, data) => {
      const idx = state.overrides.findIndex(o => o.block_id === blockId && o.date === dateStr);
      if (idx !== -1) state.overrides[idx] = data; else state.overrides.push(data);
      // The times on screen are the SERVER's resolution of this day, so a
      // dropped block moves once the day is re-resolved — not when the local
      // override array is patched.
      await fetchOverridesForDate(state.currentDate);
    },
    repaint: () => renderTimeline(),
  };
}

// The color bar is the manipulation surface (mirrors gate pills): top/bottom
// edges resize, the middle moves the whole block — each writes a one-day
// override on drop. Block defaults stay in the Block Editor.
function initBlockBarDrag(layer, dateStr, geo) {
  const g = geo || dayDragGeo();
  layer.querySelectorAll('.tl-block:not(.tl-block-cont):not(.tl-block-cancelled) .tl-block-bar').forEach(bar => {
    const blockEl = bar.parentElement;
    const blockId = parseInt(blockEl.dataset.blockId);
    const dayBlockId = parseInt(blockEl.dataset.dayBlockId);
    const origStart = parseInt(blockEl.dataset.startMin);
    const origEnd = parseInt(blockEl.dataset.endMin);

    bar.addEventListener('mousemove', e => {
      const r = bar.getBoundingClientRect();
      const edge = e.clientY - r.top < 10 || r.bottom - e.clientY < 10;
      bar.style.cursor = edge ? 'ns-resize' : 'grab';
    });
    bar.addEventListener('click', e => e.stopPropagation());

    onPointerDrag(bar, { start(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return null;
      e.stopPropagation();
      const span = g.end - g.start;
      if (origEnd - origStart >= span) return null;
      const r = bar.getBoundingClientRect();
      // A 10px edge is a mouse target, not a finger one, and touch has no hover
      // to discover it with — so a finger splits the bar into THIRDS instead.
      // Below ~36px there is no third worth aiming at, so the whole bar moves:
      // offering a resize you cannot hit reliably is worse than not offering it.
      const touch = e.pointerType !== 'mouse';
      const mode = touch
        ? (r.height < 36 ? 'move'
          : e.clientY - r.top < r.height / 3 ? 'start'
          : r.bottom - e.clientY < r.height / 3 ? 'end' : 'move')
        : ((e.clientY - r.top < 10) ? 'start' : (r.bottom - e.clientY < 10) ? 'end' : 'move');
      const startY = e.clientY;
      const bodyPx = g.px();
      let moved = false;
      let curS = origStart, curE = origEnd;
      // A finger has already committed by holding still for 550ms, so it must
      // not also have to clear the 5px slop the mouse uses to tell a click from
      // a drag — that would make a careful small adjustment do nothing.
      const slop = touch ? 0 : 5;
      if (touch) bar.dataset.lpDragged = '1';

      function onMove(clientY) {
        if (!moved && Math.abs(clientY - startY) < slop) return;
        moved = true;
        const deltaMin = Math.round(((clientY - startY) / bodyPx) * span / 5) * 5;
        if (mode === 'move') {
          const len = origEnd - origStart;
          curS = Math.min(Math.max(g.start, origStart + deltaMin), g.end - len);
          curE = curS + len;
        } else if (mode === 'start') {
          curS = Math.min(Math.max(g.start, origStart + deltaMin), origEnd - 15);
        } else {
          curE = Math.max(Math.min(g.end, origEnd + deltaMin), origStart + 15);
        }
        g.place(blockEl, curS, curE);
      }

      async function onUp() {
        document.body.style.cursor = '';
        if (!moved || (curS === origStart && curE === origEnd)) { g.repaint(); return; }
        if (dayBlockId) {
          await undoableDayBlockMove(dayBlockId, curS, curE);
          g.repaint();
          return;
        }
        // Read BEFORE the write: the inverse of this drop is the override the
        // day had before it, and "none" is a delete of whatever the POST
        // creates — see restoreBlockOverride.
        const prevOv = g.overrides().find(o => o.block_id === blockId && o.date === dateStr) || null;
        const res = await apiSend('/api/overrides', 'POST', {
            block_id: blockId, date: dateStr, cancelled: false,
            start_time: clockHHMM(curS),
            end_time: clockHHMM(curE),
          });
        if (res.ok) {
          const data = await res.json();
          undoableBlockOverride(blockId, dateStr, prevOv, data.id,
            `moved "${blockEl.querySelector('.tl-block-label')?.textContent || 'block'}"`);
          await g.dropped(blockId, dateStr, data);
        }
        g.repaint();
      }

      document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ns-resize';
      return { move: onMove, end: onUp };
    } });
  });
}

function renderAlldayStrip() {
  const strip = document.getElementById('tl-allday-strip');
  if (!strip) return;
  const dayEvents = state.gcalEvents.filter(e => e.allday && sameDay(state.currentDate, e.start)
    && calShowsEvent(e));
  strip.innerHTML = dayEvents.map(e => {
    const col = e.color || '#888888';
    // The calendar's hue is handed to CSS as a variable; what is DONE with it
    // — the fill, the rule, and how far the text is pulled toward legibility —
    // belongs to the theme. It used to be mixed 50% with a hardcoded #fff
    // here, which reads on the dark surface and is invisible on the light one.
    return `<div class="tl-allday-event" style="--ev-color:${col}">${escHtml(e.summary || '')}</div>`;
  }).join('');
}


function renderGcalLayer(bodyH = 600) {
  const layer = document.getElementById('tl-gcal-layer');
  if (!layer) return;
  layer.style.pointerEvents = 'none';
  const nextDate = new Date(state.currentDate.getTime() + 86400000);
  // Next-day events count when the view runs past midnight (sleep +1d)
  const dayEvents = state.gcalEvents.filter(e => !e.allday && calShowsEvent(e) &&
    (sameDay(state.currentDate, e.start) || (state.view.end > DAY_MIN && sameDay(nextDate, e.start))));
  const boxes = [];
  for (const e of dayEvents) {
    const base = sameDay(nextDate, e.start) ? DAY_MIN : 0;
    const startMin = base + isoMin(e.start);
    let endMin = base + isoMin(e.end);
    if (endMin <= startMin) endMin += DAY_MIN;
    const top = Math.max(0, minutesToViewPercent(startMin));
    const bottom = Math.min(100, minutesToViewPercent(endMin));
    if (bottom - top <= 0) continue;
    boxes.push({ e, startMin, endMin, top, bottom });
  }
  // TWO TITLES MAY NOT SHARE A LINE — and since 2026-09-29 the answer is the
  // week column's: events that overlap share the width in LANES, rather than
  // one being pushed down under the other, so every box still starts and ends
  // at its own time and no two titles can print over each other.
  wkLanes(boxes.map(box => ({ box, s: box.startMin, e: box.endMin })))
    .forEach(l => { l.box.lane = l.lane; l.box.lanes = l.lanes; });

  layer.innerHTML = boxes.map(({ e, top, bottom, startMin, endMin, lane, lanes: n }) => {
    const height = Math.max(bottom - top, 2);
    const px = height * bodyH / 100;
    const tight = px < 18;
    // The name, and under it the time where there is room for a second line.
    const tier = tlTier(px, 2);
    const w = 100 / (n || 1);
    const timeStr = `${isoToAmPm(e.start)}–${isoToAmPm(e.end)}`;
    // The bar is the manipulation surface, exactly as it is on a block: a long
    // press on the BOX still hides the event, so the two touch gestures cannot
    // both arm on the same 550ms hold.
    const inner = `<div class="tl-ev-bar"></div>${tier === 'none' ? ''
      : `<div class="tl-event-row"><span class="tl-event-summary">${
        escHtml(tier === 'short' ? tlShort(e.summary) : (e.summary || ''))}</span>${tier === 'full'
        ? `<span class="tl-event-time">${escHtml(timeStr)}</span>` : ''}</div>`}`;
    const col = e.color || '#888888';
    const key = eventKey(e);
    const moved = e.moved
      ? ` title="Moved here — the calendar still says ${escHtml(isoToAmPm(e.orig_start))}. Right-click or long-press the bar to put it back."`
      : tier === 'full' ? '' : ` title="${escHtml(`${e.summary || 'Event'} · ${timeStr}`)}"`;
    return `<div class="tl-gcal-event${tight ? ' tl-event-tight' : ''}${e.moved ? ' tl-event-moved' : ''}"
                 data-ev-key="${escHtml(key)}" data-ev-label="${escHtml(e.summary || 'Event')}"
                 data-ev-uid="${escHtml(e.uid)}" data-ev-start="${escHtml(e.orig_start || e.start)}"
                 data-start-min="${startMin}" data-end-min="${endMin}"${moved}
                 style="pointer-events:auto;top:${top}%;height:${height}%;--ev-color:${col};
                        left:calc(10px + (100% - 28px) * ${lane / (n || 1)});
                        width:calc((100% - 28px) * ${w / 100} - 2px)">${inner}</div>`;
  }).join('');

  // Read-only iCal events can't be deleted at source — right-click hides them
  // from view for the session (persists across refreshes, restored by Ctrl+Z).
  layer.querySelectorAll('.tl-gcal-event').forEach(el => {
    const hide = () => {
      hideTimelineItem('event', el.dataset.evKey, el.dataset.evLabel);
      renderTimeline();
    };
    el.addEventListener('contextmenu', e => { e.preventDefault(); hide(); });
    onLongPress(el, hide);   // the touch right-click
    // Same plain-tap meaning as the event row on Engage: open its read-out —
    // where it is and what the invite said. The occasion is in its foot.
    el.addEventListener('click', () => openEventPop(el.dataset.evKey, el));
  });

  initEventDrag(layer);
}

// MOVING A FETCHED EVENT (2026-08-24, Quentin asked for it). The gesture is a
// block's, on the event's own bar: drag the middle to move the whole thing,
// the top or bottom third (a 10px edge on a mouse) to change one end.
//
// What it writes is a LOCAL nudge. gcal stays a read-only mirror — the row the
// feed published keeps Google's time. A moved event used to draw a darker
// outline to say the two disagree; since 2026-09-30 it draws no edge (asked
// for) and only its tooltip says so. Right-click or long-press the BAR puts it back; the same gestures on
// the box still hide the event, which is why the bar exists at all.
function initEventDrag(layer, dateOf, geo) {
  const g = geo || dayDragGeo();
  // TWO SURFACES, because the two inputs have different collisions. A MOUSE
  // drags the event from anywhere on it (2026-08-24, asked for): its press
  // starts the drag immediately, a press that never moves is still a click, and
  // hiding is right-click — nothing competes. A FINGER cannot have that: a
  // 550ms hold on the box is already "hide from my day", so touch drags from
  // the hairline bar, whose own hold means only this.
  const surfaces = [];
  layer.querySelectorAll('.tl-gcal-event').forEach(box => {
    surfaces.push([box.querySelector('.tl-ev-bar'), box, 'both']);
    surfaces.push([box, box, 'mouse']);   // keepClick: the tap still opens it
  });
  surfaces.forEach(([bar, el, inputs]) => {
    if (!bar) return;
    const origStart = parseInt(el.dataset.startMin);
    const origEnd = parseInt(el.dataset.endMin);
    // The day this occurrence is drawn on: a write files under the day being
    // LOOKED AT (the week column's own date there), sent explicitly, never the
    // wall clock at drop time.
    const dateStr = dateOf || viewDay();

    bar.addEventListener('mousemove', e => {
      const r = bar.getBoundingClientRect();
      const edge = e.clientY - r.top < 10 || r.bottom - e.clientY < 10;
      bar.style.cursor = edge ? 'ns-resize' : 'grab';
    });
    // Only the BAR swallows the click and owns the restore gestures. On the
    // box they would take the tap that opens the occasion and the right-click
    // that hides the event — the two things the box already means. What the
    // box does need is the drag's own click suppressor, so a mouse drag that
    // ends on it does not also open the occasion sheet.
    if (inputs === 'both') {
      bar.addEventListener('click', e => e.stopPropagation());
      if (el.classList.contains('tl-event-moved')) {
        const restore = () => unmoveEvent(el.dataset.evUid, el.dataset.evStart);
        bar.addEventListener('contextmenu', e => {
          e.preventDefault(); e.stopPropagation(); restore();
        });
        onLongPress(bar, restore);
      }
    } else {
      bar.addEventListener('click', e => {
        if (el.dataset.lpDragged === '1') { e.stopPropagation(); e.preventDefault(); }
      }, true);
    }

    onPointerDrag(bar, { keepClick: inputs === 'mouse', start(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return null;
      // The box declines touch: that hold belongs to hide.
      if (inputs === 'mouse' && e.pointerType !== 'mouse') return null;
      e.stopPropagation();
      const span = g.end - g.start;
      if (origEnd - origStart >= span) return null;
      const r = bar.getBoundingClientRect();
      const touch = e.pointerType !== 'mouse';
      // Thirds for a finger, a 10px edge for a mouse, and below ~36px no third
      // is worth aiming at so the whole thing moves — the block bar's rule,
      // and an event box is more often the small one. (On the box itself the
      // same edges resize: they are the edges of the event either way.)
      const mode = touch
        ? (r.height < 36 ? 'move'
          : e.clientY - r.top < r.height / 3 ? 'start'
          : r.bottom - e.clientY < r.height / 3 ? 'end' : 'move')
        : ((e.clientY - r.top < 10) ? 'start' : (r.bottom - e.clientY < 10) ? 'end' : 'move');
      const startY = e.clientY;
      const bodyPx = g.px();
      let moved = false;
      let curS = origStart, curE = origEnd;
      // A finger has already committed by holding still, so it does not also
      // have to clear the mouse's 5px slop.
      const slop = touch ? 0 : 5;

      function onMove(clientY) {
        if (!moved && Math.abs(clientY - startY) < slop) return;
        moved = true;
        // A drag is not a tap: swallow the click this press would otherwise
        // send to the box, which opens the occasion sheet.
        el.dataset.lpDragged = '1';
        const deltaMin = Math.round(((clientY - startY) / bodyPx) * span / 5) * 5;
        if (mode === 'move') {
          const len = origEnd - origStart;
          curS = Math.min(Math.max(g.start, origStart + deltaMin), g.end - len);
          curE = curS + len;
        } else if (mode === 'start') {
          curS = Math.min(Math.max(g.start, origStart + deltaMin), origEnd - 15);
        } else {
          curE = Math.max(Math.min(g.end, origEnd + deltaMin), origStart + 15);
        }
        g.place(el, curS, curE);
      }

      async function onUp() {
        document.body.style.cursor = '';
        // A PRESS THAT NEVER MOVED IS A TAP, and re-rendering here would eat
        // it: the layer is rebuilt, the element the click is about to land on
        // stops existing, and the occasion sheet never opens. (The gate pill
        // hit the same wall from the other side — see qrDragEndedAt.) Nothing
        // moved on screen either, so there is nothing to repaint.
        if (!moved) return;
        // A real drag that ended where it started still has inline top/height
        // from the move, so that one does repaint.
        if (curS === origStart && curE === origEnd) { g.repaint(); return; }
        await moveEvent(el.dataset.evUid, el.dataset.evStart, el.dataset.evLabel,
                        dateStr, curS, curE);
      }

      document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ns-resize';
      return { move: onMove, end: onUp };
    } });
  });
}

// Semantic minutes back into the app's one datetime shape — naive local
// `YYYY-MM-DDTHH:MM:SS`, the string the feed itself stores. Past DAY_MIN means
// tomorrow, which is how this view already talks about a night that runs over,
// so the DATE is walked forward rather than the clock being wrapped by hand.
function isoAtMinute(dateStr, min) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setMinutes(d.getMinutes() + min);
  return `${formatDateYMD(d)}T${clockHHMM(min)}:00`;
}

async function moveEvent(uid, start, label, dateStr, curS, curE) {
  const res = await apiSend('/api/gcal/moves', 'POST', {
    uid, start,
    new_start: isoAtMinute(dateStr, curS),
    new_end: isoAtMinute(dateStr, curE),
  });
  if (!res || !res.ok) { toast('Could not move it'); renderTimeline(); return; }
  pushUndo(`moved "${label || 'event'}"`, async () => {
    await apiSend('/api/gcal/moves', 'DELETE', { uid, start }).catch(() => {});
    await refreshGcalEvents();
  });
  await refreshGcalEvents();
}

async function unmoveEvent(uid, start) {
  const res = await apiSend('/api/gcal/moves', 'DELETE', { uid, start });
  if (!res || !res.ok) { toast('Could not put it back'); return; }
  toast('Back where the calendar has it');
  await refreshGcalEvents();
}

// The events payload is the SERVER's resolution of where things sit, moves
// applied, so both surfaces that draw events re-read it rather than patching a
// local copy into agreement.
async function refreshGcalEvents() {
  state.gcalEvents = await fetch('/api/gcal').then(r => r.json())
    .catch(() => state.gcalEvents);
  renderTimeline();
  renderEngage();
}

function updateCurrentTimeLine() {
  const el = document.getElementById('tl-current-time');
  if (!el) return;
  if (!isToday(state.currentDate)) {
    el.style.display = 'none';
    return;
  }
  const now = new Date();
  const pct = minutesToViewPercent(now.getHours() * 60 + now.getMinutes());
  if (pct < 0 || pct > 100) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  el.style.top = `${pct}%`;
}

function updateFetchStatus() {
  const el = document.getElementById('fetch-status');
  if (!el) return;
  if (fetchFailed) {
    el.textContent = 'Last fetch failed — check your calendar URLs in Blocks → Calendars';
    el.classList.add('fetch-failed');
    return;
  }
  // NOTHING WHEN IT IS WORKING (2026-08-22, asked for). "Last fetched: 3 min
  // ago" was a permanent column in a header that has to fit on a phone, and it
  // answered a question nobody asks while the answer is fine. The FAILURE
  // stays: that one is the difference between a quiet day and a calendar that
  // has silently stopped updating, and it is the only thing here that a
  // missing row could otherwise be mistaken for.
  el.classList.remove('fetch-failed');
  el.textContent = '';
}

function startCurrentTimeTick() {
  if (currentTimeTick) clearInterval(currentTimeTick);
  currentTimeTick = setInterval(() => {
    updateCurrentTimeLine();
    if (calWeek.on) moveWeekNowLine();
  }, 60000);
}

async function refreshExternal() {
  fetchFailed = false;
  const todayStr = wallDay();
  const [gcalResult, sheetsResult, outcomesResult] = await Promise.allSettled([
    apiSend('/api/gcal/refresh', 'POST').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    apiSend('/api/sheets/refresh', 'POST').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch(`/api/accountability/outcomes?from=${localDatePlusDays(todayStr, -4)}&to=${todayStr}`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
  ]);
  if (gcalResult.status === 'fulfilled') {
    state.gcalEvents = gcalResult.value.events;
    // A calendar Google refused keeps its last copy — say which, or a deleted
    // event that stays reads as a refresh that does nothing.
    const failed = gcalResult.value.failed || [];
    if (failed.length) {
      toast(`Not refreshed: ${failed.map(f => f.name).join(', ')}${
        failed.some(f => /429/.test(f.error)) ? ' — Google is rate-limiting, try again in a few minutes' : ''}`);
    }
  } else fetchFailed = true;
  // The sheet refresh SEEDS and RETRACTS real pool items now rather than
  // returning a strip to paint, so there is nothing to read off the response —
  // refreshEngage() below re-reads /api/inbox/active, which is where seeded
  // rows live (they are created ACTIVE, so they never touch the clarify
  // queue). It is deliberately NOT counted into fetchFailed: the feed is
  // config-gated and an unconfigured one 400s on every tick, which is not the
  // same statement as being offline and must not raise the stale banner.
  if (sheetsResult.status === 'rejected') console.warn('sheets refresh:', sheetsResult.reason);
  if (outcomesResult.status === 'fulfilled' && Array.isArray(outcomesResult.value)) {
    state.qrOutcomes = {};
    outcomesResult.value.forEach(o => { state.qrOutcomes[`${o.node_id}:${o.date}`] = o.outcome; });
  }
  if (!fetchFailed) localStorage.setItem('lastExternalRefresh', Date.now().toString());
  state.lastFetched = new Date();
  renderTimeline();
  refreshEngage();
}

function initTimeline() {
  document.getElementById('tl-nav').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.id === 'nav-prev') {
      if (dayOffset(state.currentDate) <= navBounds().min) return;
      state.currentDate = new Date(state.currentDate.getTime() - 86400000);
    } else if (b.id === 'nav-next') {
      if (dayOffset(state.currentDate) >= navBounds().max) return;
      state.currentDate = new Date(state.currentDate.getTime() + 86400000);
    } else if (b.id === 'nav-today') {
      state.currentDate = new Date();
    } else return;
    state.gateSel = null;   // a selection is about ONE day
    await fetchOverridesForDate(state.currentDate);
    renderTimeline();
  });
  document.getElementById('refresh-btn').addEventListener('click', refreshCalendar);
  document.getElementById('tl-add-event').addEventListener('click', openEvSheet);
  // The mode's own switch. It is visible while it is on — the banner, the
  // pressed button and the track's cursor — which is the whole difference
  // between this and the edit mode that was removed.
  document.getElementById('tl-plan-mode').addEventListener('click', async () => {
    state.planMode = !state.planMode;
    // Re-read on the way IN. The plan travels with the day, but the
    // requirement comes from the hours gate and the first fetch can happen
    // before the gates themselves have loaded — in which case the banner had
    // the spans and no number to weigh them against, which is the one thing
    // the banner is for.
    if (state.planMode) await refreshPlan(viewDay());
    renderTimeline();
  });

  // Tap the day off a selected gate. The squares and the lines stop their own
  // clicks, so anything reaching the body is "somewhere else".
  document.getElementById('tl-body').addEventListener('click', e => {
    if (e.target.closest('.tl-qr-line, .tl-gate-line')) return;
    clearGateSel();
  });

  // Ctrl+Z is global (see the undo core). Timeline dismissals register on the
  // same stack, so one keystroke walks back through everything in order.

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    focusRefresh();
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const lastRefresh = parseInt(localStorage.getItem('lastExternalRefresh') || '0');
    if (Date.now() - lastRefresh > SIX_HOURS) refreshExternal();
  });
  window.addEventListener('focus', focusRefresh);
  initCalWeek();
}

// The VIEWED day's two halves, fetched together because they are two answers
// to one question. `viewSegments` is the server's resolved block list for that
// exact date (storage.block_segments_for): which blocks run, at what times,
// with a change dated forward already applied. The client used to answer that
// itself by filtering state.blocks on the weekday — which is fine until a
// block is scheduled to MOVE, at which point the timeline for next Wednesday
// draws this Wednesday's rules and quietly corrects itself later.
//
// Keyed by EXACT DATE and carrying it, like every other resolved-day payload,
// and deliberately NOT the same store as todaySegments — that one answers a
// question about NOW and must not be served from a viewed-day cache.
async function fetchOverridesForDate(date) {
  const dateStr = formatDateYMD(date);
  const [overrides, segments, gates] = await Promise.all([
    apiGet(`/api/overrides?date=${dateStr}`, state.overrides),
    apiGet(`/api/blocks/day?date=${dateStr}&all=1`, []),
    apiGet(`/api/gates/day?date=${dateStr}`, null),
  ]);
  state.overrides = overrides;
  state.viewSegments = { date: dateStr, segments };
  setViewGates(dateStr, gates);
  if (calPin.cat) paintCalPin();
  // The plan is VIEWED-DAY data and travels with the day, so it can never be
  // one date behind what is drawn. renderPlanLayer still checks the date it
  // came back keyed with rather than trusting it — the guard viewSegmentsFor
  // makes, for the same reason.
  await refreshPlan(dateStr);
}

// THE VIEWED DAY'S GATES, as /api/gates/day serves them (2026-09-29) — the
// dashboard's composition of the judge's own resolution: the window with any
// override and pawn applied, called off or not, the verdict, and whether the
// gate is paused. The timeline used to assemble this itself from day_windows
// plus today_override plus a drag cache, and day_windows leaves a PAUSED gate
// out entirely, so a paused Wake QR vanished from the day. Keyed by the date it
// answers for, like viewSegments, and read only through viewGatesFor.
function setViewGates(dateStr, payload) {
  if (payload && payload.date === dateStr && Array.isArray(payload.gates)) {
    state.viewGates = { date: dateStr, gates: payload.gates };
  } else if (!state.viewGates || state.viewGates.date !== dateStr) {
    state.viewGates = { date: dateStr, gates: [] };
  }
}

function viewGatesFor(dateStr) {
  return state.viewGates && state.viewGates.date === dateStr ? state.viewGates.gates : [];
}

// The segments for the day being looked at, or nothing if the cache holds
// another day — a stale answer keyed by the wrong date is the bug this shape
// exists to prevent, so it reports empty rather than guessing.
function viewSegmentsFor(dateStr) {
  return state.viewSegments && state.viewSegments.date === dateStr
    ? state.viewSegments.segments : [];
}

// A CANCELLED BLOCK IS DRAWN ONLY WHERE NOTHING LIVE STANDS ON IT (2026-10-04,
// Quentin: the one-offs must not intersect the weeklys). Cancelling a weekly
// stretch to make room for a block for one date is the common case, and
// drawing both crossed two hatches over the same hours. The cancellation is
// still served and still true; where a live block covers it, it is simply not
// drawn, and any uncovered rest still is, struck through, with its door back.
function drawnSegments(segs) {
  const live = segs.filter(s => !s.cancelled);
  const out = [];
  segs.forEach(s => {
    if (!s.cancelled) { out.push(s); return; }
    let pieces = [[s.start, s.end]];
    live.forEach(l => {
      pieces = pieces.flatMap(([a, b]) => (l.end <= a || l.start >= b) ? [[a, b]]
        : [[a, Math.min(b, l.start)], [Math.max(a, l.end), b]].filter(([x, y]) => y - x >= 5));
    });
    pieces.forEach(([a, b]) => out.push({ ...s, start: a, end: b }));
  });
  return out;
}

// One segment as the renderers want it: the day question is the SERVER's, the
// cosmetic join (which location is that id) stays here.
function segmentRow(s) {
  const cont = s.start < 0;                       // yesterday's overnight tail
  const loc = (state.locations || []).find(l => String(l.id) === String(s.location_id));
  return {
    b: { id: s.block_id, area_id: s.area_id, domain_id: s.domain_id, color: s.color,
         location_id: s.location_id, location_name: loc ? loc.name : null },
    startMin: cont ? 0 : s.start,
    endMin: s.end,
    cancelled: !!s.cancelled,
    label: s.label + (cont ? ' (cont.)' : ''),
    name: s.label,
    cat: blockCatKey(s.label),
    description: s.description || '',
    dayBlockId: s.day_block_id || null,
    cont,
  };
}

// WHICH HALF A DRAWN BLOCK BELONGS TO (2026-10-03, Quentin's instruction: a
// global change and a local one must never mix). A WEEKLY block is
// `block:<id>` and carries data-block-id — overrides, hides, the category pin
// and the Block Editor all key off it. A block for ONE DATE is `dayblock:<id>`
// and carries data-day-block-id INSTEAD, so nothing weekly can match it and
// every verb it offers edits that date's row and nothing else.
function blockObjAttrs(s) {
  return s.dayBlockId
    ? `data-obj="dayblock:${s.dayBlockId}" data-day-block-id="${s.dayBlockId}"`
    : `data-obj="block:${s.b.id}" data-block-id="${s.b.id}"`;
}

// WHAT A STRETCH OF A BLOCK IS FOR (2026-09-30, Quentin's instruction: "see
// the purpose of each of these regions in the calendar upon hovering"). A week
// is built of short regions of one course — COS333's assignment time, then its
// class, then more assignment time — and each region is its own block row
// whose DESCRIPTION says what it is for. The calendar draws blocks unlabelled,
// so the purpose rides the hover tooltip, and — a finger has no hover — heads
// the menu a tap on the block opens (`purposeItem`).
function blockPurpose(s) {
  const when = `${hhmmToAmPm(clockHHMM(s.startMin))}–${hhmmToAmPm(clockHHMM(s.endMin))}`;
  return [s.label, s.description, when].filter(Boolean).join(' · ');
}

// The same words as a menu's first line: read, never chosen.
function purposeItem(blockEl) {
  return blockEl && blockEl.dataset.purpose ? [{ info: true, label: blockEl.dataset.purpose }] : [];
}

// ── A CATEGORY, LIT UP (2026-09-30, Quentin's "Calendar Block Hover" design,
// 6b: "hover over and click … all COS330 regions light up") ────────────────
//
// Hovering a block puts a one-line label at its top — its category and what
// this stretch is for (removed 2026-10-05 by mistake, restored the same day
// on Quentin's word). CLICKING it lights up every block of that category on
// the calendar and fades the rest, and a bar over the grid says what it is,
// how much of the week goes to it, and holds the two doors a click used to
// be: `Edit` (the category's sheet) and `⋯` (this stretch's menu). Clicking
// the same stretch again, ✕, Esc or closing the calendar puts it out.
//
// The label replaced the block's native tooltip, which only repeated it. A
// finger has no hover, so on a phone the TAP is the read: the bar names the
// stretch it was tapped on, and tapping another stretch of the same category
// moves the reading there without putting the light out.
//
// The light is ONE generated rule, keyed on `data-cat`, so a repaint of
// either view is lit the moment it lands without any renderer knowing a pin
// exists. The stats are the SERVED segments summed — the same rows the
// columns draw — never the weekly rule re-expanded.
const calPin = { cat: null, name: '', color: '', blockId: null, date: null, what: '' };

function blockCatAttrs(s) {
  const when = `${hhmmToAmPm(clockHHMM(s.startMin))}–${hhmmToAmPm(clockHHMM(s.endMin))}`;
  return `data-cat="${escHtml(s.cat)}" data-name="${escHtml(s.name)}"
    data-what="${escHtml([s.description, when].filter(Boolean).join(' · '))}"`;
}

function paintCalPin() {
  let style = document.getElementById('cal-pin-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'cal-pin-style';
    document.head.appendChild(style);
  }
  if (!calPin.cat) {
    style.textContent = '';
    return;
  }
  const k = CSS.escape(calPin.cat);
  style.textContent = `#cal-overlay .tl-block[data-cat]:not([data-cat="${k}"]) { opacity: 0.3; }
#cal-overlay .tl-block[data-cat="${k}"] { --wk-hatch: var(--wk-hatch-on);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--block-color) 60%, transparent); }`;
}

function clearCalPin() {
  if (!calPin.cat) return false;
  calPin.cat = null;
  paintCalPin();
  hideBlockHover();
  return true;
}

function toggleCalPin(el) {
  const same = calPin.cat === el.dataset.cat && calPin.blockId === el.dataset.blockId
    && calPin.date === (el.dataset.date || null);
  if (same) { clearCalPin(); return; }
  Object.assign(calPin, {
    cat: el.dataset.cat, name: el.dataset.name, what: el.dataset.what || '',
    color: el.style.getPropertyValue('--block-color'),
    blockId: el.dataset.blockId, date: el.dataset.date || null,
  });
  paintCalPin();
}

function hideBlockHover() {
  const tip = document.getElementById('blk-hover');
  if (tip) tip.classList.add('hidden');
}

function showBlockHover(el) {
  let tip = document.getElementById('blk-hover');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'blk-hover';
    document.body.appendChild(tip);
  }
  const r = el.getBoundingClientRect();
  // A tall block (the night) starts above the scrolled view; its label sits
  // at the top of what is visible of it instead.
  const sc = el.closest('.wk-scroll, #right-panel');
  const floor = sc ? sc.getBoundingClientRect().top : 0;
  tip.innerHTML = `<span class="cal-pin-sw" style="--block-color:${
    escHtml(el.style.getPropertyValue('--block-color'))}"></span><b>${escHtml(el.dataset.name || '')}</b><span>${
    escHtml(el.dataset.what || '')}</span>`;
  tip.style.left = `${r.left + 12}px`;
  tip.style.top = `${Math.max(r.top, floor) + 3}px`;
  // Wider than a narrow column when it has to be: it floats over the grid.
  tip.style.maxWidth = `${Math.max(280, r.width - 16)}px`;
  tip.classList.remove('hidden');
}

function initCalBlockPin() {
  const cal = document.getElementById('cal-overlay');
  cal.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest('.tl-block[data-cat]');
    if (el && !e.target.closest('.tl-gcal-event, .wk-gate')) showBlockHover(el);
    else hideBlockHover();
  });
  cal.addEventListener('pointerleave', hideBlockHover);
  cal.addEventListener('pointerdown', hideBlockHover);
  document.addEventListener('scroll', hideBlockHover, true);

  cal.addEventListener('click', e => {
    const el = e.target.closest('.tl-block[data-cat]');
    if (!el) return;
    // A modified click is somebody else's gesture; a click trailing a drag or
    // a long press is not a tap (the initObjectDoors rules).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (justPointerDragged() || justLongPressed()) return;
    e.stopPropagation();
    toggleCalPin(el);
    // A CLICK HIGHLIGHTS AND NAMES (2026-10-05). The label is the one the
    // hover shows, kept up for the stretch that was clicked — on a phone, with
    // no hover, this is how a block is read. On the WEEK the click also opens
    // the block's task card (2026-10-08, "Calendar Tasks" 7a, which reverses
    // "not the popup with items"), and the card names it instead.
    if (calPin.cat && calWeek.pop !== 'tasks') showBlockHover(el); else hideBlockHover();
  });
  // The block's menu (its day verbs and Edit) moved to a DOUBLE-click: on a
  // calendar whose right-click removes, it is the remaining door to them.
  cal.addEventListener('dblclick', e => {
    const el = e.target.closest('.tl-block[data-cat]');
    if (!el || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.stopPropagation();
    if (!calPin.cat) toggleCalPin(el);
    hideBlockHover();
    const [kind, id] = (el.dataset.obj || '').split(':');
    if (kind && id) openObjectMenu(e.clientX, e.clientY + 4, kind, id, verbsFor(kind, id, el));
  });

}

// ── TASKS ON A BLOCK OR AN EVENT (2026-10-08, Quentin's design "Calendar
// Tasks", 7a) ─────────────────────────────────────────────────────────────
// A task is ON an occurrence when it is placed at that occurrence's start on
// that day — what clarify's Calendar flow writes (one block, that day; never
// every block of its kind, Quentin's call). The week counts the open ones on
// each event and block, and a click opens a card BESIDE the item — the week's
// own .wk-pop, positioned at the column, so nothing else on the page moves —
// listing them with a box to finish each and a field to add another. The
// tasks are the SERVER's read (/api/calendar/tasks), cached per week with the
// days. Its foot keeps the doors the click used to be: an event's read-out,
// a block's menu (also still on double-click).
function wkTasksAt(date, minute) {
  return (calWeek.tasks || []).filter(t => t.date === date && Math.round(t.minute) === Math.round(minute));
}

function wkTaskCount(date, minute, cont) {
  if (cont) return '';
  const n = wkTasksAt(date, minute).length;
  return n ? `<span class="count wk-task-n" title="${n} task${n === 1 ? '' : 's'} here">✓${n}</span>` : '';
}

async function refreshCalTasks(start) {
  const wk = start || calWeek.start;
  const dates = weekDates();
  const rows = await apiGet(`/api/calendar/tasks?from=${dates[0]}&to=${dates[6]}`, null);
  if (calWeek.start !== wk) return;   // paged on while this was out
  if (Array.isArray(rows)) calWeek.tasks = rows;
  renderCalWeek();
}

// The occurrence a week element stands for: its date, its own start (not the
// clipped top it is drawn from), a name, its span, and a key to toggle by.
function wkOccOf(el) {
  if (el.classList.contains('wk-ev')) {
    const ev = state.gcalEvents.find(x => eventKey(x) === el.dataset.evKey);
    if (!ev) return null;
    return { key: `e:${el.dataset.evKey}`, evKey: el.dataset.evKey, isBlock: false,
             date: formatDateYMD(new Date(ev.start)), minute: isoMin(ev.start), name: ev.summary || 'Event',
             span: `${isoToAmPm(ev.start)}–${isoToAmPm(ev.end)}` };
  }
  const minute = parseInt(el.dataset.occMin);
  if (Number.isNaN(minute)) return null;
  const label = el.querySelector('.tl-block-label');
  return { key: `b:${el.dataset.obj}:${el.dataset.date}:${minute}`, obj: el.dataset.obj, isBlock: true,
           date: el.dataset.date, minute, name: (label && label.textContent.trim()) || el.dataset.name || 'Block',
           span: `${hhmmToAmPm(clockHHMM(minute))}–${hhmmToAmPm(clockHHMM(parseInt(el.dataset.endMin)))}` };
}

function wkTaskPopHtml() {
  const t = calWeek.pop === 'tasks' && calWeek.taskPop;
  if (!t) return '';
  // Read while the old card is still in the page: a field being typed in is
  // handed its focus back once the week has been redrawn.
  const a = document.activeElement;
  t.focus = !!(a && a.matches && a.matches('.wk-task-add'));
  const day = new Date(t.date + 'T12:00:00');
  const tasks = wkTasksAt(t.date, t.minute);
  return `<div class="wk-pop wk-task-pop" style="left:${t.x}px;top:${t.y}px">
    <div class="wk-pop-head"><span>${escHtml(t.name)}</span>
      <button class="wk-icon" data-task-close title="Close">${WK_SVG.close}</button></div>
    <div class="wk-pop-note">${weekdayOf(day).name} ${day.getDate()} · ${escHtml(t.span)}</div>
    <div class="ref-list">${tasks.map(x => `<div class="ref-row ref-item">
        <span class="eg-check" data-task-done="${x.id}" title="Done"></span>
        <span class="ref-text">${escHtml(x.content)}</span></div>`).join('')}
      <input type="text" class="wk-task-add" placeholder="Add a task" value="${escHtml(t.draft || '')}"></div>
    <div class="wk-pop-foot"><span></span>
      <button class="wk-link" data-task-more>${t.isBlock ? 'Block menu…' : 'Event details ›'}</button></div>
  </div>`;
}

// The week's click, first: an event or a block opens (or, again, closes) its
// card; inside the card, its own controls. Returns whether it took the click.
async function wkTaskClick(e) {
  if (!calWeek.on) return false;
  if (e.target.closest('.wk-task-pop')) {
    const done = e.target.closest('[data-task-done]');
    if (done) await wkTaskDone(parseInt(done.dataset.taskDone));
    else if (e.target.closest('[data-task-close]')) { calWeek.pop = null; calWeek.taskPop = null; renderCalWeek(); }
    else if (e.target.closest('[data-task-more]')) wkTaskMore(e);
    return true;
  }
  const el = e.target.closest('.wk-block[data-cat], .wk-ev');
  if (!el || el.classList.contains('tl-block-cont')) return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if (justPointerDragged() || justLongPressed()) return false;
  const occ = wkOccOf(el);
  if (!occ) return false;
  const cur = calWeek.pop === 'tasks' && calWeek.taskPop;
  if (cur && cur.key === occ.key) {
    calWeek.pop = null; calWeek.taskPop = null;
    renderCalWeek();
    return true;
  }
  // Beside the column, on the side with room, level with the click.
  const colEl = el.closest('.wk-col');
  const col = colEl.getBoundingClientRect();
  const i = weekDates().indexOf(colEl.dataset.date);
  const W = 260;
  const x = i >= 4 || col.right + 6 + W > window.innerWidth ? Math.max(8, col.left - W - 6) : col.right + 6;
  const y = Math.max(56, Math.min(e.clientY - 24, window.innerHeight - 320));
  calWeek.pop = 'tasks';
  calWeek.taskPop = { ...occ, x, y, draft: '', focus: false };
  renderCalWeek();
  return true;
}

async function wkTaskDone(id) {
  const t = (calWeek.tasks || []).find(x => x.id === id);
  calWeek.tasks = (calWeek.tasks || []).filter(x => x.id !== id);
  renderCalWeek();
  await undoableDelete(id, `completed "${(t && t.content) || 'task'}"`);
  await refreshCalTasks();
}

// A task added here is an ordinary action, placed where the card is — the
// same three writes clarify's Calendar flow makes, and one undo for them.
async function wkTaskAdd(text) {
  const t = calWeek.taskPop;
  const content = text.trim();
  if (!t || !content) return;
  const created = await apiSend('/api/inbox', 'POST', { content }).then(r => r.json());
  await apiSend(`/api/inbox/${created.id}`, 'PATCH', { status: 'active', defer_until: t.date });
  await apiSend('/api/engage/placements', 'POST', { item_id: created.id, date: t.date, minute: t.minute });
  pushUndo(`added "${content}" to ${t.name}`, async () => {
    await apiSend(`/api/inbox/${created.id}`, 'DELETE');
    await refreshAfterUndo();
  });
  t.draft = '';
  await refreshCalTasks();
}

function wkTaskMore(e) {
  const t = calWeek.taskPop;
  calWeek.pop = null;
  calWeek.taskPop = null;
  renderCalWeek();
  const host = document.getElementById('cal-week');
  if (t.isBlock) {
    const el = host.querySelector(`.wk-block[data-obj="${CSS.escape(t.obj)}"][data-date="${t.date}"]`);
    const [kind, id] = t.obj.split(':');
    if (el) openObjectMenu(e.clientX, e.clientY + 4, kind, id, verbsFor(kind, id, el));
  } else {
    const el = host.querySelector(`.wk-ev[data-ev-key="${CSS.escape(t.evKey)}"]`);
    openEventPop(t.evKey, el);
  }
}

// The field's half-typed text survives a repaint (the week re-renders whole),
// and Enter adds — delegated, since the card is drawn fresh each time.
document.addEventListener('input', e => {
  if (e.target.matches && e.target.matches('.wk-task-add') && calWeek.taskPop) calWeek.taskPop.draft = e.target.value;
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !(e.target.matches && e.target.matches('.wk-task-add'))) return;
  e.preventDefault();
  e.stopPropagation();
  wkTaskAdd(e.target.value);
}, true);

// ── THE WEEK (2026-09-29, Quentin's "Calendar Week" design) ──────────────
//
// On a computer screen the Calendar can lay seven days side by side. It is a
// READING of the week: each day's blocks and gates are the SERVER's answer for
// that exact date — block_segments_for, and /api/gates/day, the dashboard's
// own composition of the judge's resolution — fetched per date and cached
// under it. Nothing here decides which blocks run on a Thursday or when a gate
// closes, and nothing here moves one: the drags stay on the day view and a
// gate's day stays on /gates. A day's header is the door into that day.
//
// WIDE SCREENS ONLY, AND THE DEFAULT THERE (2026-09-29, Quentin's report: the
// laptop kept opening the phone's day column). The Calendar follows the window:
// the week wherever seven columns fit, the day where they do not, re-decided
// as the window is resized. Pressing Day or Week is a preference for the rest
// of the session (`pref`); the width still wins, so a phone never gets a week.
// 800px is where the grid still fits (the design's 760 + margin) — the same
// number is in style.css's @media, which cannot read this one.
const WEEK_MQ = window.matchMedia('(min-width: 800px)');
const WK_HOUR_PX = 46;
// `days` is keyed by exact date; `pop` is the one popover open ('range' or
// 'legend'); `focus` the gate the range panel was opened from; `objDate` the
// date of the gate last pressed, so its menu's "Open in Gates…" lands on it.
const calWeek = { on: false, start: null, days: {}, pop: null, focus: null,
                  focusDate: null, objDate: null, scrollKey: null, pref: null };

function calWeekAvailable() { return WEEK_MQ.matches; }

// What the Calendar shows when nothing more specific was asked: the week,
// unless Day was picked this session. calWeekAvailable still has the last word.
function calWantsWeek() { return calWeek.pref !== 'day'; }

function weekStartOf(ymd) {
  return localDatePlusDays(ymd, -jsDateToDayOfWeek(new Date(ymd + 'T12:00:00')));
}

function weekDates() {
  return [0, 1, 2, 3, 4, 5, 6].map(i => localDatePlusDays(calWeek.start, i));
}

async function setCalView(week) {
  const on = !!week && calWeekAvailable();
  const was = calWeek.on;
  calWeek.on = on;
  calWeek.pop = null;
  document.getElementById('cal-overlay').classList.toggle('cal-wk', on);
  calFilter.render();
  if (on) {
    // Both are DAY-view states, and neither has a meaning across seven days.
    state.planMode = false;
    state.gateSel = null;
    await refreshCalWeek();
  } else if (was) {
    // The week may have paged the viewed date; the day view's own payloads are
    // keyed by it, so they are re-read for wherever it landed. Painted FIRST
    // with the new date (the keyed caches answer empty for it rather than
    // showing the old day), then again once its data is in.
    renderTimeline();
    await fetchOverridesForDate(state.currentDate);
    renderTimeline();
  }
}

async function refreshCalWeek() {
  const start = weekStartOf(viewDay());
  calWeek.start = start;
  renderCalWeek();
  const dates = weekDates();
  // Two halves, each painted the moment it lands: the blocks come back fast,
  // the gates' day (the judge's whole read-out, per gate) takes longer, and a
  // week held blank until the slower half arrived read as an empty week. A
  // failed read keeps what the day already had.
  const fill = (field, pick) => results => {
    if (calWeek.start !== start) return;   // paged on while these were out
    dates.forEach((d, i) => {
      const day = calWeek.days[d] || (calWeek.days[d] = { segments: [], gates: [] });
      const v = pick(results[i], d);
      if (v) day[field] = v;
    });
    renderCalWeek();
  };
  await Promise.all([
    // ?all=1 keeps a cancelled block, struck through, so "Restore for this
    // day" has something to be opened from — the day view's rule.
    Promise.all(dates.map(d => apiGet(`/api/blocks/day?date=${d}&all=1`, null)))
      .then(fill('segments', r => (Array.isArray(r) ? r : null))),
    // The day's override rows: what a block drop's undo restores.
    Promise.all(dates.map(d => apiGet(`/api/overrides?date=${d}`, null)))
      .then(fill('overrides', r => (Array.isArray(r) ? r : null))),
    Promise.all(dates.map(d => apiGet(`/api/gates/day?date=${d}`, null)))
      .then(fill('gates', (r, d) => (r && r.date === d && Array.isArray(r.gates) ? r.gates : null))),
    refreshCalTasks(start),
  ]);
  // A lit-up category's count is of these segments, so it is re-counted.
  if (calPin.cat) paintCalPin();
}

// The gates drawn on a day: running, called off (a called-off day still draws
// — the mark is the answer), or PAUSED, drawn muted: a paused gate is not
// judged, and hiding it made the week look as if it had no gates at all.
function wkDayGatesFrom(list) {
  return (list || []).filter(g =>
    (g.applies || g.skipped) && g.window && g.window.end_min != null);
}

function wkDayGates(d) {
  return wkDayGatesFrom((calWeek.days[d] || {}).gates);
}

// The mark itself, one drawing for both calendars: a sun for the wake gate, a
// moon for the sleep gate, a dot for every other.
function wkGateMark(nodeId) {
  const role = wkRole(nodeId);
  return role === 'wake' ? WK_SVG.sun : role === 'sleep' ? WK_SVG.moon
    : '<span class="wk-gate-dot"></span>';
}

// Met / missed / still to do / called off — the app's one gate vocabulary,
// read off the served verdict. A closed day's verdict is the judge's (a frozen
// row decides its own day); an open one has none yet.
// MET THE MOMENT IT IS MET (2026-09-30, Quentin's instruction: "when I
// satisfy a gate my calendar gate color changes immediately"). The served
// verdict is the judge's own predicate asked of what has happened so far, so
// a scan inside the window — or the routine finished — is a pass before the
// window closes, and the mark says so then. Only MISSED waits for the close:
// until it, an unmet gate is still due.
function wkGateState(g) {
  if (!g.active) return 'paused';
  if (g.skipped || (g.verdict && g.verdict.off)) return 'off';
  if (g.verdict && g.verdict.passed) return 'met';
  if (!g.window.closed) return 'open';
  return 'missed';
}

function wkRole(nodeId) {
  const id = String(nodeId);
  if (String(state.settings.qr_wake_node_id || '') === id) return 'wake';
  if (String(state.settings.qr_sleep_node_id || '') === id) return 'sleep';
  return 'none';
}

// The hours shown: from the wake gate's earliest deadline this week to the
// sleep gate's latest, the two gates the day view is clipped by. Either one
// unset leaves that edge at the day's own.
function calWeekRange(dates) {
  const ends = role => dates.flatMap(d => wkDayGates(d)
    .filter(g => g.applies && wkRole(g.node_id) === role).map(g => g.window.end_min));
  const wakes = ends('wake'), sleeps = ends('sleep');
  const start = wakes.length ? Math.floor(Math.min(...wakes) / 60) * 60 : 0;
  let end = sleeps.length ? Math.ceil(Math.max(...sleeps) / 60) * 60 : DAY_MIN;
  if (end <= start) end += DAY_MIN;
  return { start, end };
}

function wkClock(min) {
  return min === DAY_MIN ? '24:00' : clockHHMM(min) + (min > DAY_MIN ? ' +1d' : '');
}

// Events drawn side by side where they overlap, rather than on top of each
// other: a cluster of overlapping events shares the column in lanes.
function wkLanes(boxes) {
  boxes.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], clusterEnd = -Infinity;
  const flush = () => {
    const n = Math.max(...cluster.map(b => b.lane)) + 1;
    cluster.forEach(b => { b.lanes = n; });
    cluster = [];
    clusterEnd = -Infinity;
  };
  for (const b of boxes) {
    if (cluster.length && b.s >= clusterEnd) flush();
    const used = cluster.filter(c => c.e > b.s).map(c => c.lane);
    let lane = 0;
    while (used.includes(lane)) lane++;
    b.lane = lane;
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.e);
  }
  if (cluster.length) flush();
  return boxes;
}

const WK_SVG = {
  sun: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
  moon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  info: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
};

function renderCalWeek() {
  const host = document.getElementById('cal-week');
  if (!host || !calWeek.on || !calWeek.start) return;
  const dates = weekDates();
  const { start, end } = calWeekRange(dates);
  const y = min => Math.round((min - start) / 60 * WK_HOUR_PX);
  const H = y(end);
  const today = wallDay();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const hours = [];
  for (let m = start; m <= end; m += 60) hours.push(m);
  const clip = (s, e) => [Math.max(s, start), Math.min(e, end)];

  const first = new Date(dates[0] + 'T12:00:00'), last = new Date(dates[6] + 'T12:00:00');
  const title = first.getMonth() === last.getMonth()
    ? `${_MONTHS_SHORT[first.getMonth()]} ${first.getDate()}–${last.getDate()}`
    : `${_MONTHS_SHORT[first.getMonth()]} ${first.getDate()} – ${_MONTHS_SHORT[last.getMonth()]} ${last.getDate()}`;
  const rangeLabel = `${wkClock(start)}–${wkClock(end)}`;

  const legendBlocks = new Map();

  const heads = dates.map((d, i) => {
    const on = d === today;
    return `<button class="wk-day${on ? ' wk-today' : ''}" data-wk="day" data-date="${d}">
      <span class="wk-dow">${WEEKDAYS[i].name.toUpperCase()}</span>
      <span class="wk-num">${new Date(d + 'T12:00:00').getDate()}</span></button>`;
  }).join('');

  const alldayByDay = dates.map(d => {
    const dt = new Date(d + 'T12:00:00');
    return state.gcalEvents.filter(e =>
      e.allday && sameDay(dt, e.start) && calShowsEvent(e));
  });
  const hasAllday = alldayByDay.some(list => list.length);
  const alldayRow = alldayByDay.map(list => `<div class="wk-allday-cell">${list.map(e =>
    `<div class="wk-allday" data-wk="event" data-ev-key="${escHtml(eventKey(e))}"
      style="--ev-color:${e.color || '#888888'}">${
      escHtml(e.summary || '')}</div>`).join('')}</div>`);

  const cols = dates.map(d => {
    const dt = new Date(d + 'T12:00:00');
    const next = new Date(localDatePlusDays(d, 1) + 'T12:00:00');
    const day = calWeek.days[d] || { segments: [], gates: [] };

    // The DAY VIEW'S OWN block element (tl-block + its bar), so the day's drag,
    // menu and styles are this column's too — one element, two surfaces.
    const blocks = drawnSegments(day.segments).map(segmentRow)
      .filter(s => !state.tlHidden.block[`${s.b.id}:${d}`])
      .map(s => {
        const [a, b] = clip(s.startMin, s.endMin);
        if (b <= a) return '';
        if (!s.cancelled) legendBlocks.set(s.label.replace(/ \(cont\.\)$/, ''), s.b.color);
        return `<div class="tl-block wk-block${s.cancelled ? ' tl-block-cancelled' : ''}${s.cont ? ' tl-block-cont' : ''}${s.dayBlockId ? ' tl-block-day' : ''}"
          ${blockObjAttrs(s)}
          data-date="${d}" data-start-min="${a}" data-end-min="${b}" data-occ-min="${s.startMin}"
          data-purpose="${escHtml(blockPurpose(s))}" ${blockCatAttrs(s)}
          style="top:${y(a)}px;height:${y(b) - y(a)}px;--block-color:${s.b.color}">
          <div class="tl-block-bar"></div><div class="tl-text"><span class="tl-block-label">${
            escHtml(s.label)}</span></div>${wkTaskCount(d, s.startMin, s.cont)}</div>`;
      }).join('');

    // Next-day events count when the week runs past midnight — the day view's
    // rule, for the same reason: the column IS that night.
    const boxes = state.gcalEvents.filter(e => !e.allday && calShowsEvent(e)
        && (sameDay(dt, e.start) || (end > DAY_MIN && sameDay(next, e.start))))
      .map(e => {
        const base = sameDay(next, e.start) ? DAY_MIN : 0;
        const s = base + isoMin(e.start);
        let en = base + isoMin(e.end);
        if (en <= s) en += DAY_MIN;
        const [a, b] = clip(s, en);
        return { ev: e, s: a, e: b };
      }).filter(x => x.e > x.s);
    const evs = wkLanes(boxes).map(x => {
      const e = x.ev;
      const top = y(x.s) + 1;
      const h = Math.max(14, y(x.e) - y(x.s) - 2);
      const w = 100 / x.lanes;
      const time = isoToAmPm(e.start);
      // The day view's own event element too, for the same reason.
      return `<div class="tl-gcal-event wk-ev${h < 30 ? ' tl-event-tight' : ''}${e.moved ? ' tl-event-moved' : ''}" data-wk="event"
        data-ev-key="${escHtml(eventKey(e))}" data-ev-label="${escHtml(e.summary || 'Event')}"
        data-ev-uid="${escHtml(e.uid)}" data-ev-start="${escHtml(e.orig_start || e.start)}"
        data-start-min="${x.s}" data-end-min="${x.e}"
        ${e.moved ? `title="${escHtml(`Moved here — the calendar still says ${isoToAmPm(e.orig_start)}. Right-click or long-press the bar to put it back.`)}"`
          : h < 30 ? `title="${escHtml(`${e.summary || 'Event'} · ${isoToAmPm(e.start)}–${isoToAmPm(e.end)}`)}"` : ''}
        style="top:${top}px;height:${h}px;left:calc(${x.lane * w}% + 1px);width:calc(${w}% - 2px);--ev-color:${e.color || '#888888'}">
        <div class="tl-ev-bar"></div><div class="tl-event-row"><span class="tl-event-summary">${
          escHtml(e.summary || '')}</span>${wkTaskCount(formatDateYMD(new Date(e.start)), isoMin(e.start))}${h >= 30 ? `<span class="tl-event-time">${escHtml(time)}</span>` : ''}</div></div>`;
    }).join('');

    const gates = wkDayGates(d).filter(g => g.window.end_min >= start && g.window.end_min <= end)
      .map(g => {
        const st = wkGateState(g);
        const role = wkRole(g.node_id);
        const mark = wkGateMark(g.node_id);
        const say = { open: 'due', met: 'met', missed: 'missed', off: 'called off',
                      paused: 'paused, not judged ·' }[st];
        return `<button class="wk-gate wk-gate-${st}${role !== 'none' ? ' wk-gate-role' : ''}"
          data-wk="gate" data-node="${g.node_id}" data-date="${d}" data-obj="gate:${g.node_id}"
          data-obj-date="${d}" title="${escHtml(`${g.label} · ${say} ${hhmmToAmPm(clockHHMM(g.window.end_min))}`)}"
          style="top:${y(g.window.end_min) - 7}px">${mark}</button>`;
      }).join('');

    const nowLine = d === today && nowMin >= start && nowMin <= end
      ? `<div class="wk-now" style="top:${y(nowMin)}px"></div>` : '';

    return `<div class="wk-col${d === today ? ' wk-col-today' : ''}" data-date="${d}" style="height:${H}px">
      ${hours.map(m => `<div class="wk-line" style="top:${y(m)}px"></div>`).join('')}
      ${blocks}<div class="wk-evs">${evs}</div>${gates}${nowLine}</div>`;
  }).join('');

  // ── the two popovers ──
  const roleRows = () => {
    const seen = new Map();
    dates.forEach(d => wkDayGates(d).forEach(g => {
      const r = seen.get(g.node_id) || { id: g.node_id, label: g.label, mins: [], n: 0 };
      r.mins.push(g.window.end_min);
      if (g.applies) r.n++;
      seen.set(g.node_id, r);
    }));
    // A gate assigned a role but not running this week still has to be
    // un-assignable from here, or the range would hang on something unseen.
    ['qr_wake_node_id', 'qr_sleep_node_id'].forEach(k => {
      const id = state.settings[k];
      const n = (state.accountabilityNodes || []).find(x => String(x.id) === String(id));
      if (n && !seen.has(n.id)) seen.set(n.id, { id: n.id, label: n.label, mins: [], n: 0 });
    });
    return [...seen.values()].map(r => {
      const lo = Math.min(...r.mins), hi = Math.max(...r.mins);
      const when = !r.mins.length ? 'not this week'
        : lo === hi ? hhmmToAmPm(clockHHMM(lo))
        : `${hhmmToAmPm(clockHHMM(lo))}–${hhmmToAmPm(clockHHMM(hi))}`;
      const cur = wkRole(r.id);
      const focused = String(calWeek.focus) === String(r.id);
      return `<div class="wk-role-row${focused ? ' wk-role-focus' : ''}">
        <div class="wk-role-name"><span>${escHtml(r.label)}</span>
          <span class="wk-role-meta">${r.n}× this week · ${escHtml(when)}${focused && calWeek.focusDate
            ? ` · <a href="#" data-wk="open-gate" data-node="${r.id}" data-date="${calWeek.focusDate}">Open in Gates ›</a>` : ''}</span></div>
        <div class="seg">${[['none', 'None'], ['wake', 'Wake'], ['sleep', 'Sleep']].map(([v, l]) =>
          `<button class="${cur === v ? 'on' : ''}" data-wk="role" data-node="${r.id}" data-role="${v}">${l}</button>`).join('')}</div>
      </div>`;
    }).join('') || '<div class="wk-role-meta">No gates run this week.</div>';
  };
  const hasRoles = !!(state.settings.qr_wake_node_id || state.settings.qr_sleep_node_id);
  const rangePop = calWeek.pop !== 'range' ? '' : `
    <div class="wk-pop wk-range-pop">
      <div class="wk-pop-head"><span>Wake &amp; sleep gates</span>
        <button class="wk-icon" data-wk="range" title="Close">${WK_SVG.close}</button></div>
      <div class="wk-pop-note">The calendar starts at your wake gate's earliest deadline and ends at
        your sleep gate's latest. With neither set, it shows all 24 hours. The day view is clipped by
        the same two gates.</div>
      <div class="wk-roles">${roleRows()}</div>
      <div class="wk-pop-foot"><span class="wk-mono">Showing ${rangeLabel}</span>
        ${hasRoles ? '<button class="wk-link" data-wk="clear-roles">Back to 24 hours</button>' : ''}</div>
    </div>`;
  const calRows = (state.calendars || []).filter(c => c.active !== 0).map(c =>
    `<span class="wk-leg"><span class="wk-leg-ev" style="--ev-color:${c.color || '#888888'}"></span>${escHtml(c.name || 'Calendar')}</span>`).join('');
  const legendPop = calWeek.pop !== 'legend' ? '' : `
    <div class="wk-pop wk-legend-pop">
      <div class="wk-leg-sec"><span class="wk-leg-h">Blocks</span>${[...legendBlocks].map(([n, c]) =>
        `<span class="wk-leg"><span class="wk-leg-block" style="--block-color:${c}"></span>${escHtml(n)}</span>`).join('')
        || '<span class="wk-leg">None this week</span>'}</div>
      <div class="wk-leg-sec"><span class="wk-leg-h">Events</span>${calRows || '<span class="wk-leg">No calendars</span>'}</div>
      <div class="wk-leg-sec"><span class="wk-leg-h">Gates</span>
        <span class="wk-leg"><span class="wk-leg-mark wk-gate-open"><span class="wk-gate-dot"></span></span>Due</span>
        <span class="wk-leg"><span class="wk-leg-mark wk-gate-met"><span class="wk-gate-dot"></span></span>Met</span>
        <span class="wk-leg"><span class="wk-leg-mark wk-gate-missed"><span class="wk-gate-dot"></span></span>Missed</span>
        <span class="wk-leg"><span class="wk-leg-mark wk-gate-off"><span class="wk-gate-dot"></span></span>Called off</span>
        <span class="wk-leg"><span class="wk-leg-mark wk-gate-paused"><span class="wk-gate-dot"></span></span>Paused (not judged)</span>
        <span class="wk-leg"><span class="wk-leg-mark wk-gate-open">${WK_SVG.sun}</span>Wake gate</span>
        <span class="wk-leg"><span class="wk-leg-mark wk-gate-open">${WK_SVG.moon}</span>Sleep gate</span>
        <span class="wk-leg-note">Click a gate to read its day. Its wake/sleep role is set from the hours button.</span></div>
    </div>`;

  // The scroll survives a repaint; a new week or a new range starts fresh —
  // at 07:00 when the whole day is shown, at the top when it is clipped.
  const oldScroll = host.querySelector('.wk-scroll');
  const keepTop = oldScroll ? oldScroll.scrollTop : 0;
  const key = `${calWeek.start}|${start}|${end}`;

  // THE WEEK'S TOOLS LIVE IN THE CALENDAR'S SELECTOR (2026-10-01, Quentin's
  // instruction): its pill names the week, and its menu holds the arrows,
  // Today (only off this week), Day | Week, the hours, Plan and refresh,
  // above what the calendar draws. calFilter (stripMenu) reads this.
  calWeek.tools = { title, rangeLabel, fetchFailed,
                    thisWeek: calWeek.start === weekStartOf(wallDay()) };
  calFilter.render();

  host.innerHTML = `
    ${rangePop}
    <div class="wk-grid wk-days">
      <div class="wk-corner"><button class="wk-legend-btn${calWeek.pop === 'legend' ? ' on' : ''}"
        data-wk="legend" title="Legend">${WK_SVG.info}</button></div>${heads}
    </div>
    ${hasAllday ? `<div class="wk-grid wk-allday-row"><div></div>${alldayRow.join('')}</div>` : ''}
    ${legendPop}
    ${wkTaskPopHtml()}
    <div class="wk-scroll">
      <div class="wk-grid wk-body">
        <div class="wk-gutter" style="height:${H}px">${hours.map(m =>
          `<div class="wk-hour" style="top:${y(m) - 7}px">${wkClock(m).replace(' +1d', '')}</div>`).join('')}</div>
        ${cols}
      </div>
    </div>`;

  calWeek.range = { start, end };
  const taskIn = calWeek.taskPop && calWeek.taskPop.focus && host.querySelector('.wk-task-add');
  if (taskIn) { taskIn.focus(); taskIn.setSelectionRange(taskIn.value.length, taskIn.value.length); }
  host.querySelectorAll('.wk-col[data-date]').forEach(col => {
    const d = col.dataset.date;
    const geo = {
      start, end,
      px: () => H,
      place: (el, s0, e0) => { el.style.top = `${y(s0)}px`; el.style.height = `${y(e0) - y(s0)}px`; },
      overrides: () => (calWeek.days[d] || {}).overrides || [],
      dropped: async () => { await refreshCalWeek(); },
      repaint: () => renderCalWeek(),
    };
    initBlockBarDrag(col, d, geo);
    col.querySelectorAll('.wk-gate[data-node]').forEach(btn => {
      const g = wkDayGates(d).find(x => String(x.node_id) === btn.dataset.node);
      if (g) initGateDrag(btn, g, d, geo, min => { btn.style.top = `${y(min) - 7}px`; });
    });
    const evs = col.querySelector('.wk-evs');
    if (evs) initEventDrag(evs, d, geo);
    col.querySelectorAll('.tl-gcal-event').forEach(el => {
      const hide = () => hideTimelineItem('event', el.dataset.evKey, el.dataset.evLabel);
      el.addEventListener('contextmenu', e => { e.preventDefault(); hide(); });
      onLongPress(el, hide);
    });
  });

  const sc = host.querySelector('.wk-scroll');
  if (calWeek.scrollKey !== key) {
    calWeek.scrollKey = key;
    sc.scrollTop = start === 0 ? 7 * WK_HOUR_PX : 0;
  } else {
    sc.scrollTop = keepTop;
  }
}

// ↻, on either view. The feed refresh alone left the blocks and gates as they
// were when the day was first opened — a block edited in Settings or a gate
// changed on /gates stayed stale until you paged away and back. So it re-reads
// everything the calendar draws, and says it is working while it does.
let calRefreshing = false;
async function refreshCalendar() {
  if (calRefreshing) return;
  calRefreshing = true;
  document.getElementById('cal-overlay').classList.add('cal-refreshing');
  try {
    await refreshExternal();
    state.accountabilityNodes = await apiGet('/api/accountability/nodes', state.accountabilityNodes);
    if (calWeek.on) await refreshCalWeek();
    else await fetchOverridesForDate(state.currentDate);
  } finally {
    calRefreshing = false;
    document.getElementById('cal-overlay').classList.remove('cal-refreshing');
    renderTimeline();
  }
}

function moveWeekNowLine() {
  const line = document.querySelector('#cal-week .wk-now');
  const r = calWeek.range;
  if (!r) return;
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  // Crossed midnight, or out of the hours shown: the paint has to change.
  const col = line && line.closest('.wk-col');
  if (!line || !col || col.dataset.date !== wallDay() || m < r.start || m > r.end) {
    if (!calWeek.pop) renderCalWeek();
    return;
  }
  line.style.top = `${Math.round((m - r.start) / 60 * WK_HOUR_PX)}px`;
}

function closeCalWeekPops() {
  if (!calWeek.on || !calWeek.pop) return false;
  calWeek.pop = null;
  calWeek.focus = null;
  renderCalWeek();
  return true;
}

// The wake and sleep gates are the SAME two settings Settings → Gates sets
// (qr_wake_node_id / qr_sleep_node_id) — a view preference, not a gate write,
// so it is set here and nothing about any gate's day moves.
async function setWeekGateRole(nodeId, role) {
  const id = nodeId == null ? null : String(nodeId);
  const patch = {};
  if (id == null) {
    patch.qr_wake_node_id = null;
    patch.qr_sleep_node_id = null;
  } else {
    if (role === 'wake') patch.qr_wake_node_id = id;
    if (role === 'sleep') patch.qr_sleep_node_id = id;
    if (role !== 'wake' && wkRole(id) === 'wake') patch.qr_wake_node_id = null;
    if (role !== 'sleep' && wkRole(id) === 'sleep') patch.qr_sleep_node_id = null;
  }
  if (!Object.keys(patch).length) return;
  const res = await apiSend('/api/settings', 'PATCH', patch).catch(() => null);
  if (!res || !res.ok) { toast('Could not save that — nothing changed'); return; }
  state.settings = await res.json();
  renderTimeline();   // the day view is clipped by the same two gates
}

// THE CALENDAR'S SELECTOR (2026-10-01, Quentin's instruction): what the
// calendar DRAWS — blocks, gates, events, and each calendar on its own. A view
// preference of this device (localStorage, the remembered-filter kind): it
// hides nothing anywhere else, and nothing it hides stops being judged.
let calShow = {};
try { calShow = JSON.parse(localStorage.getItem('calShow') || '{}') || {}; } catch (e) { calShow = {}; }

function saveCalShow() {
  try { localStorage.setItem('calShow', JSON.stringify(calShow)); } catch (e) { /* in-memory still works */ }
}

// The ONE question every calendar drawing asks of an event: dismissed for
// that day, or switched off here.
function calShowsEvent(e) {
  return !state.tlHidden.event[eventKey(e)] && calShow.events !== false
    && !((calShow.cals || {})[e.source_id] === false);
}

function paintCalShowClasses() {
  const ov = document.getElementById('cal-overlay');
  if (!ov) return;
  ov.classList.toggle('cal-hide-blocks', calShow.blocks === false);
  ov.classList.toggle('cal-hide-gates', calShow.gates === false);
}

const calFilterView = { open: false };

function calShowOff() {
  const cals = (state.calendars || []).filter(c => c.active !== 0);
  return ['blocks', 'gates', 'events'].filter(k => calShow[k] === false).length
    + cals.filter(c => (calShow.cals || {})[c.id] === false).length;
}

const calFilter = stripMenu({
  pill: 'cal-filter',
  menu: 'cal-filter-menu',
  title: 'The week, its hours, and what the calendar draws',
  isOpen: () => calFilterView.open,
  setOpen: on => { calFilterView.open = on; },
  pillText: () => {
    const t = calWeek.on && calWeek.tools;
    const day = state.currentDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const off = calShowOff();
    return { text: `${t ? t.title : day}${off ? ` · ${off} off` : ''}`, narrowed: !!off };
  },
  sections: () => {
    const t = calWeek.on && calWeek.tools;
    const cals = (state.calendars || []).filter(c => c.active !== 0);
    return [
      t && { title: 'Week', html: `
        ${dateNavHtml({ cls: 'cf-week', unit: 'week', prev: 'data-wk="prev"', next: 'data-wk="next"',
          today: t.thisWeek ? null : 'data-wk="today"',
          label: `<span class="wk-title">${escHtml(t.title)}</span>` })}
        <div class="tn-menu-chips cf-tools">
          <button class="chip wk-mono${calWeek.pop === 'range' ? ' on' : ''}" data-wk="range"
            title="Wake and sleep gates">${WK_SVG.sun} ${escHtml(t.rangeLabel)}</button>
          <button class="chip" data-wk="plan" title="Draw the hours you plan to work — on the day">Plan</button>
          <button class="chip" data-wk="refresh" title="Refresh the calendar feed">${WK_SVG.refresh} Refresh</button>
          ${t.fetchFailed ? '<span class="fetch-failed wk-fetch">Last fetch failed</span>' : ''}
        </div>` },
      calWeekAvailable() && { title: 'View', chips: pickChipsHtml([{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }],
                                            calWeek.on ? 'week' : 'day', 'data-cal-view') },
      { title: 'Draw', chips: ['blocks', 'gates', 'events'].map(k =>
          toggleChipHtml(calShow[k] !== false, `data-calshow="${k}"`, k[0].toUpperCase() + k.slice(1))).join('') },
      cals.length && { title: 'Calendars', chips: cals.map(c =>
          toggleChipHtml((calShow.cals || {})[c.id] !== false, `data-calsrc="${c.id}"`, c.name || 'Calendar')).join('') },
    ];
  },
  clear: () => { calShow = {}; },
  // What it draws changed: the layers' classes, the day, and the week.
  onChange: () => {
    saveCalShow();
    paintCalShowClasses();
    calFilter.render();
    renderTimeline();
    if (calWeek.on) renderCalWeek();
  },
  wire: (menu, stay) => {
    menu.querySelectorAll('[data-calshow]').forEach(b => stay(b, () => {
      const k = b.dataset.calshow;
      calShow[k] = calShow[k] === false ? true : false;
    }));
    menu.querySelectorAll('[data-calsrc]').forEach(b => stay(b, () => {
      calShow.cals = calShow.cals || {};
      const id = b.dataset.calsrc;
      calShow.cals[id] = calShow.cals[id] === false ? true : false;
    }));
  },
});

function initCalWeek() {
  const host = document.getElementById('cal-week');
  const overlay = document.getElementById('cal-overlay');
  const strip = document.getElementById('cal-filter-menu');
  if (!host || !overlay) return;

  // The Day | Week switch. ONE copy, in the calendar's selector (2026-10-05):
  // the day header drew a second (#tl-view-seg) on a wide window, where the
  // selector already offers it — and the selector is the one place a phone
  // reaches. Delegated, since the menu is rebuilt on every pick.
  const viewSwitch = e => {
    const v = e.target.closest('[data-cal-view]');
    if (!v) return;
    calWeek.pref = v.dataset.calView === 'week' ? 'week' : 'day';
    setCalView(calWeek.pref === 'week');
  };
  strip.addEventListener('click', viewSwitch);
  paintCalShowClasses();

  // Pressing a gate says which DAY its menu is about.
  host.addEventListener('pointerdown', e => {
    const g = e.target.closest('[data-obj-date]');
    calWeek.objDate = g ? g.dataset.objDate : null;
  }, true);

  const weekClick = async e => {
    if (await wkTaskClick(e)) return;
    const a = e.target.closest('[data-wk]');
    const act = a ? a.dataset.wk : null;
    // A click anywhere off an open popover puts it down, and does nothing else
    // unless it landed on a control.
    if (calWeek.pop && !e.target.closest('.wk-pop') && !['range', 'legend'].includes(act)) {
      calWeek.pop = null;
      calWeek.focus = null;
      renderCalWeek();
      if (!a) return;
    }
    if (!a) return;
    if (act === 'prev' || act === 'next') {
      state.currentDate = new Date(localDatePlusDays(viewDay(), act === 'prev' ? -7 : 7) + 'T12:00:00');
      await refreshCalWeek();
    } else if (act === 'today') {
      state.currentDate = new Date();
      await refreshCalWeek();
    } else if (act === 'range' || act === 'legend') {
      calWeek.pop = calWeek.pop === act ? null : act;
      calWeek.focus = null;
      calWeek.focusDate = null;
      renderCalWeek();
    } else if (act === 'gate') {
      // A click that trails a drag of the mark is not a tap on it.
      if (a.dataset.lpDragged === '1' || justPointerDragged()) { delete a.dataset.lpDragged; return; }
      // What the box knows about that gate on that day — the day view's
      // read-out, for the column's date. The roles are on the range button.
      openGatePop(parseInt(a.dataset.node), a.dataset.date, a);
    } else if (act === 'role') {
      await setWeekGateRole(a.dataset.node, a.dataset.role);
    } else if (act === 'clear-roles') {
      await setWeekGateRole(null);
    } else if (act === 'open-gate') {
      e.preventDefault();
      openGatesDashboard(a.dataset.node, a.dataset.date);
    } else if (act === 'day') {
      state.currentDate = new Date(a.dataset.date + 'T12:00:00');
      await setCalView(false);
    } else if (act === 'plan') {
      await setCalView(false);
      state.planMode = true;
      await refreshPlan(viewDay());
      renderTimeline();
    } else if (act === 'refresh') {
      await refreshCalendar();
    } else if (act === 'event') {
      openEventPop(a.dataset.evKey, a);
    }
  };
  // ONE handler for the week's controls wherever they stand — the grid, and
  // the selector's menu.
  host.addEventListener('click', weekClick);
  strip.addEventListener('click', weekClick);

  // Narrowed past the week's width: back to the day, which fits.
  // The window was resized across the week's width: follow it, both ways.
  WEEK_MQ.addEventListener('change', () => {
    if (overlay.classList.contains('hidden')) return;
    setCalView(WEEK_MQ.matches && calWantsWeek());
  });
}

// Called (via evaluate_js) after the NOW panel checks something off — and
// after an inbox capture lands from outside this window (hotkey, bridge) —
// so the day view reflects it immediately instead of waiting for a manual
// refresh. The name is historical (the panel used to edit the to-do plan).
// Refetches the inbox too: the footer's "Clarify N" count is stale otherwise.
async function refreshTodoNow() {
  state.inbox = await apiGet('/api/inbox', state.inbox);
  await refreshEngage();
  return;
}

// The phone writes straight to the server, so nothing nudges this window.
// Coming back to it is the natural moment to catch up — a focus/visibility
// refresh, throttled to 30s, is event-driven, not polling.
let lastFocusRefresh = 0;
function focusRefresh() {
  if (document.hidden || Date.now() - lastFocusRefresh < 30000) return;
  lastFocusRefresh = Date.now();
  refreshTodoNow();
  // Back at the window with the calendar up: another device may have changed
  // it — a scan from the phone is the usual one, and its gate should turn.
  const cal = document.getElementById('cal-overlay');
  if (cal && !cal.classList.contains('hidden')) {
    if (calWeek.on) refreshCalWeek(); else reloadCalGates();
  }
}

// ── Section 2: Active project items ──────────────────────────

// TODAY's resolved blocks, from the server (storage.block_segments_for) —
// refreshed by checkActiveBlock's 60s tick. Kept apart from state.overrides,
// which holds the VIEWED timeline day and is overwritten on every nav: this
// answers a question about NOW, and answering it from a viewed-day cache
// resurrected a block you had cancelled today the moment you looked at
// tomorrow.
let todaySegments = { date: null, segments: [] };

async function refreshTodaySegments() {
  const date = wallDay();
  todaySegments = { date, segments: await apiGet(`/api/blocks/day?date=${date}`, []) };
}

// The block in force RIGHT NOW. Semantic minutes, so a 22:00–01:00 block is
// one segment 1320→1500 and yesterday's continuation arrives at a negative
// start — both of which the old 'HH:MM' string compare missed entirely, taking
// the derived domain (and so the pool, section 2 and the filing suggestion)
// with it for the block's whole span.
function detectCurrentStandardBlock() {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const projectsById = Object.fromEntries(state.areas.map(p => [p.id, p]));
  const blocksById = Object.fromEntries((state.blocks || []).map(b => [b.id, b]));
  for (const seg of todaySegments.segments) {
    // A block filed under a domain is a working block; one filed under an area
    // is one when the area is a standard area (not a routine or sleep area).
    if (seg.area_id) {
      const proj = projectsById[seg.area_id];
      if (!proj || proj.type !== 'standard') continue;
    } else if (!seg.domain_id) continue;
    if (nowMin >= seg.start && nowMin < seg.end) return blocksById[seg.block_id] || seg;
  }
  return null;
}

let section2RevertTimer = null;


// ── Calendar navigation bounds ───────────────────────────────
//
// UNBOUNDED (2026-08-22, Quentin's instruction, removing the ±3-day clamp).
// The clamp was there to say "this is a DAY manager, not a calendar to
// browse" — but Engage's own day nav never had it, so the restriction only
// applied to the surface that is literally a calendar, and the review pass
// had to keep widening it to do the one job that needs a week either side.
//
// Nothing downstream needed the ceiling: blocks, gates and placements are
// resolved per date by the server for any date you ask for. The FETCHED
// calendar is the one thing with a real horizon — the iCal window is
// GCAL_DAYS_BACK back and ~90 days forward — so far enough out the day is
// real but has no events in it, which is the truth rather than a wall.
//
// (The weekly review's calendar PASS set its own window here; it went with the
// review runner, 2026-10-05.)
function navBounds() {
  return { min: -Infinity, max: Infinity };
}

function dayOffset(date) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

function domainName(id) {
  const d = (state.domains || []).find(x => String(x.id) === String(id));
  return (d && d.name) || '—';
}

function domainIdForArea(areaId) {
  const a = areaId ? (state.areas || []).find(p => String(p.id) === String(areaId)) : null;
  return (a && a.domain_id) || null;
}

// ── WHERE A ROW IS FILED (2026-09-15, Quentin's instruction) ──────────────
//
// Domains and areas are two separate things. An area MAY be assigned to a
// domain; an item, project, block, span, recurring task or routine is filed
// under an AREA, or a DOMAIN, or nothing — never both (storage.filing_updates
// is the server's half). These four are the only readers of that shape, so no
// surface re-decides which of the two columns wins.
//
// The DOMAIN a row is in: its area's, when it is filed under one; otherwise
// its own. Nothing filed means no domain, which every domain filter treats as
// "belongs everywhere" rather than "belongs nowhere".
function filingDomainId(row) {
  if (!row) return null;
  if (row.area_id) return domainIdForArea(row.area_id);
  return row.domain_id || null;
}

// A picker holds ONE value for the pair: 'a:<id>', 'd:<id>' or ''.
function filingKey(row) {
  if (row && row.area_id) return `a:${row.area_id}`;
  if (row && row.domain_id) return `d:${row.domain_id}`;
  return '';
}

function filingBody(key) {
  const [k, id] = String(key || '').split(':');
  const n = parseInt(id) || null;
  return { area_id: k === 'a' ? n : null, domain_id: k === 'd' ? n : null };
}

function filingLabel(row) {
  if (row && row.area_id) {
    return ((state.areas || []).find(a => String(a.id) === String(row.area_id)) || {}).name || '';
  }
  return row && row.domain_id ? domainName(row.domain_id) : '';
}

// Re-render an input's surface without teleporting the caret to the end.
// Setting .value (or rebuilding the node) collapses the selection, so the
// offsets have to be captured before and reapplied after.
function preserveCaret(id, rerender) {
  const before = document.getElementById(id);
  const pos = before ? [before.selectionStart, before.selectionEnd] : null;
  rerender();
  const after = document.getElementById(id);
  if (!after || !pos) return;
  after.focus();
  try { after.setSelectionRange(pos[0], pos[1]); } catch (e) { /* non-text input */ }
}

// ── Undo (Ctrl+Z / the ↩ button) ──────────────────────────────
// Every button that CHANGES DATA registers how to reverse itself. The rule
// is in CLAUDE.md: a new mutating handler ships with its inverse or it isn't
// finished. Inverses are closures, so they capture the exact prior value
// rather than guessing it later. The stack itself is common.js's
// makeUndoStack, shared with the gates dashboard; these three names are the
// app's API over it.
const undoStack = makeUndoStack(() => paintUndo());

function pushUndo(label, inverse) {
  undoStack.push(label, inverse);
}

async function runUndo() {
  await undoStack.run();
}

function paintUndo() {
  // ↩ lives in the top strip, which is visible from every page — greyed,
  // not hidden, while there is nothing to undo, so the strip never shifts.
  const eg = document.getElementById('eg-undo');
  if (eg) eg.disabled = !undoStack.size;
}

// ── Capture (one implementation, two entry points) ────────────
//
// The Engage footer bar and the global capture chip both land here. Bare
// capture is the one write with no decisions attached, so it stays a single
// function — which is also the only place that has to own the inverse.
async function captureToInbox(content) {
  const res = await apiSend('/api/inbox', 'POST', { content }).catch(() => null);
  if (!res || !res.ok) { toast('Capture failed'); return null; }
  const item = await res.json();
  // A create inverts to a delete of the new id (see the undo rule).
  pushUndo(`captured "${content}"`, async () => {
    await apiSend(`/api/inbox/${item.id}`, 'DELETE');
    await refreshInboxCount();
  });
  await refreshInboxCount();
  return item;
}

async function refreshInboxCount() {
  state.inbox = await apiGet('/api/inbox', state.inbox);
  // The footer only exists while Engage is rendered; capture works from
  // anywhere, so this is a soft update rather than a re-render.
  const clarify = document.getElementById('eg-clarify');
  if (clarify) clarify.textContent = clarifyBarLabel();
  renderInbox();
}

// ── THE global bar ─────────────────────────────────────────────
//
// One context-sensitive bottom bar for the whole app (replaces the floating
// capture/undo chips, MAP's footer bar and the GTD/MAP inline add inputs).
// Every overlay opens ABOVE it (bottom: var(--gbar-h)), so its four pieces —
// the input, ↩, Clarify N, ≡ — are one tap from anywhere. The INPUT is the
// only part that morphs; the ◉ chip on its left names where typed text lands:
//   · no chip           → bare inbox capture (captureToInbox)
//   · ◉ <project>       → next action filed under that project (set by the
//                         + affordances on GTD/MAP project rows; persists for
//                         rapid entry until the chip is tapped or Esc'd)
//   · ◉ <area>          → active item straight into that area (MAP's + item)
// Capture stays SILENT everywhere: the Clarify count ticking up is now always
// on screen, so it is the receipt (the old chip's toast existed only because
// that count used to be covered). MAP's ◉ filing target is untouched — it
// routes CLARIFY filing, a different write; only bar typing is governed here.
// The bar is for CAPTURING, nothing else (Quentin, 2026-08-11). The derived
// modes — ✎ log, ✎ list, ◉ <list>, ◉ <routine> — are gone: typed text lands
// in the inbox from every surface, and every list datatype adds through its
// own button + the entry sheet (see openEntrySheet). barView/barModeNow went
// with them.
// HALF-TYPED TEXT IS DATA (2026-08-12). Two rules, because the bar had been
// losing captures mid-sentence on the phone:
//
// 1. renderBar NEVER replaces the input while you are in it. It used to rebuild
//    the whole bar with innerHTML, which destroys the focused <input> — the
//    keyboard retracts and the text goes with the node. Nothing the user did
//    triggered it: renderEngage repaints the bar, and refreshEngage is called by
//    the 'online' event (a cellular↔wifi handoff), by visibilitychange/focus
//    (which a phone fires for the notification shade, the share sheet, even a
//    keyboard show), and by checkActiveBlock crossing into a new domain on its
//    60s timer. checkActiveBlock already guarded renderInbox this way
//    (`!inboxSection.contains(document.activeElement)`); the bar never was.
// 2. The draft is MIRRORED to localStorage on every keystroke, so a real reload,
//    a crash or the OS discarding the tab does not lose it either. Restored as
//    text only — never focus, or opening the app would pop the keyboard.
//
// Both halves are needed: the guard covers the repaint, the mirror covers
// everything that destroys the whole document.
const CAPTURE_DRAFT_KEY = 'captureDraft';

function captureDraftSet(v) {
  try {
    if (v) localStorage.setItem(CAPTURE_DRAFT_KEY, v);
    else localStorage.removeItem(CAPTURE_DRAFT_KEY);
  } catch (e) { /* private mode / full quota: the guard still holds */ }
}

function captureDraftGet() {
  try { return localStorage.getItem(CAPTURE_DRAFT_KEY) || ''; } catch (e) { return ''; }
}

// The parts of the bar that are DERIVED from state and must stay honest even
// when the input is left alone. Everything else in the bar is static markup.
function renderBarCounts(bar) {
  const clarify = bar.querySelector('#eg-clarify');
  if (clarify) clarify.textContent = clarifyBarLabel();
}

function renderBar() {
  const bar = document.getElementById('global-bar');
  if (!bar) return;
  // Rule 1. Focused, or holding text you have not filed yet: patch the counts
  // and leave the input alone.
  const live = bar.querySelector('#eg-capture');
  if (live && (document.activeElement === live || live.value)) {
    renderBarCounts(bar);
    return;
  }
  // The dock is for CAPTURING and nothing else (Map Page 9a, 2026-10-01):
  // the field and Clarify. Undo moved to the top strip with the other page
  // tools, and the ≡ hub went — every page is a tab now.
  bar.innerHTML = `
    <input type="text" id="eg-capture" placeholder="Capture anything..." autocomplete="off">
    <button id="eg-clarify" title="Process the inbox">${clarifyBarLabel()}</button>
  `;

  const input = bar.querySelector('#eg-capture');
  // Rule 2, the read half. Text only: a draft restores what you typed, it does
  // not decide that you are typing.
  input.value = captureDraftGet();
  input.addEventListener('input', () => captureDraftSet(input.value));
  wireEdgeFade(input);
  input.addEventListener('keydown', async e => {
    if (e.key === 'Escape') {
      // Peel: text first, then let the overlay's own Esc take over.
      if (input.value) { e.stopPropagation(); input.value = ''; captureDraftSet(''); return; }
      input.blur();
      return;
    }
    if (e.key !== 'Enter') return;
    // stopPropagation, or the clarify sheet's document-level Enter handler
    // (which files the item being clarified) fires off a BAR capture too.
    e.stopPropagation();
    const raw = input.value.trim();
    if (!raw) return;
    input.value = '';
    // The draft is dropped only once the item is SAFE. captureToInbox toasts
    // and returns null on a failed write, and a capture that failed to reach
    // the server is exactly when the text still needs to exist.
    if (await captureToInbox(raw)) {
      captureDraftSet('');
      // MAP's untriaged "in" pile is on screen when capturing from MAP —
      // the new row appearing there is the receipt.
      const mapEl = document.getElementById('map-overlay');
      if (mapEl && !mapEl.classList.contains('hidden')) await refreshMap();
    } else {
      input.value = raw;
    }
  });

  bar.querySelector('#eg-clarify').addEventListener('click', openClarify);
}


// (apiGet / apiSend — the two shapes every call in this file has — and toast
// are in common.js.)

// Repaint whatever surfaces are open after an undo, without caring which one
// the original action came from.
async function refreshAfterUndo() {
  await refreshEngage();
  // The week caches each day it draws, so an undo re-reads it like any surface.
  if (calWeek.on) await refreshCalWeek();
  // ...and so does the day view, whose served day is cached the same way.
  else if (!document.getElementById('cal-overlay').classList.contains('hidden')) {
    await fetchOverridesForDate(state.currentDate);
    renderTimeline();
  }
  if (!document.getElementById('map-overlay').classList.contains('hidden')) await refreshMap();
  if (!document.getElementById('tab-lists').classList.contains('hidden')) await refreshRef();
  // The breakdown composer reads its own list, so an undo that touched a
  // chain (undoablePatch writes the inverse itself) has to repaint it here or
  // the sheet keeps showing the state that was just reversed.
  if (clarifyView.compose) await refreshCompose();
  state.inbox = await fetch('/api/inbox').then(r => r.json());
  renderInbox();
}

// Snapshot an inbox item so a delete can be replayed exactly (same id, so
// children and day placements survive).
async function snapshotItem(id) {
  return fetch(`/api/inbox/${id}/snapshot`).then(r => r.ok ? r.json() : null).catch(() => null);
}

function patchInboxItem(id, body) {
  return apiSend(`/api/inbox/${id}`, 'PATCH', body);
}

// ── A DRAG IS A BUTTON, AND EVERY BUTTON SHIPS ITS INVERSE (2026-08-24,
// Quentin's instruction) ────────────────────────────────────────────────────
//
// The timeline's gestures write real facts — a block's hours for a day, a
// gate's window on the money path — and none of them registered an undo,
// because the undo rule was written for BUTTONS and these do not look like
// buttons. They are: a drop is a commit, and a mis-drop of five pixels is the
// most likely mistake on this surface, not the least.
//
// The inverse of a per-day override is the override that was there BEFORE —
// including "there was none", which is a DELETE and not a zeroed row. That
// distinction is the whole reason these live here rather than being written
// out at each call site: an inverse that leaves an all-day override saying
// "same as the default" is not an undo, it is a new decision that happens to
// agree today and stops agreeing the moment the default moves.
//
// `undo_test.py` is the mechanical half: a drag that writes must reach one of
// these, or say in the test why it does not.
async function restoreBlockOverride(blockId, date, prev, createdId) {
  let res;
  if (prev) {
    res = await apiSend('/api/overrides', 'POST', {
      block_id: blockId, date, cancelled: !!prev.cancelled,
      start_time: prev.start_time, end_time: prev.end_time });
  } else if (createdId != null) {
    res = await apiSend(`/api/overrides/${createdId}`, 'DELETE');
  } else {
    return;
  }
  if (!res || !res.ok) { toast('Could not undo that block'); return; }
  await fetchOverridesForDate(state.currentDate);
  if (calWeek.on) await refreshCalWeek();
  renderTimeline();
}

function undoableBlockOverride(blockId, date, prev, createdId, label) {
  pushUndo(label, () => restoreBlockOverride(blockId, date, prev, createdId));
}

// A BLOCK FOR ONE DATE is its own row, so its inverses are the row's: a move
// is undone by the times the row had (read from the server first — a week
// column's drawn times are clipped to the hours it shows), a removal by
// re-inserting the ORIGINAL id. Neither touches the week.
async function undoableDayBlockMove(id, startMin, endMin) {
  const prev = await apiGet(`/api/day-blocks/${id}`, null);
  if (!prev || !prev.id) { toast('That block is gone'); return; }
  const res = await apiSend(`/api/day-blocks/${id}`, 'PATCH',
    { start_min: startMin, end_min: endMin });
  if (!res.ok) { toast('Could not move that block'); return; }
  pushUndo(`moved "${prev.label}"`, async () => {
    await apiSend(`/api/day-blocks/${id}`, 'PATCH',
      { start_min: prev.start_min, end_min: prev.end_min });
    await refreshAfterUndo();
  });
  await refreshAfterUndo();
}

async function removeDayBlock(id) {
  const row = await apiGet(`/api/day-blocks/${id}`, null);
  if (!row || !row.id) { toast('That block is gone'); return false; }
  const res = await apiSend(`/api/day-blocks/${id}`, 'DELETE');
  if (!res.ok) { toast('Could not remove that block'); return false; }
  pushUndo(`removed "${row.label}"`, async () => {
    await apiSend('/api/day-blocks', 'POST', row);
    await refreshAfterUndo();
  });
  await refreshAfterUndo();
  return true;
}

// Its one day-level verb. The date is the ROW's own, never the viewed day, so
// the verb is the same wherever the block is drawn.
registerObjectVerbs('dayblock', (kind, id) => kind !== 'dayblock' ? [] : [
  { label: 'Remove from this date', danger: true, rightClick: true,
    run: () => removeDayBlock(parseInt(id)) },
]);

// The common case: a PATCH whose inverse is the same PATCH with the values
// the item had before. `fields` is the list of keys being changed.
function undoablePatch(item, fields, label) {
  const prev = {};
  fields.forEach(f => { prev[f] = item[f] === undefined ? null : item[f]; });
  pushUndo(label, async () => {
    await patchInboxItem(item.id, prev);
    await refreshAfterUndo();
  });
}

// ── Notes autosave ───────────────────────────────────────────
//
// Notes are the only long-form field in the inventory, and blur used to be the
// only thing that wrote them — which lost text three ways: Escape closed the
// editor without saving, removing a focused element fires NO blur (so any
// re-render from elsewhere dropped whatever had been typed), and closing the
// window took the rest. They now write on a debounce, and every exit flushes.
//
// The undo entry is registered ONCE per editing session rather than per save:
// the stack is capped at 30, so pushing one every 700ms would shove the real
// inverse off the end inside a single paragraph.
const NOTES_SAVE_MS = 700;
const openNotes = [];

// A NOTES FIELD GROWS TO ITS CONTENT. rows="2" is a floor, not a ceiling: on a
// 430px-wide phone a note of any length was trapped in two lines with its own
// scrollbar, so the thing you wrote was the thing you could not see. Height is
// set from scrollHeight and CAPPED, because a note long enough to fill the
// screen would push the sheet's verbs off the bottom — and on a phone a button
// you have to scroll to find is a button that is not there.
//
// The cap is a share of the VIEWPORT rather than a fixed pixel count, so it
// means the same thing on a phone and on the desktop window.
function autoGrowNotes(ta) {
  if (!ta) return;
  const cap = Math.max(120, Math.round(window.innerHeight * 0.4));
  ta.style.height = 'auto';                 // measure the content, not the box
  ta.style.height = Math.min(ta.scrollHeight, cap) + 'px';
  // Only the capped case needs to scroll; below the cap there is nothing to
  // scroll and a scrollbar would just be noise.
  ta.style.overflowY = ta.scrollHeight > cap ? 'auto' : 'hidden';
}

function wireNotesAutosave(ta, commit) {
  let timer = null;
  let pending = false;
  const flush = async () => {
    clearTimeout(timer);
    timer = null;
    if (!pending) return;
    pending = false;
    await commit(ta.value);
  };
  ta.addEventListener('input', () => {
    autoGrowNotes(ta);
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(flush, NOTES_SAVE_MS);
  });
  // Sized once at wiring time too: a field opened with content already in it
  // must show that content, not wait for a keystroke to reveal it.
  autoGrowNotes(ta);
  ta.__flushNotes = flush;
  // A notes field is a markdown field — the log editor's shortcut suite comes
  // with the autosave contract (Ctrl+S flushes via __flushNotes above).
  wireMdShortcuts(ta);
  // Drop textareas a re-render has already thrown away, so the list stays the
  // length of what is actually on screen (one or two).
  for (let i = openNotes.length - 1; i >= 0; i--) {
    if (!openNotes[i].isConnected) openNotes.splice(i, 1);
  }
  openNotes.push(ta);
  return flush;
}

// Every close path funnels here. Detached textareas get flushed too — one may
// still be holding text that a mid-keystroke re-render orphaned — and are then
// dropped.
function flushOpenNotes() {
  const all = openNotes.splice(0, openNotes.length);
  openNotes.push(...all.filter(ta => ta.isConnected));
  return Promise.all(all.map(ta => ta.__flushNotes()));
}

// A delete whose inverse restores the captured snapshot. A REFUSED delete (a
// sheet row whose tick failed is a 502 and the item stays) says so and
// registers nothing — an undo for a delete that never happened would restore
// over a live row. Returns whether the row is gone.
async function undoableDelete(id, label) {
  const snap = await snapshotItem(id);
  const res = await apiSend(`/api/inbox/${id}`, 'DELETE');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'Could not delete that');
    return false;
  }
  if (snap) {
    pushUndo(label, async () => {
      await apiSend('/api/inbox/restore', 'POST', snap);
      await refreshAfterUndo();
    });
  }
  return true;
}

// Time-estimate tags: one of these on an item means "takes about this long".
// They are ordinary tags everywhere (chips, filters, #5m in an add bar) —
// only the clarify picker treats them as exclusive, because a thing doesn't
// take 5 AND 120 minutes. The four are MAP's `t` arrows (2026-09-23, Quentin's
// instruction: ← 5m, ↑ 15m, → 45m, ↓ 2h), which replaced 30m/90m — a row
// still carrying one of those keeps it as a plain tag.
const EST_TAGS = ['5m', '15m', '45m', '2h'];

// Priority tags, set from MAP's 1/2/3 keys and exclusive there: p1 is the
// highest. Inert tokens like every other tag — the tint MAP gives a row is the
// only thing that reads them.
const PRIORITY_TAGS = ['p1', 'p2', 'p3'];

// The due chip for inbox_item.deadline (REAL deadlines only — that discipline
// is the user's, not the app's). One renderer so every surface says it the
// same way: red once it's today-or-gone, plain before that. Deadline is
// display/priority metadata — no availability predicate reads it.
// The date an item is actually working to: its own, or the earliest one it
// INHERITS from the projects above it (storage._effective_deadline). A project
// due today makes its next actions due today — an action can't be later than
// the outcome it serves.
function dueOf(item) {
  return item.effective_deadline || item.deadline || null;
}

function dueChip(item, cls) {
  const due = dueOf(item);
  if (!due) return '';
  const today = wallDay();
  const d = new Date(due + 'T12:00:00');
  const label = due === today ? 'due today'
    : `due ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  // An inherited date is shown dashed and says where it came from: it is a
  // real constraint, but it is not one the user typed on THIS row, and the
  // discipline that keeps deadlines meaningful depends on telling them apart.
  const own = item.deadline === due;
  return `<span class="${cls} due-chip${due <= today ? ' due-chip-hot' : ''}${
    own ? '' : ' due-chip-inherited'}"${own ? '' : ' title="From the project this belongs to"'}>${label}</span>`;
}

// ── Location-bound tags — GTD's @contexts, literally ─────────
//
// A tag bound to a location preset (tag_location) hides its items from the
// pool while the device is ELSEWHERE. The rule is FAIL-OPEN: no fix — denied
// permission, no hardware, plain-http pywebview where geolocation never
// resolves — hides nothing, because losing GPS must never lose work from
// view. The count of hidden items rides on the pool header (⌖ n elsewhere),
// so the exclusion is visible rather than silent.
function geoDistM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = d => d * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let _geoWatchId = null;
function initGeo() {
  if (!('geolocation' in navigator)) return;
  // Re-callable from a USER GESTURE: iOS often only shows the permission
  // prompt for a gesture-initiated request, so the ctx menu's "enable"
  // button calls this again — clear the old watch first.
  if (_geoWatchId != null) navigator.geolocation.clearWatch(_geoWatchId);
  let last = null;
  _geoWatchId = navigator.geolocation.watchPosition(pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    const moved = !last || geoDistM(last.lat, last.lng, lat, lng) > 30;
    state.geo = { ok: true, lat, lng };
    // Re-render only on real movement — fixes arrive continuously and the
    // day must not repaint on GPS jitter.
    if (moved) { last = { lat, lng }; renderEngage(); }
  }, () => {
    const was = state.geo.ok;
    state.geo = { ok: false };
    if (was !== false) renderEngage();   // repaint the ⌖ status either way
  }, { enableHighAccuracy: false, maximumAge: 60000, timeout: 20000 });
}

// ── Device-bound tags — the same idea as ⌖, on hardware ──────
//
// 'pc' and 'phone' are DEVICE tags: an item carrying one is only available on
// that device, so the pool answers "what can I start ON THIS THING". An item
// with NO device tag is available everywhere — the tag is opt-in friction, not
// a classification every row has to carry — and one carrying BOTH is available
// everywhere too, which is why the predicate reads "some device tag matches"
// rather than "no foreign tag".
//
// They ride the tag system like EST_TAGS do (no new column, no new table): the
// clarify sheet offers them, the context picker lists them, MAP badges them.
// Unlike the location gate there is no fail-open case to design — detection
// always answers — so the escape hatch is a manual override, kept in
// localStorage because the device is a property of the MACHINE and the setting
// table is one row shared by both of them.
const DEVICE_TAGS = ['pc', 'phone'];

function detectDevice() {
  // The pywebview window only ever runs on the laptop.
  if (window.pywebview) return 'pc';
  const ua = navigator.userAgent || '';
  if (/iPhone|iPod|Android|Windows Phone|Mobile/i.test(ua)) return 'phone';
  // iPadOS 13+ reports itself as a Macintosh, so the UA alone would call it a
  // pc. Touch points give it away, and a trackpad is a FINE pointer — neither
  // signal is conclusive on its own, the pair is. ANY touch point counts,
  // because the coarse-pointer half already excludes the mouse-driven machines
  // that report a spurious 1.
  return (navigator.maxTouchPoints || 0) > 0
    && window.matchMedia('(pointer: coarse)').matches ? 'phone' : 'pc';
}

// The time gate is ON unless explicitly switched off. Same reasoning as the
// device override: a lens preference belongs to the machine you are looking
// through, not to the shared `setting` row.
function timeGateOn() {
  return localStorage.getItem('timeGate') !== 'off';
}

function currentDevice() {
  const override = localStorage.getItem('device');
  return DEVICE_TAGS.includes(override) ? override : detectDevice();
}

// WHICH DEVICE DOES THIS ROW BELONG TO — asked by the pool's ▭ gate and by the
// inbox queue, so it is answered ONCE. A tag is device-bound either by BEING
// 'pc'/'phone' or by having been bound to one in the ctx sheet, so `email → pc`
// gates exactly like `#pc` does without being named after the hardware.
function deviceTagMap() {
  const tagDev = {};
  DEVICE_TAGS.forEach(t => { tagDev[t] = t; });
  (state.tagDevices || []).forEach(b => { tagDev[b.tag] = b.device; });
  return tagDev;
}

// No device tag = available everywhere (opt-in friction, not a classification
// every row carries); both = everywhere too, which is why this reads "some
// device tag matches" rather than "no foreign tag". `tagDev` is passed in by
// callers that gate a whole list, so the map is built once per pass.
function itemOnDevice(item, device, tagDev) {
  const map = tagDev || deviceTagMap();
  const devs = itemTags(item).map(t => map[t]).filter(Boolean);
  return !devs.length || devs.includes(device);
}

// The devices a row is waiting for, for a count that names where it went.
function itemDevices(item, tagDev) {
  const map = tagDev || deviceTagMap();
  return [...new Set(itemTags(item).map(t => map[t]).filter(Boolean))];
}

// AN ITEM'S CONTEXTS INCLUDE ITS PROJECT'S (2026-08-19, Quentin's
// instruction). @errands on the project says the same thing about each action
// under it, so this is what every READER asks: the pool's gates, MAP's lens,
// the chips on a row. The server derives it on the walk that already computes
// effective_deadline (storage._walk_up) — the client never re-walks the tree,
// and the fallback is the row's own tags for payloads that carry none.
function itemTags(item) {
  return ((item.effective_tags != null ? item.effective_tags : item.tags) || '')
    .split(/\s+/).filter(Boolean);
}

// What this row itself SAYS, which is the only thing an editor may write. A
// clarify sheet that saved the inherited set would copy a project's contexts
// onto its children, and removing one from the project could then never undo
// them — the same reason effective_deadline is never written down.
function ownTags(item) {
  return (item.tags || '').split(/\s+/).filter(Boolean);
}

// The ones that arrived from above: shown, never editable, on the row's sheet.
function inheritedTags(item) {
  const own = new Set(ownTags(item));
  return itemTags(item).filter(t => !own.has(t));
}

// '#tag' tokens typed into an add bar become tags. An entry that is ONLY tags
// keeps its literal text as content, so nothing ever lands empty.
function parseTags(text) {
  const tags = [];
  const content = text.replace(/(^|\s)#([a-z0-9_-]+)\b/gi, (m, sp, t) => {
    tags.push(t.toLowerCase());
    return sp;
  }).replace(/\s+/g, ' ').trim();
  if (!content) return { content: text.trim(), tags: [] };
  return { content, tags: [...new Set(tags)] };
}


// ── Inbox ────────────────────────────────────────────────────

// ── THE INBOX SPLITS BY DEVICE (2026-08-23, Quentin's instruction) ──
//
// A capture you can only do at the desk is noise on the phone: you read it,
// decide nothing, and read it again tomorrow. So the ▭ gate the POOL already
// applies is applied to the inbox too — the clarify queue on this device is
// the captures this device can actually do something about, and a pc-tagged
// capture waits for the pc.
//
// It is NOT hidden: the bar says how many are waiting and where ("Clarify 5 ·
// 2 on pc"). Gating something as small as the inbox count silently is exactly
// the trust leak the "never hide rows without showing a count" rule exists to
// prevent, and the pool's silent gates bought their exception with a band of
// chrome over a list read 30× a day. This is one word on a button.
//
// One label, three callers (renderInbox, renderBarCounts, refreshInboxCount),
// because the count and the split have to agree everywhere they are printed.
function clarifyBarLabel() {
  const device = currentDevice();
  const tagDev = deviceTagMap();
  const away = state.inbox.filter(i => !itemOnDevice(i, device, tagDev));
  const here = state.inbox.length - away.length;
  if (!away.length) return `Clarify ${here}`;
  const where = {};
  away.forEach(i => itemDevices(i, tagDev).forEach(d => { where[d] = (where[d] || 0) + 1; }));
  // Terse because it shares a 430px bar with the capture input: "3 · 2 pc"
  // is the count that is here and the count that is waiting, named by where.
  const parts = Object.keys(where).sort().map(d => `${where[d]} ${d}`);
  return `Clarify ${here} · ${parts.join(' ')}`;
}

function renderInbox() {
  // The inbox is the capture bar's live count now; processing is the Clarify
  // sheet (openClarify). Callers that used to repaint the queue just bump N.
  const el = document.getElementById('eg-clarify');
  if (el) el.textContent = clarifyBarLabel();
}


// ── Utilities ────────────────────────────────────────────────

// Weekday names live in common.js's WEEKDAYS (Monday-first, with weekdayOf).
const _MONTHS_SHORT   = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _MONTHS_LONG    = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];


// Tiny markdown for project notes (support material is written in prose, so
// plain <pre> text wasted it). Escape FIRST, then decorate — the input is
// user text, never trusted HTML. Line-level: # ## ### headings, - and 1.
// lists, blank-line paragraphs. Inline: **bold**, *italic*, `code`,
// [text](http/https url). That's the whole grammar; anything fancier belongs
// in a real document, not a notes field.
function mdHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(src).split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3}) +(.*)/);
    const li = line.match(/^[-*] +(.*)/);
    const ol = line.match(/^\d+[.)] +(.*)/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (li || ol) {
      const kind = li ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((li || ol)[1])}</li>`);
    }
    else if (!line.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join('');
}

function nowTimeStr() {
  const now = new Date();
  return now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
}


function isoToAmPm(isoStr) {
  const d = new Date(isoStr);
  const h = d.getHours(), m = d.getMinutes();
  const period = h < 12 ? 'am' : 'pm';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')}${period}`;
}

function hhmmToAmPm(hhmmStr) {
  const [h, m] = hhmmStr.split(':').map(Number);
  const period = h < 12 ? 'am' : 'pm';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')}${period}`;
}

// An ISO instant's local minute of the day — one helper, where three
// surfaces each carried their own copy.
function isoMin(iso) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

// A day's timed events as the day draws them: the feed, minus what was
// dismissed from that day. Engage's agenda and clarify's calendar picker ask
// the same question, so they ask it here.
function dayTimedEvents(date) {
  return state.gcalEvents.filter(e => !e.allday && sameDay(date, e.start)
    && !state.tlHidden.event[eventKey(e)]);
}

function sameDay(date, isoStr) {
  const d = new Date(isoStr);
  return d.getFullYear() === date.getFullYear() &&
    d.getMonth() === date.getMonth() &&
    d.getDate() === date.getDate();
}

function isToday(date) {
  return sameDay(date, new Date().toISOString());
}

function formatDateLabel(date) {
  return `${weekdayOf(date).name} ${_MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
}


// ── WHICH DAY (2026-08-17) ───────────────────────────────────
//
// "Today" is three different questions with three different right answers,
// and they were all written `formatDateYMD(new Date())`, so the call site
// could not show which one was meant. That is not a naming nicety: it is the
// single confusion behind the pawn filed under tomorrow, the habit marks that
// landed on the wrong day, the tag answers, and the night run that restarted
// at 00:05. In ONE handler the journal PATCH was right and the habit marks
// six lines above were wrong, because both read identically.
//
//   wallDay()  what time is it NOW — clock ticks, rollover, salience, and
//              "is the thing I'm looking at today?" comparisons.
//   viewDay()  what the user is LOOKING AT — the timeline's day. Never the
//              day a write is filed under; you can browse to next Tuesday.
//
// (runDay(), what a RUNNER's work belonged to, pinned across midnight, went
// with the runner on 2026-10-05.)
//
// The rule: a write picks the day deliberately. If a new write reaches for
// wallDay(), that has to be because the fact really is about the clock.
// (wallDay and formatDateYMD are common.js's: every document asks it.)
function viewDay() {
  return formatDateYMD(state.currentDate);
}

function formatTodoDate(date) {
  return `${weekdayOf(date).long}, ${_MONTHS_LONG[date.getMonth()]} ${date.getDate()}`;
}

function formatTime12(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function rgbaColor(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Settings — index → section → sheet (11a) ─────────────────
//
// Ported from Claude Design (project 82343144-9c74-405a-8a03-5d1a2c5b82c7,
// file `GTD Panel Layouts.dc.html`, panel 11a). Three surfaces, one grammar:
//
//   index    every row names a section AND says its current state
//   section  a plain list with one add affordance; back is the only navigation
//   sheet    adding and editing raise the SAME sheet, with its own Save, so a
//            form never sits inside the section's scroll
//
// What this replaced spent two wrapping rows of tabs on navigation and then
// switched grammar for every form — floating label column, seven wrapping
// checkboxes, a card inside a scroll inside a panel. Now each list row is
// `text + meta + ›` and each form is ONE object (#se-sheet) declared by a
// SETTINGS_SHEETS entry, which is the rule the rest of the app already
// follows (see "Direction — list datatypes decide in a sheet, not on the row").

// 10 muted pastels, shared by the block and calendar color pickers
const BLOCK_COLORS = [
  '#d9a3a8', '#d9b48f', '#d8cb96', '#adc9a0', '#93cbb4',
  '#8fc6cf', '#98b9dd', '#a9a9dd', '#c3a6d8', '#d5a3c8',
];
// Day names and the MTWRFSU letters are common.js's WEEKDAYS (2026-10-05).

// Which section is open; null is the index. The sheet has its own state below.
const settingsView = { section: null };

// SETTINGS IS A COLUMN (2026-10-05, Quentin's instruction, replacing the
// one-scroll page of 2026-10-01): on a wide window it docks at the right
// (.dock-panel) beside whatever page is up, so on every width it reads the
// phone's way — the index, then one section. The 900px query stays: Lists'
// preview and the Log page still ask it.
const SETTINGS_WIDE = window.matchMedia('(min-width: 900px)');


// What the index rows report. Each section's renderer sets its own key as it
// paints, so a summary can never claim a count its list doesn't show.
const beCounts = {};

function plural(n, word) {
  n = n || 0;
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// The index IS this table: row, one-line description and current-state
// summary in one place, so a new section can't ship with a row but no heading.
const SETTINGS_SECTIONS = [
  { key: 'today', name: 'Today', group: 'You',
    desc: "Today's answers: your metrics, the journal, and the context questions. "
      + 'Tap an answer again to clear it.',
    summary: () => {
      const due = (trackingView.metrics || []).filter(m => m.due);
      const done = due.filter(m => todayEntry(m)).length;
      return due.length ? `${done}/${due.length} answered` : '';
    } },
  { key: 'tracking', name: 'Tracking', group: 'You',
    desc: 'What your metrics have said, habits and experiments.',
    summary: () => plural((trackingView.metrics || []).filter(m => m.answered).length, 'metric') },
  { key: 'blocks', name: 'Blocks', group: 'Your week',
    desc: 'Recurring windows the day is built around.',
    summary: () => `${beCounts.blocks || 0} set` },
  { key: 'times', name: 'Times', group: 'Your week',
    desc: 'Rules are single patterns. Schedules gather rules, or follow something else.',
    summary: () => plural(beCounts.times, 'schedule') },
  { key: 'recurring', name: 'Recurring', group: 'Your week',
    desc: 'Tasks and projects that come back on a schedule.',
    summary: () => plural(beCounts.recurring, 'task') },
  { key: 'occasions', name: 'Occasions', group: 'Your week',
    desc: 'Actions that arrive with a kind of calendar event.',
    summary: () => plural(beCounts.occasions, 'occasion') },
  { key: 'areas', name: 'Areas', group: 'Where and what',
    desc: 'The areas of your life.',
    summary: () => String(beCounts.areas || 0) },
  { key: 'locations', name: 'Locations', group: 'Where and what',
    desc: 'Places a gate or a context tag can be pinned to.',
    summary: () => String(beCounts.locations || 0) },
  { key: 'qr', name: 'Gates', group: 'Where and what',
    desc: 'Every gate: its settings, the day, the money and the record.',
    summary: () => plural(beCounts.qr, 'gate') },
  { key: 'metrics', name: 'Metrics', group: 'Where and what',
    desc: 'The questions you track about yourself. Answered in Today, read back in Tracking.',
    summary: () => plural((metricsView.all || []).filter(m => m.active).length, 'metric') },
  { key: 'calendars', name: 'Calendars', group: 'App',
    desc: 'iCal feeds drawn on the timeline.',
    summary: () => `${beCounts.calendars || 0} connected` },
  { key: 'config', name: 'Connections', group: 'App',
    desc: 'Accounts, keys and paths the app talks to the outside world with. '
      + 'Stored in config.json on the server, never in the database.',
    summary: () => `${configView.rows.filter(r => r.secret ? r.set : r.value).length}`
      + `/${configView.rows.length || CONFIG_ROW_COUNT} set` },
  { key: 'about', name: 'About', group: 'App',
    desc: 'What this is, and the link that reaches it.',
    summary: () => (aboutView.url || state.settings.app_url || '')
      .replace(/^https?:\/\//, '') || 'not known yet' },
  { key: 'display', name: 'Display', group: 'App',
    desc: 'Theme, timezone, and the NOW panel.',
    summary: () => `${document.documentElement.classList.contains('theme-light') ? 'Light' : 'Dark'}`
      + ` · ${currentTimezone().split('/').pop().replace(/_/g, ' ')}` },
  { key: 'assistant', name: 'AI changes', group: 'Appendix',
    desc: 'Every gate deadline and block an assistant changed, with the reason it gave — refusals too.',
    summary: () => (assistantView.rows ? plural(assistantView.rows.length, 'change') : '') },
];

// ── Appendix: what an assistant changed ─────────────────────
//
// The Claude Code tools (mcp/gates_mcp.py, mcp/blocks_mcp.py) may change
// gate DEADLINES and the BLOCK SCHEDULE and mark every write; the server
// refuses anything else and logs each attempt. This is
// that log, read-only, in words — the record of what was done on Quentin's
// behalf, so nothing an assistant did is invisible.
const assistantView = { rows: null };

async function loadAssistantChanges() {
  renderAssistantChanges();
  const rows = await apiGet('/api/assistant/changes', assistantView.rows);
  assistantView.rows = Array.isArray(rows) ? rows : assistantView.rows;
  renderAssistantChanges();
}

function assistantChangeText(r) {
  let body = {};
  try { body = JSON.parse(r.body || '{}') || {}; } catch (e) { body = {}; }
  const m = /\/api\/accountability\/nodes\/(\d+)(?:\/overrides(?:\/(\d{4}-\d{2}-\d{2}))?)?$/.exec(r.path);
  const node = m && (state.accountabilityNodes || []).find(n => String(n.id) === m[1]);
  const gate = m ? `"${node ? node.label : `gate ${m[1]}`}"` : '';
  if (r.path === '/api/schedules') return 'wrote a weekly schedule';
  if (m && m[2]) return `put ${gate} back to its schedule on ${m[2]}`;
  if (m && r.path.endsWith('/overrides')) {
    return body.skipped ? `called off ${gate} on ${body.date}`
      : `moved ${gate} on ${body.date} to ${body.window_start}–${body.window_end}`
        + (body.window_end_offset_days ? ' +1d' : '');
  }
  const fields = Object.keys(body).filter(k => k !== 'effective_from');
  if (m && fields.length === 1 && fields[0] === 'source_uid') {
    return `pointed ${gate} at a new schedule`
      + (body.effective_from ? ` from ${body.effective_from}` : '');
  }
  const bt = assistantBlockText(r, body);
  if (bt) return bt;
  // Anything else is what the guard refuses: say what was ATTEMPTED.
  if (m) return `tried to change ${fields.join(', ') || 'nothing'} on ${gate}`;
  if (r.path === '/api/gates/billing') return `tried to change billing (${fields.join(', ')})`;
  return `tried ${r.method} ${r.path}`;
}

// The block tool's writes, in the same words (2026-09-30). A block deleted
// since is named by its id, the one thing the log still knows about it.
function assistantBlockText(r, body) {
  const bm = /^\/api\/blocks(?:\/(\d+)(?:\/scheduled\/(\w+))?)?$/.exec(r.path);
  const ov = /^\/api\/overrides(?:\/(\d+))?$/.exec(r.path);
  if (!bm && !ov) return null;
  const idOf = bm ? bm[1] : body.block_id;
  const b = (state.blocks || []).find(x => String(x.id) === String(idOf));
  const name = `"${b ? b.label : `block ${idOf}`}"`;
  const when = body.effective_from ? ` from ${body.effective_from}` : '';
  if (ov) {
    if (ov[1]) return "put a block's day back to its week";
    return body.cancelled ? `cancelled ${name} on ${body.date}`
      : `set ${name} to ${body.start_time}–${body.end_time} on ${body.date}`;
  }
  if (!bm[1]) {
    return `added "${body.label}" on ${(body.days || []).map(weekdayName).join(', ')} `
      + `${body.start_time}–${body.end_time}`;
  }
  if (bm[2]) return `called off the scheduled ${bm[2]} change on ${name}`;
  if (r.method === 'DELETE') return `deleted ${name}`;
  const fields = Object.keys(body).filter(k => k !== 'effective_from');
  if (fields.length === 1 && fields[0] === 'active') {
    return `${body.active ? 'resumed' : 'paused'} ${name}${when}`;
  }
  // A change made NOW sends the whole row, so it reads as where the block
  // went; a DATED one sends only what moves, so it names each field.
  if (!body.effective_from && body.start_time && body.end_time) {
    return `changed ${name} to ${weekdayName(body.day_of_week) || ''} ${body.start_time}–${body.end_time}`;
  }
  const what = fields.map(k => k === 'day_of_week' ? `day ${weekdayName(body[k])}`
    : `${k.replace(/_time$/, '').replace(/_id$/, '')} ${body[k] == null ? 'none' : body[k]}`);
  return `changed ${name}${what.length ? ` (${what.join(', ')})` : ''}${when}`;
}

function renderAssistantChanges() {
  const el = document.getElementById('be-assistant');
  if (!el) return;
  const rows = assistantView.rows;
  if (rows == null) { el.innerHTML = emptyHtml('Loading…'); return; }
  if (!rows.length) {
    el.innerHTML = '<div class="empty">Nothing yet. When an assistant changes a gate deadline'
      + ' or a block through the Claude Code tools, it is listed here with its reason.</div>';
    return;
  }
  el.innerHTML = rows.map(r => `<div class="be-set-row be-ai-row">
      <div class="be-ai-main">
        <div class="be-set-name">${r.status >= 400 ? '✗ refused: ' : ''}${escHtml(assistantChangeText(r))}</div>
        <div class="be-hint">${escHtml(r.created_at)}${r.reason ? ' · “' + escHtml(r.reason) + '”' : ''}</div>
      </div>
    </div>`).join('');
}

// ── About ────────────────────────────────────────────────────
//
// One job: hand over the stable link. The desktop window runs on 127.0.0.1 and
// the phone reaches the tailnet name, so the address you are ON is usually not
// the address to SEND — which is why the link is config (`app_url`) and not
// location.origin. Both are shown: a mismatch is the normal case, and seeing
// them side by side is how you tell "I'm on the local window" from "the link
// is wrong".
//
// Read-only, so no SETTINGS_SHEETS entry and none of the three verbs. Tapping
// copies, because selecting text on a phone to copy a URL is not a gesture.
const aboutView = { url: '', source: '' };

async function loadAbout() {
  renderAbout();                          // paint what is already known
  const a = await apiGet('/api/about', null);
  if (a) { aboutView.url = a.url || ''; aboutView.source = a.source || ''; }
  renderAbout();
}

function renderAbout() {
  const el = document.getElementById('be-about');
  if (!el) return;
  const link = aboutView.url || state.settings.app_url || '';
  const here = location.origin;
  const sameAsHere = link && link.replace(/\/$/, '') === here.replace(/\/$/, '');
  el.innerHTML = `
    <div class="be-set-row be-about-row">
      <span class="be-set-name">App link</span>
      ${link
        ? `<span class="be-nav-value">${escHtml(aboutView.source || '')}</span>
           <button class="be-btn-secondary" id="be-about-copy">Copy</button>`
        : `<span class="be-nav-value">not known yet</span>`}
    </div>
    <div class="cl-hint be-about-link">${link
      ? escHtml(link)
      : 'Found by itself once you open the app over the tailnet, or from '
        + '<code>tailscale</code> on the server. Until then you can set '
        + '<strong>App URL</strong> in Connections.'}</div>
    <div class="be-set-row be-about-row">
      <span class="be-set-name">Reached now at</span>
      <span class="be-nav-value">${escHtml(here.replace(/^https?:\/\//, ''))}</span>
    </div>
    <div class="cl-hint">${link && !sameAsHere
      ? 'Different from the link above, which is normal on the desktop window — '
        + 'the link is what you send to a phone or an iPad.'
      : link ? 'Same as the link above.'
      : 'This is the address this window happens to be on, not necessarily one '
        + 'another device can reach.'}</div>
    ${aboutView.source === 'from tailscale' ? `
    <div class="cl-hint">Read from <code>tailscale</code> on the machine running
      this — right if that machine is the one serving the app, worth checking if
      you are running a local copy. It corrects itself the first time you open
      the app over the tailnet.</div>` : ''}
    <div class="be-set-row be-about-row">
      <span class="be-set-name">Data lives on</span>
      <span class="be-nav-value">the server, not this device</span>
    </div>
    <div class="cl-hint">Any device on the tailnet reaches the same day. There is
      no login: being on the tailnet IS the access.</div>`;
  const copy = el.querySelector('#be-about-copy');
  if (copy) {
    copy.addEventListener('click', () => {
      copyAndSay(link, 'App link');
    });
  }
}

// EVERY DOWNLOAD GOES THROUGH HERE, and lands in the Downloads folder
// (2026-09-23, Quentin's instruction). In the desktop window the file is handed
// to the window's own save_download, which writes it into ~/Downloads with no
// dialog; anywhere else — a browser, the phone — it is an ordinary download,
// which the browser files in Downloads by itself. Returns the path when it
// knows one.
async function saveDownload(name, text, type) {
  const api = window.pywebview && window.pywebview.api;
  if (api && api.save_download) return api.save_download(name, text);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return null;
}

// (copyText — with the execCommand fallback that works off localhost — and
// copyAndSay are common.js's, shared with the gates dashboard's key sheet.)

// ── Connections (config.json) ────────────────────────────────
//
// The server hands back VALUES for ordinary keys and, for a secret, only
// whether one is set. So the secret field is always empty here — there is
// nothing to put in it — and empty therefore has to mean "leave it alone",
// or opening this page and saving anything would wipe the token that charges
// real money. Clearing one is its own button.
const configView = { rows: [], status: '' };
const CONFIG_ROW_COUNT = 9;

async function loadConfigRows() {
  configView.rows = await apiGet('/api/config', configView.rows);
  renderConfig();
}

function renderConfig() {
  const el = document.getElementById('be-config-list');
  if (!el) return;
  el.innerHTML = configView.rows.map(r => `
    <div class="be-set-row be-config-row">
      <span class="be-set-name">${escHtml(r.label)}</span>
      <input type="${r.secret ? 'password' : 'text'}" class="be-config-input" data-ckey="${r.key}"
        autocomplete="off" ${r.secret ? 'placeholder="' + (r.set ? 'set — type to replace' : 'not set') + '"'
          : `value="${escHtml(r.value || '')}"`}>
      <button class="be-btn-secondary be-config-save" data-ckey="${r.key}">Save</button>
      ${(r.secret ? r.set : r.value)
        ? `<button class="be-btn-secondary be-config-clear" data-ckey="${r.key}"
             title="Remove this value">Clear</button>` : ''}
      <span class="be-config-hint">${escHtml(r.hint || '')}</span>
    </div>`).join('');
  const status = document.getElementById('be-config-status');
  if (status) status.textContent = configView.status;

  const save = async (key, value) => {
    configView.status = 'Saving…';
    renderConfig();
    const res = await apiSend('/api/config', 'PATCH', { [key]: value }).catch(() => null);
    if (!res || !res.ok) {
      configView.status = `Could not save (${res ? res.status : 'no connection'})`;
      renderConfig();
      return;
    }
    configView.rows = await res.json();
    const spec = configView.rows.find(r => r.key === key) || {};
    configView.status = `${spec.label || key} saved`;
    renderConfig();
    // Not undoable, like every other config surface — and a secret has no
    // previous value to put back, since nothing ever read it out.
    toast(`${spec.label || key} saved`);
  };

  el.querySelectorAll('.be-config-save').forEach(b => b.addEventListener('click', () => {
    const input = el.querySelector(`.be-config-input[data-ckey="${b.dataset.ckey}"]`);
    const row = configView.rows.find(r => r.key === b.dataset.ckey) || {};
    const v = input.value.trim();
    if (row.secret && !v) { configView.status = 'Nothing typed — the stored value is unchanged.'; renderConfig(); return; }
    save(b.dataset.ckey, v);
  }));
  el.querySelectorAll('.be-config-clear').forEach(b => b.addEventListener('click', () => {
    save(b.dataset.ckey, '__clear__');
  }));
}

function renderSettingsIndex() {
  const el = document.getElementById('be-index');
  if (!el) return;
  let group = null;
  el.innerHTML = SETTINGS_SECTIONS.map(s => {
    const head = s.group === group ? '' : `<div class="be-idx-group">${escHtml(s.group)}</div>`;
    group = s.group;
    return `${head}<button class="be-nav-row" data-section="${s.key}">
      <span class="be-nav-name">${escHtml(s.name)}</span>
      <span class="be-nav-value">${escHtml(s.summary())}</span>
      <span class="be-chev">›</span>
    </button>`;
  }).join('');
  el.querySelectorAll('[data-section]').forEach(btn => {
    btn.addEventListener('click', () => openSettingsSection(btn.dataset.section));
  });
}

function openSettingsSection(key) {
  settingsView.section = key;
  paintSettingsNav();
  if (key === 'times') renderSchedules();
  // Read fresh every time: another session (or an ssh edit) may have changed
  // the file, and a stale "not set" next to a token is the worst thing this
  // page could say.
  if (key === 'config') { configView.status = ''; loadConfigRows(); }
  if (key === 'metrics') loadMetrics().then(renderMetricsSettings);
  if (key === 'about') loadAbout();
  if (key === 'assistant') loadAssistantChanges();
  if (key === 'tracking') openTracking();
  if (key === 'today') refreshTracking();
  if (key === 'qr') mountGatesFrame();
}

function backToSettingsIndex() {
  closeSeSheet();
  settingsView.section = null;
  renderSettingsIndex();
  paintSettingsNav();
}

function paintSettingsNav() {
  const inSection = settingsView.section != null;
  const sec = SETTINGS_SECTIONS.find(s => s.key === settingsView.section);
  document.getElementById('be-index').classList.toggle('hidden', inSection);
  document.getElementById('be-panes').classList.toggle('hidden', !inSection);
  document.getElementById('be-back').classList.toggle('hidden', !inSection);
  document.getElementById('be-title').classList.toggle('hidden', inSection);
  document.getElementById('be-sec-title').textContent = sec ? sec.name : '';
  syncRoute();
  document.getElementById('be-sec-desc').textContent = sec ? sec.desc : '';
  document.querySelectorAll('#be-panes .be-section').forEach(s =>
    s.classList.toggle('active', s.dataset.betabPanel === settingsView.section));
  document.getElementById('be-panes').scrollTop = 0;
}

// ── The sheet ────────────────────────────────────────────────
//
// One object for every settings datatype. A SETTINGS_SHEETS entry declares
// what the fields are (`fields`), what an existing row loads into them
// (`load`), what an empty one starts from (`blank`), what Save does (`submit`,
// which returns an error string or null) and, where the API allows it, what
// Delete does (`remove`). Values are held here rather than read off the DOM at
// submit time, so a field that only exists for some other field's value
// (Recurring's day keys, a gate's per-day windows) can re-render freely.

const seSheet = { kind: null, item: null, values: null, error: '', returnTo: null };

// `returnTo` is what a sheet opened FROM another sheet hands back to. The
// gate-tag sheet hard-codes its way home because it has exactly one door; a
// routine has two (its gate, or Settings → Recurring), so the door it came
// through is passed in rather than guessed.
// `seed` fills a NEW item's blank with what the door already knows — a time
// added from a block category arrives with that category's name and colour.
function openSeSheet(kind, item, returnTo, seed) {
  const spec = SETTINGS_SHEETS[kind];
  seSheet.kind = kind;
  seSheet.item = item || null;
  seSheet.returnTo = returnTo || null;
  seSheet.values = item ? spec.load(item) : { ...spec.blank(), ...(seed || {}) };
  seSheet.error = '';
  // Folded on open: the steps are for the one evening you program a tag, not
  // for every visit to the gate that uses it.
  seSheet.infoOpen = {};
  showSheet('se-sheet');
  // The LAYER is the sheet, not the instance: a sheet handing over to another
  // sheet (a gate's routine, a gate's tag) is still one thing raised over the
  // index, so it must not stack a second time and need closing twice.
  //
  // AND THE HOST IS NOT ASSUMED. `be-sheet-open` dims the settings modal
  // behind the sheet, which is the right thing when the sheet was opened from
  // the settings index and meaningless when it was opened from the calendar.
  // The sheet itself is `position: fixed` and lives outside the modal in the
  // DOM, so it never needed the modal — only this one class did.
  if (!overIsOpen('se-sheet')) {
    const modal = document.getElementById('modal-overlay');
    const hosted = modal && !modal.classList.contains('hidden');
    openOver('se-sheet', hosted ? {
      raise: () => document.getElementById('block-editor-modal').classList.add('be-sheet-open'),
      lower: () => document.getElementById('block-editor-modal').classList.remove('be-sheet-open'),
    } : {});
  }
  renderSeSheet();
  if (spec.onOpen) spec.onOpen(item);
  const first = document.querySelector('#se-sheet .se-input');
  if (first && !seSheet.item) first.focus();
}

function closeSeSheet() {
  seSheet.kind = null;
  seSheet.item = null;
  seSheet.values = null;
  seSheet.returnTo = null;
  hideSheet('se-sheet');
  closeOver('se-sheet');
}

// A SETTINGS SHEET IS ALWAYS INNERMOST among what opens it. It is z-200
// against the read-out's 190, and a gate's sheet opens FROM the read-out, so
// checking the popup first would close the surface the open sheet is standing
// on. Settings peels the way it navigates (11a): sheet, section, panel.
defineSheet('se-sheet', { rank: 10, isOpen: () => !!seSheet.kind, close: closeSeSheet });

function seFieldHtml(f, v) {
  // A DISCLOSURE, not a tooltip: there is no hover on a phone, so the ⓘ is a
  // full-width button and the steps open in place, under the row they are
  // about. Open state lives on seSheet so a re-render (any field change
  // repaints the whole sheet) does not fold it shut mid-read.
  if (f.kind === 'info') {
    const open = !!(seSheet.infoOpen || {})[f.key];
    const body = !open ? '' : `<div class="se-info-body">${f.sections.map(sec => `
      <div class="se-info-h">${escHtml(sec.h)}</div>
      <ol class="se-info-list" start="${sec.start}">${sec.items.map(it => `
        <li>${escHtml(it.t)}
          ${it.code ? `<code class="se-info-code">${escHtml(it.code)}</code>` : ''}
          ${it.sub ? `<ul class="se-info-sub">${it.sub.map(x =>
            `<li>${escHtml(x)}</li>`).join('')}</ul>` : ''}
        </li>`).join('')}</ol>`).join('')}</div>`;
    return `<div class="se-field se-info">
      <button type="button" class="se-info-btn" data-f="${f.key}" aria-expanded="${open}">
        <span class="se-info-i">ⓘ</span>
        <span class="se-info-t">${escHtml(f.text)}</span>
        <span class="be-chev">${open ? '⌄' : '›'}</span>
      </button>${body}</div>`;
  }
  const label = `<span class="se-flabel">${escHtml(f.label)}</span>`;
  const val = v[f.key];
  let control = '';
  if (f.kind === 'static') {
    control = `<div class="se-static${f.mono ? ' se-mono' : ''}">${escHtml(f.text)}</div>`;
  } else if (f.kind === 'openpicker') {
    // The row states the schedule in words and hands the editing to the picker.
    // A consumer never grows fields of its own for "when does this run".
    control = `<button type="button" class="se-openpicker" data-f="${f.key}">
      <span>${escHtml(f.text || 'not set')}</span><span class="be-chev">›</span></button>`;
  } else if (f.kind === 'action') {
    // A state the sheet can only clear, not edit — a gate's today-only window.
    control = `<div class="se-static${f.mono ? ' se-mono' : ''}">${escHtml(f.text)}</div>`
      + `<button type="button" class="se-inline-act" data-f="${f.key}">${escHtml(f.action)}</button>`;
  } else if (f.kind === 'geocode') {
    // AN ADDRESS INSTEAD OF A TYPED LATITUDE. Two ways in, and the second is
    // the better one: "Here" takes the fix the ⌖ filter already keeps, which is
    // exact for a place you are standing in and sends no address to anyone.
    // The search is the fallback for somewhere you are NOT, and it goes to
    // OpenStreetMap — so the query leaves this machine, which is why the two
    // are offered side by side rather than search alone.
    //
    // Results are painted straight into .se-geo-out, never by re-rendering the
    // sheet: a repaint would take the field being typed in with it.
    control = `<div class="se-geocode" data-f="${f.key}">
      <div class="se-geo-row">
        <input class="se-input se-geo-q" type="search" autocomplete="off"
          placeholder="${escHtml(f.placeholder || 'search an address…')}">
        <button type="button" class="se-inline-act se-geo-go">Search</button>
        <button type="button" class="se-inline-act se-geo-here"
          title="Use this device's current position — exact, and nothing leaves the machine">Here</button>
      </div>
      <div class="se-geo-out"></div>
    </div>`;
  } else if (f.kind === 'select') {
    // WHAT IT SHOWS IS WHAT IT HOLDS. A <select> whose value matches none of
    // its options still DRAWS the first one, so a blank required field looked
    // filled in: adding a recurring task showed "Area: General", refused the
    // save with "Name, area and start date are required", and there was
    // nothing on screen to act on — the field it was complaining about was
    // visibly answered. Rather than fix that one sheet, the renderer now
    // prepends a placeholder whenever the model's value is not on offer, so
    // the control cannot claim an answer nobody gave.
    const opts = f.options(v);
    const missing = !opts.some(o => String(o.value) === String(val == null ? '' : val));
    const all = missing
      ? [{ value: val == null ? '' : val, name: f.placeholder || '— pick one —' }].concat(opts)
      : opts;
    control = `<select class="se-input se-select" data-f="${f.key}">${all.map(o =>
      `<option value="${escHtml(String(o.value))}"${String(o.value) === String(val) ? ' selected' : ''}>${escHtml(o.name)}</option>`
    ).join('')}</select>`;
  } else if (f.kind === 'swatches') {
    // `clearable` puts NO COLOUR on the row as a chip of its own. A field
    // whose blank state is a real answer needs a way back to it, and a
    // swatch row otherwise only ever moves one way.
    control = `<div class="se-swatches" data-f="${f.key}">${(f.clearable
      ? [`<button type="button" class="se-swatch se-swatch-none${val ? '' : ' se-on'}" data-color="" title="No colour">×</button>`]
      : []).concat(BLOCK_COLORS.map(c =>
      `<button type="button" class="se-swatch${c === val ? ' se-on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`
    )).join('')}</div>`;
  } else if (f.kind === 'days') {
    control = weekdayToggles(val, { wrapAttrs: `data-f="${f.key}"` });
  } else if (f.kind === 'check') {
    control = `<button type="button" class="chip se-check${val ? ' on' : ''}" data-f="${f.key}">${
      escHtml(val ? f.on : f.off)}</button>`;
  } else if (f.kind === 'weekly') {
    // A gate's per-day windows: only the days the gate runs on get a row, and
    // a day that matches the defaults above is not stored at all.
    control = `<div class="se-weekly" data-f="${f.key}">${v.days.slice().sort().map(i => {
      const w = val[i] || { start: v.start, end: v.end, offset: v.offset };
      return `<div class="se-wk-row" data-dow="${i}">
        <span class="se-wk-day">${weekdayName(i)}</span>
        <input type="time" class="se-input se-wk-start" value="${escHtml(w.start || '')}">
        <span class="se-wk-sep">–</span>
        <input type="time" class="se-input se-wk-end" value="${escHtml(w.end || '')}">
        <button type="button" class="chip chip-sm se-wk-off${w.offset ? ' on' : ''}">+1d</button>
      </div>`;
    }).join('')}</div>`;
  } else if (f.kind === 'textarea') {
    control = `<textarea class="se-input se-textarea" data-f="${f.key}" rows="3"`
      + `${f.placeholder ? ` placeholder="${escHtml(f.placeholder)}"` : ''}>${
        escHtml(String(val == null ? '' : val))}</textarea>`;
  } else {
    control = `<input class="se-input${f.kind === 'time' || f.kind === 'number' ? ' se-mono' : ''}"`
      + ` type="${f.kind}" data-f="${f.key}" value="${escHtml(String(val == null ? '' : val))}"`
      + `${f.placeholder ? ` placeholder="${escHtml(f.placeholder)}"` : ''}`
      + `${f.min != null ? ` min="${f.min}"` : ''}${f.step ? ` step="${f.step}"` : ''} autocomplete="off">`;
  }
  const hint = f.hint ? `<span class="se-fhint">${escHtml(f.hint)}</span>` : '';
  const suffix = f.suffix ? `<span class="se-fsuffix">${escHtml(f.suffix)}</span>` : '';
  return `<div class="se-field${f.half ? ' se-half' : ''}">${label}
    <div class="se-frow">${control}${suffix}</div>${hint}</div>`;
}

// The foot of a sheet is where a phone keyboard sits, so an error rendered
// only there reads as a dead button. Same rule as everywhere else: toast it.
function seSheetRefuse(msg) {
  seSheet.error = msg;
  if (msg) toast(msg);
  renderSeSheet();
}

function renderSeSheet() {
  const spec = SETTINGS_SHEETS[seSheet.kind];
  const v = seSheet.values;
  const fields = spec.fields(v, seSheet.item);
  // Two consecutive half fields share a line (From/To, Area/Location).
  let body = '';
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].half && fields[i + 1] && fields[i + 1].half) {
      body += `<div class="se-pair">${seFieldHtml(fields[i], v)}${seFieldHtml(fields[i + 1], v)}</div>`;
      i++;
    } else {
      body += seFieldHtml(fields[i], v);
    }
  }
  const el = document.getElementById('se-sheet');
  el.innerHTML = `
    <div class="se-grab"><span></span></div>
    <div class="se-head">
      <span class="se-title">${escHtml(spec.title(seSheet.item))}</span>
      <button class="se-cancel">Cancel</button>
    </div>
    <div class="se-body">${body}</div>
    <div class="se-foot">
      ${seSheet.error ? `<div class="se-error">${escHtml(seSheet.error)}</div>` : ''}
      <button class="se-save">${escHtml(spec.save(seSheet.item))}</button>
      ${spec.remove && seSheet.item && (!spec.canRemove || spec.canRemove(seSheet.item))
        ? `<button class="se-del">${escHtml(
            (typeof spec.removeLabel === 'function'
              ? spec.removeLabel(seSheet.item) : spec.removeLabel) || 'Delete')}</button>` : ''}
    </div>`;
  wireSeSheet(fields);
}

function wireSeSheet(fields) {
  const el = document.getElementById('se-sheet');
  const v = seSheet.values;
  el.querySelector('.se-cancel').addEventListener('click', closeSeSheet);
  el.querySelector('.se-save').addEventListener('click', submitSeSheet);
  const del = el.querySelector('.se-del');
  if (del) del.addEventListener('click', removeSeItem);

  fields.forEach(f => {
    const wrap = el.querySelector(`[data-f="${f.key}"]`);
    if (!wrap) return;
    if (f.kind === 'info') {
      wrap.addEventListener('click', () => {
        seSheet.infoOpen = seSheet.infoOpen || {};
        seSheet.infoOpen[f.key] = !seSheet.infoOpen[f.key];
        renderSeSheet();
      });
    } else if (f.kind === 'openpicker') {
      // THE TWO HOOKS TAKE DIFFERENT THINGS, and it has bitten once: `open`
      // gets the DRAFT (a picker writes back into the values you are editing),
      // `run` gets the ITEM (an action row acts on the saved row). A row that
      // needs the other one reaches for seSheet.values / seSheet.item by name
      // rather than renaming its parameter and hoping.
      wrap.addEventListener('click', () => f.open(v, seSheet.item));
    } else if (f.kind === 'action') {
      wrap.addEventListener('click', async () => {
        await f.run(seSheet.item, v);
        // Most action rows CLEAR something and are done with the sheet. A row
        // that opens another sheet instead says so, or the close below would
        // shut the sheet it just opened — one sheet at a time, and this is how
        // one hands over to the next.
        if (f.keepOpen) return;
        closeSeSheet();
        renderSettingsIndex();
      });
    } else if (f.kind === 'geocode') {
      const out = wrap.querySelector('.se-geo-out');
      const q = wrap.querySelector('.se-geo-q');
      const say = html => { out.innerHTML = html; };
      // Writing through the INPUT rather than straight into `v` keeps one path
      // to the value: the field's own handler stores it, so a picked address
      // and a typed one land the same way and cannot disagree.
      const setField = (key, value) => {
        const input = el.querySelector(`input[data-f="${key}"]`);
        if (input) {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          v[key] = value;
        }
      };
      const pick = (name, lat, lng, label) => {
        setField('lat', lat);
        setField('lng', lng);
        const nameInput = el.querySelector('input[data-f="name"]');
        if (nameInput && !nameInput.value.trim()) setField('name', name);
        // The SHORT name, with the full address as the tooltip: a whole OSM
        // display_name is three lines of county and postcode on a phone.
        say(`<div class="se-geo-picked" title="${escHtml(label || name)}">✓ ${escHtml(name)}
          <span class="se-geo-coords">${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}</span></div>
          <div class="se-hint">The name is yours to rewrite — it is only a suggestion.</div>`);
      };
      const search = async () => {
        const term = q.value.trim();
        if (!term) return;
        say('<div class="se-hint">searching…</div>');
        try {
          const res = await fetch(`/api/geocode?q=${encodeURIComponent(term)}`);
          const data = await res.json();
          if (!res.ok) { say(`<div class="se-error">${escHtml(data.error || 'lookup failed')}</div>`); return; }
          if (!data.length) { say('<div class="se-hint">nothing found — try a fuller address</div>'); return; }
          say(`<div class="se-geo-list">${data.map((r, i) => `
            <button type="button" class="se-geo-hit" data-i="${i}">
              <span class="se-geo-name">${escHtml(r.name)}</span>
              <span class="se-geo-label">${escHtml(r.label)}</span>
            </button>`).join('')}</div>`);
          out.querySelectorAll('.se-geo-hit').forEach(b => b.addEventListener('click', () => {
            const r = data[parseInt(b.dataset.i)];
            pick(r.name, r.lat, r.lng, r.label);
          }));
        } catch (e) {
          say('<div class="se-error">lookup failed — no network?</div>');
        }
      };
      wrap.querySelector('.se-geo-go').addEventListener('click', search);
      q.addEventListener('keydown', e => {
        // Enter searches; it must not submit the sheet, which would save a
        // location with no coordinates yet.
        if (e.key === 'Enter') { e.preventDefault(); search(); }
      });
      wrap.querySelector('.se-geo-here').addEventListener('click', () => {
        if (state.geo && state.geo.ok) {
          pick('Here', state.geo.lat, state.geo.lng, 'this device’s current position');
          return;
        }
        say('<div class="se-hint">no fix yet — enable location for this site, or search an address</div>');
        initGeo();
      });
    } else if (f.kind === 'select') {
      wrap.addEventListener('change', () => {
        v[f.key] = wrap.value;
        if (f.onChange) f.onChange(v);
        if (f.rerender) renderSeSheet();
      });
    } else if (f.kind === 'swatches') {
      wrap.addEventListener('click', e => {
        const btn = e.target.closest('.se-swatch');
        if (!btn) return;
        v[f.key] = btn.dataset.color;
        wrap.querySelectorAll('.se-swatch').forEach(b => b.classList.toggle('se-on', b === btn));
      });
    } else if (f.kind === 'days') {
      wrap.addEventListener('click', e => {
        const btn = e.target.closest('.wd-toggle');
        if (!btn) return;
        const n = parseInt(btn.dataset.day);
        const at = v[f.key].indexOf(n);
        if (at === -1) v[f.key].push(n); else v[f.key].splice(at, 1);
        if (f.onChange) f.onChange(v);
        // A re-render is what makes the dependent fields (a gate's per-day
        // windows) follow the day keys; without one, repaint just this key.
        if (f.rerender) renderSeSheet();
        else btn.classList.toggle('on', at === -1);
      });
    } else if (f.kind === 'check') {
      wrap.addEventListener('click', () => {
        v[f.key] = !v[f.key];
        wrap.classList.toggle('on', v[f.key]);
        wrap.textContent = v[f.key] ? f.on : f.off;
        if (f.rerender) renderSeSheet();
      });
    } else if (f.kind === 'weekly') {
      wrap.querySelectorAll('.se-wk-row').forEach(row => {
        const dow = row.dataset.dow;
        const read = () => ({
          start: row.querySelector('.se-wk-start').value,
          end: row.querySelector('.se-wk-end').value,
          offset: row.querySelector('.se-wk-off').classList.contains('on') ? 1 : 0,
        });
        row.querySelectorAll('input').forEach(inp =>
          inp.addEventListener('change', () => { v[f.key][dow] = read(); }));
        row.querySelector('.se-wk-off').addEventListener('click', e => {
          e.currentTarget.classList.toggle('on');
          v[f.key][dow] = read();
        });
      });
    } else if (f.kind !== 'static') {
      wrap.addEventListener('input', () => {
        v[f.key] = wrap.value;
        if (f.onInput) f.onInput(v);
      });
    }
  });
}

async function submitSeSheet() {
  const spec = SETTINGS_SHEETS[seSheet.kind];
  const btn = document.querySelector('#se-sheet .se-save');
  btn.disabled = true;
  const error = await spec.submit(seSheet.values, seSheet.item);
  if (error) {
    seSheetRefuse(error);
    return;
  }
  await refreshAfterSettingsWrite();
  // A sheet that NAVIGATES has already opened the one you land on (a tag hands
  // back to its gate), so closing here would shut that. Same bargain as an
  // action row's keepOpen.
  const back = seSheet.returnTo;
  if (back) { await back(); return; }
  if (spec.navigates) return;
  closeSeSheet();
  renderSettingsIndex();
}

async function removeSeItem() {
  const spec = SETTINGS_SHEETS[seSheet.kind];
  if (spec.confirm && !confirm(spec.confirm(seSheet.item))) return;
  await spec.remove(seSheet.item);
  await refreshAfterSettingsWrite();
  const back = seSheet.returnTo;
  if (back) { await back(); return; }
  if (spec.navigates) return;
  closeSeSheet();
  renderSettingsIndex();
}

// Option lists the sheets share. `— none —` stays first so a select's empty
// value is a real choice rather than a blank row.
//
// PAUSED things are not offered — that is what pausing is for — but the one
// already SELECTED is always kept in the list, or opening a sheet would
// silently drop the choice it is showing you.
function seLocationOptions(firstName, current) {
  return [{ value: '', name: firstName || '— none —' }].concat(
    (state.locations || []).filter(l => l.active !== 0 || String(l.id) === String(current))
      .map(l => ({ value: l.id, name: l.name + (l.active === 0 ? ' (paused)' : '') })));
}

// ONE select for where a thing is filed: nothing, or an area. DOMAINS ARE GONE
// from every picker (2026-10-01, Quentin's instruction); a row still filed
// under one keeps it as its current value, named, until it is filed anew —
// the paused-option rule, so opening a sheet never refiles anything by itself.
function seFilingOptions(current) {
  const dom = (state.domains || []).filter(d => `d:${d.id}` === String(current))
    .map(d => ({ value: `d:${d.id}`, name: `${d.name} (old domain)` }));
  const areas = (state.areas || []).filter(a => a.active || `a:${a.id}` === String(current))
    .map(a => ({ value: `a:${a.id}`, name: a.name + (a.active ? '' : ' (paused)') }));
  return [{ value: '', name: '— nothing —' }].concat(dom, areas);
}

function seDomainOptions(current) {
  return (state.domains || []).filter(d => d.active !== 0 || String(d.id) === String(current))
    .map(d => ({ value: d.id, name: d.name + (d.active === 0 ? ' (paused)' : '') }));
}

// ── The common interface (2026-08-15) ────────────────────────
//
// Every settings item answers the SAME three verbs, in the same words and the
// same place: EDIT it (the sheet's fields), PAUSE it (this row, always last,
// just above the buttons) and DELETE it (`remove`, the sheet's foot). They
// used to disagree — a gate could not be deleted, a block could not be paused
// though its column existed, a location could not even be renamed, and the
// state row said Archived / Inactive / Hidden / Paused for one idea.
//
// Paused NEVER deletes and never rewrites what already points at the thing: it
// stops it running and stops it being offered. `hint` is where a kind explains
// what its own pause means (a gate's waits 24h, like every other easing).
function seStateRow(hint) {
  return { key: 'active', label: 'State', kind: 'check', on: 'Active', off: 'Paused',
           ...(hint ? { hint } : {}) };
}

// WHEN, asked in one place (2026-08-17). Blank means now — the sheet has always
// meant "and from now on", so the empty field is the behaviour that already
// existed. A date means the whole save is filed against that day: nothing
// changes before it, and every surface that draws a day resolves it from there
// (storage.row_as_of). It sits directly above the buttons, under the state
// row, because it qualifies the SAVE rather than any one field.
//
// A gate's easings still wait their 24h — the date is a floor, never a bypass —
// so the hint says which of the two won once the server has answered.
function seWhenRow(hint) {
  return { key: 'effective', label: 'Takes effect', kind: 'date',
           hint: hint || 'Blank: now. A date changes nothing until that day.' };
}

// The day a scheduled change starts, said the way a person reads a date.
function seWhenLabel(ymd) {
  if (!ymd) return '';
  const d = new Date(ymd + 'T12:00:00');
  const today = wallDay();
  if (ymd === today) return 'today';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// What a scheduled change is CALLED, so a row can say what it does rather
// than name a column. GATE_FIELDS is the same idea for the money path.
const BLOCK_FIELDS = {
  label: 'Label', color: 'Colour', day_of_week: 'Day', start_time: 'From',
  end_time: 'To', area_id: 'Area', domain_id: 'Domain', location_id: 'Location', active: 'State',
  description: 'Description', priority: 'Priority', delete: 'Deleted',
};

// A block's priority (2026-09-23, Quentin's instruction): 1 is the most
// important and may not be infringed, 3 the least and may be. Settings and the
// export say it; the calendar deliberately does not draw it.
const BLOCK_PRIORITY_OPTIONS = [
  { value: '', name: '— none —' },
  { value: '1', name: '1 — most important, can\'t be infringed' },
  { value: '2', name: '2' },
  { value: '3', name: '3 — least important, can be infringed' },
];

function blockChangeValue(c) {
  if (c.field === 'day_of_week') return weekdayName(c.new_value) || c.new_value;
  if (c.field === 'active') return c.new_value ? 'Active' : 'Paused';
  if (c.field === 'priority') return c.new_value ? `P${c.new_value}` : 'none';
  if (c.field === 'area_id') {
    return ((state.areas || []).find(a => String(a.id) === String(c.new_value)) || {}).name || '—';
  }
  if (c.field === 'domain_id') return c.new_value ? domainName(c.new_value) : '—';
  if (c.field === 'location_id') {
    return ((state.locations || []).find(l => String(l.id) === String(c.new_value)) || {}).name || '—';
  }
  if (c.field === 'delete') return 'gone';
  return String(c.new_value);
}

// A group is several rows moving together, so its scheduled changes are the
// union of its rows' — deduped by (field, value, day), because "From → 07:00
// on Wednesday" said five times is one decision, not five.
function blockGroupChanges(g) {
  const seen = new Set();
  const out = [];
  for (const row of g.rows) {
    for (const c of (row.scheduled_changes || [])) {
      const key = `${c.field}|${JSON.stringify(c.new_value)}|${c.effective_date}`;
      // day_of_week is per row by nature — one row moves to Tuesday, another
      // stays — so those are never collapsed.
      if (c.field !== 'day_of_week' && seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

// Dating a group's edit. Each row takes the fields that actually changed;
// WHICH DAYS the block runs is the one thing a date cannot express, because
// adding a day means a row that does not exist yet and dropping one means
// deleting a row — both are creations and deletions, not a field moving.
// A same-size day set IS expressible: it is a move, paired in day order.
async function scheduleBlockGroup(g, v) {
  const oldDays = [...g.days].sort((a, b) => a - b);
  const newDays = [...v.days].sort((a, b) => a - b);
  if (oldDays.length !== newDays.length) {
    return 'Adding or dropping a day can\'t be dated yet — clear the date to save '
      + 'the days now, or change only the times, place and state.';
  }
  const fields = {};
  if (v.label.trim() !== g.label) fields.label = v.label.trim();
  if (v.color !== g.color) fields.color = v.color;
  if (v.start !== g.start_time) fields.start_time = v.start;
  if (v.end !== g.end_time) fields.end_time = v.end;
  if (String(v.area || '') !== filingKey(g)) Object.assign(fields, filingBody(v.area));
  if (String(v.location || '') !== String(g.location_id || '')) fields.location_id = v.location || null;
  if (v.description.trim() !== (g.description || '')) fields.description = v.description.trim();
  if (String(v.priority || '') !== String(g.priority || '')) {
    fields.priority = v.priority ? Number(v.priority) : null;
  }
  const wasActive = g.rows.some(r => r.active);
  if (v.active !== wasActive) fields.active = v.active ? 1 : 0;

  const rowsByDay = Object.fromEntries(g.rows.map(r => [r.day_of_week, r]));
  const sends = [];
  oldDays.forEach((day, i) => {
    const row = rowsByDay[day];
    const body = { ...fields, effective_from: v.effective };
    if (newDays[i] !== day) body.day_of_week = newDays[i];
    // Nothing but the date: there is no change to schedule.
    if (Object.keys(body).length === 1) return;
    sends.push(apiSend(`/api/blocks/${row.id}`, 'PATCH', body));
  });
  if (!sends.length) return 'Nothing changed, so there is nothing to schedule.';
  const res = await Promise.all(sends);
  if (res.some(r => !r.ok)) return 'Could not schedule that change.';
  toast(`${g.label} changes from ${seWhenLabel(v.effective)}`);
  return null;
}

// ── Per-datatype sheets ──────────────────────────────────────

const SETTINGS_SHEETS = {

  // A BLOCK CATEGORY (blockCategories): the name and colour every one of its
  // times shares, and the times themselves, each opening its own sheet. It is
  // only ever EDITED — a category comes into being with its first time, which
  // the block sheet adds. No "Takes effect" row: a name and a colour draw
  // nothing different on any one day, and a time's dated change lives on the
  // time's own sheet.
  blockcat: {
    title: () => 'Block category',
    save: () => 'Save category',
    removeLabel: 'Delete category',
    confirm: c => `Delete ${c.label} and all ${c.groups.length} of its time${c.groups.length === 1 ? '' : 's'}?`,
    blank: () => ({ label: '', color: BLOCK_COLORS[0], active: true }),
    load: c => ({ label: c.label, color: c.color, active: c.rows.some(r => r.active) }),
    fields: (v, c) => [
      { key: 'label', label: 'Name', kind: 'text', placeholder: 'e.g. COS330' },
      { key: 'color', label: 'Colour', kind: 'swatches',
        hint: 'Every time of this category is drawn in it.' },
      ...(c ? c.groups : []).map((g, i) => ({
        key: `time_${i}`, label: i === 0 ? 'Times' : '', kind: 'action',
        text: blockTimeLabel(g), action: 'Edit', keepOpen: true,
        run: () => openSeSheet('block', g, reopenBlockCategory(c.key)) })),
      ...(c ? [{ key: 'add_time', label: c.groups.length ? '' : 'Times', kind: 'action',
        text: 'Another stretch of the week', action: '+ Add a time', keepOpen: true,
        run: () => {
          const g = c.groups[0];
          openSeSheet('block', null, reopenBlockCategory(c.key), {
            label: v.label.trim() || c.label, color: v.color,
            area: g ? filingKey(g) : '', location: g ? (g.location_id || '') : '' });
        } }] : []),
      ...(c ? [seStateRow('Paused: every time of this category leaves the timeline, and its '
                          + 'hours are free. Nothing is deleted.')] : []),
    ],
    submit: async (v, c) => {
      const label = v.label.trim();
      if (!label || !v.color) return 'A name and a colour are required.';
      // Only the rows that differ are written; each PATCH states the row's own
      // times and filing, which the route requires and this does not change.
      for (const r of c.rows.filter(r => r.label !== label || r.color !== v.color)) {
        const res = await apiSend(`/api/blocks/${r.id}`, 'PATCH', {
          label, color: v.color, day_of_week: r.day_of_week,
          start_time: r.start_time, end_time: r.end_time,
          ...filingBody(filingKey(r)), location_id: r.location_id || null,
        });
        if (!res || !res.ok) {
          const msg = res ? await res.json().catch(() => ({})) : {};
          await refreshBlockEditor();
          return msg.error || 'Could not save the category.';
        }
      }
      const want = v.active ? 1 : 0;
      await Promise.all(c.rows.filter(r => (r.active ? 1 : 0) !== want)
        .map(r => apiSend(`/api/blocks/${r.id}`, 'PATCH', { active: want })));
      // Lit up on the calendar under its old name: follow the rename.
      if (calPin.cat === c.key) {
        Object.assign(calPin, { cat: blockCatKey(label), name: label, color: v.color });
        paintCalPin();
      }
      await refreshBlockEditor();
      return null;
    },
    remove: async c => {
      await Promise.all(c.rows.map(r => apiSend(`/api/blocks/${r.id}`, 'DELETE')));
      await refreshBlockEditor();
    },
  },

  // A block row is a GROUP of one-per-day rows (groupBlocks), so saving an
  // edit deletes the group and re-posts it — the API has no group identity.
  // Within a CATEGORY it is one of that category's times.
  block: {
    title: it => it ? 'Edit time' : 'Add block',
    save: () => 'Save block',
    removeLabel: 'Delete block',
    blank: () => ({ label: '', color: BLOCK_COLORS[0], days: [], start: '', end: '',
                    area: '', location: '', description: '', priority: '',
                    active: true, effective: '' }),
    load: g => ({
      label: g.label, color: g.color, days: g.days.slice(),
      start: g.start_time, end: g.end_time,
      area: filingKey(g), location: g.location_id || '',
      description: g.description || '', priority: g.priority ? String(g.priority) : '',
      // A group is paused when every row in it is — the rows only ever move
      // together, and a half-paused group has no meaning on the timeline.
      active: g.rows.some(r => r.active),
      effective: '',
    }),
    fields: (v, g) => [
      { key: 'label', label: 'Label', kind: 'text', placeholder: 'e.g. Deep work' },
      { key: 'color', label: 'Colour', kind: 'swatches' },
      { key: 'days', label: 'Days', kind: 'days' },
      { key: 'start', label: 'From', kind: 'time', half: true },
      { key: 'end', label: 'To', kind: 'time', half: true },
      { key: 'area', label: 'Filed under', kind: 'select', half: true,
        options: () => seFilingOptions(v.area) },
      { key: 'location', label: 'Location', kind: 'select', half: true,
        options: () => seLocationOptions(null, v.location) },
      { key: 'description', label: 'What for', kind: 'textarea',
        placeholder: 'e.g. Assignment time',
        hint: 'Shown when you hover or tap this stretch on the calendar.' },
      { key: 'priority', label: 'Priority', kind: 'select', options: () => BLOCK_PRIORITY_OPTIONS,
        hint: 'How firmly these hours hold against something else wanting them. '
          + 'Not drawn on the calendar.' },
      ...(g ? [seStateRow('Paused: off the timeline, and its hours are free for '
                          + 'another block. Nothing is deleted.')] : []),
      ...(g ? [seWhenRow('Blank: now, as always. A date leaves this week alone and '
                         + 'moves the block from that day — the timeline draws it '
                         + 'there before it happens.')] : []),
      ...(g ? blockGroupChanges(g).map(c => ({
        key: `cancel_${c.block_id}_${c.field}`, label: '', kind: 'action',
        text: `${BLOCK_FIELDS[c.field] || c.field} → ${blockChangeValue(c)}`
          + ` from ${seWhenLabel(c.effective_date)}`,
        action: 'Call off',
        run: async () => {
          await apiSend(`/api/blocks/${c.block_id}/scheduled/${c.field}`, 'DELETE');
          await refreshBlockEditor();
        },
      })) : []),
    ],
    submit: async (v, g) => {
      if (!v.label.trim() || !v.color || !v.start || !v.end) return 'Label, colour, from and to are required.';
      if (!v.days.length) return 'Select at least one day.';
      // DATED: nothing is rewritten today. The group's rows are patched with
      // the date instead, which is why this returns before the delete-and-
      // re-POST below — that path mints NEW ids, and a change dated onto an id
      // that stops existing is a change that never happens.
      if (g && v.effective) {
        const err = await scheduleBlockGroup(g, v);
        if (err) return err;
        await refreshBlockEditor();
        return null;
      }
      if (g) await Promise.all(g.rows.map(r => apiSend(`/api/blocks/${r.id}`, 'DELETE')));
      const res = await apiSend('/api/blocks', 'POST', {
          label: v.label.trim(), color: v.color, days: v.days,
          start_time: v.start, end_time: v.end,
          ...filingBody(v.area), location_id: v.location || null,
          description: v.description.trim(), priority: v.priority ? Number(v.priority) : null,
        });
      const data = await res.json();
      if (!res.ok) {
        // The old rows were deleted to make room for the new ones, so a refused
        // POST (an overlap) would otherwise take the block with it. Put it back
        // as it was and report the refusal.
        if (g) {
          await apiSend('/api/blocks', 'POST', {
              label: g.label, color: g.color, days: g.days,
              start_time: g.start_time, end_time: g.end_time,
              area_id: g.area_id || null, domain_id: g.domain_id || null,
              location_id: g.location_id || null,
              description: g.description || '', priority: g.priority || null,
            }).catch(() => {});
          await refreshBlockEditor();
        }
        return data.error || 'Error saving block.';
      }
      // The group is re-POSTed on every save (the API has no group identity),
      // and rows arrive active — so a paused group has to be paused again, or
      // editing one would quietly turn it back on.
      if (!v.active) {
        await Promise.all(data.map(b => apiSend(`/api/blocks/${b.id}`, 'PATCH', { active: 0 })));
      }
      await refreshBlockEditor();
      return null;
    },
    remove: async g => {
      // A dated delete leaves the block running until that day, like a gate's.
      const when = (seSheet.values || {}).effective;
      const q = when ? `?effective_from=${encodeURIComponent(when)}` : '';
      await Promise.all(g.rows.map(r => apiSend(`/api/blocks/${r.id}${q}`, 'DELETE')));
      if (when) toast(`${g.label} gone from ${seWhenLabel(when)}`);
      await refreshBlockEditor();
    },
  },

  // Adding takes the whole schedule; editing takes what the API accepts
  // (project and paused), with the schedule stated read-only so the sheet
  // can't offer a change the server would drop.
  recurring: {
    title: it => it ? 'Recurring task' : 'Add recurring task',
    save: it => it ? 'Save task' : 'Add task',
    removeLabel: 'Delete task',
    confirm: () => 'Delete this recurring task? Occurrences already filed stay.',
    blank: () => ({
      name: '', area: '', kind: 'weekly', days: [], interval: 1,
      nth: 1, weekday: 0, anchor: wallDay(), due: '',
    }),
    load: t => ({ project: t.project_id || '', active: !!t.active }),
    fields: (v, it) => {
      if (it) return [
        { key: 'name', label: 'Task', kind: 'static', text: it.name },
        { key: 'sched', label: 'Repeats', kind: 'static', text: recurringScheduleLabel(it) },
        // Filing occurrences under a project makes them adopt that project's
        // area server-side, so the area is stated on the option rather than
        // asked for twice.
        { key: 'project', label: 'File under', kind: 'select',
          options: () => [{ value: '', name: '— no project —' }].concat(
            (state.projects || []).map(p => ({
              value: p.id, name: p.area_name ? `${p.content} · ${p.area_name}` : p.content,
            }))) },
        seStateRow('Paused: no new occurrences are seeded. Ones already filed stay.'),
      ];
      const unit = v.kind === 'every_n_days' ? 'day(s)' : v.kind === 'weekly' ? 'week(s)' : 'month(s)';
      return [
        { key: 'name', label: 'Name', kind: 'text', placeholder: 'e.g. Water the plants' },
        { key: 'area', label: 'Filed under', kind: 'select',
          options: () => seFilingOptions(v.area) },
        { key: 'kind', label: 'Repeats', kind: 'select', rerender: true, options: () => [
          { value: 'weekly', name: 'Days of the week' },
          { value: 'monthly_nth', name: 'Nth weekday of the month' },
          { value: 'monthly_date', name: 'Day of the month' },
          { value: 'every_n_days', name: 'Every N days' },
        ] },
        ...(v.kind === 'weekly' ? [{ key: 'days', label: 'Days', kind: 'days' }] : []),
        ...(v.kind === 'monthly_nth' ? [
          { key: 'nth', label: 'On the', kind: 'select', half: true,
            options: () => [1, 2, 3, 4, 5].map(n => ({ value: n, name: ordinalNth(n) })) },
          { key: 'weekday', label: 'Weekday', kind: 'select', half: true,
            options: () => WEEKDAYS.map(w => ({ value: w.i, name: w.name })) },
        ] : []),
        { key: 'interval', label: 'Every', kind: 'number', min: 1, suffix: unit, half: true,
          hint: v.kind === 'monthly_date'
            ? 'Yearly is 12 months — there is one scheduler, not a second kind.' : null },
        { key: 'anchor', label: 'Starting', kind: 'date', half: true },
        // The occurrence's DUE day, which the form could not express at all:
        // "appears 1 April, due 12 May" was a task you could describe and not
        // enter. Only the month and day are kept (deadline_md) — the year is
        // decided when the occurrence is actually seeded, so it can never be
        // due in a year that has passed.
        { key: 'due', label: 'Due', kind: 'date', half: true,
          hint: v.due
            ? `Due ${recDueLabel(v.due.slice(5))} of whichever year it appears in.`
            : 'Optional. Only the month and day are kept.' },
      ];
    },
    submit: async (v, it) => {
      if (it) {
        const res = await apiSend(`/api/recurring/${it.id}`, 'PATCH', {
            project_id: v.project ? parseInt(v.project) : null,
            active: v.active ? 1 : 0,
          });
        if (!res.ok) return 'Error saving.';
        await refreshRecurringList();
        return null;
      }
      // Each one named on its own: "Name, area and start date are required"
      // made you check all three to find the one that was not.
      if (!v.name.trim()) return 'Give the task a name.';
      if (!v.anchor) return 'Set the day it starts.';
      const body = {
        name: v.name.trim(), ...filingBody(v.area), kind: v.kind,
        anchor_date: v.anchor, interval: parseInt(v.interval) || 1,
      };
      // YYYY-MM-DD in, MM-DD stored: the year belongs to the occurrence.
      if (v.due) body.deadline_md = v.due.slice(5);
      if (v.kind === 'weekly') {
        if (!v.days.length) return 'Select at least one day.';
        body.days_of_week = v.days.slice().sort().join('');
      } else if (v.kind === 'monthly_nth') {
        body.nth = parseInt(v.nth);
        body.weekday = parseInt(v.weekday);
      }
      const res = await apiSend('/api/recurring', 'POST', body);
      if (!res.ok) return 'Error saving.';
      await refreshRecurringList();
      return null;
    },
    remove: async it => {
      await apiSend(`/api/recurring/${it.id}`, 'DELETE');
      await refreshRecurringList();
    },
  },

  // /api/areas PATCH takes ONE field per request (its handler is an if/elif
  // chain), so an edit sends one call per field that actually changed.
  area: {
    title: it => it ? 'Area' : 'Add area',
    save: it => it ? 'Save area' : 'Add area',
    removeLabel: 'Delete area',
    confirm: it => `Delete area "${it.name}"? What is filed under it moves to `
      + (it.domain_id ? `the ${domainName(it.domain_id)} domain.` : 'nothing in particular.'),
    blank: () => ({ name: '', type: 'standard', domain: '' }),
    load: a => ({
      type: a.type, domain: a.domain_id || '', qr: a.qr_node_id || '', active: !!a.active,
    }),
    fields: (v, it) => {
      const types = [
        { value: 'standard', name: 'Standard' }, { value: 'review', name: 'Review' },
        { value: 'sleep', name: 'Sleep' }, { value: 'routine', name: 'Routine' },
      ];
      if (!it) return [
        { key: 'name', label: 'Name', kind: 'text', placeholder: 'Area name' },
        { key: 'type', label: 'Type', kind: 'select', half: true, options: () => types },
      ];
      return [
        { key: 'name', label: 'Name', kind: 'static', text: it.name },
        { key: 'type', label: 'Type', kind: 'select', half: true, rerender: true, options: () => types },
        // A routine area can hang off a gate: the routine then nests under
        // that gate's hairline on Engage even with no block on the calendar.
        ...(v.type === 'routine' ? [{ key: 'qr', label: 'Gate anchor', kind: 'select',
          options: () => [{ value: '', name: 'no gate anchor' }].concat(
            (state.accountabilityNodes || []).filter(n => n.active)
              .map(n => ({ value: n.id, name: n.label }))) }] : []),
        seStateRow('Paused: not offered anywhere new. Its items and history stay.'),
      ];
    },
    submit: async (v, a) => {
      if (!a) {
        if (!v.name.trim()) return 'Name is required.';
        await apiSend('/api/areas', 'POST', { name: v.name.trim(), type: v.type, domain_id: parseInt(v.domain) || null });
        await refreshBlockEditor();
        return null;
      }
      const patch = async body => apiSend(`/api/areas/${a.id}`, 'PATCH', body);
      if (v.type !== a.type) await patch({ type: v.type });
      if (String(v.domain) !== String(a.domain_id || '')) {
        const res = await patch({ domain_id: parseInt(v.domain) || null });
        if (!res.ok) return (await res.json().catch(() => ({}))).error
          || 'That area cannot move domain.';
      }
      if (v.type === 'routine' && String(v.qr) !== String(a.qr_node_id || '')) {
        await patch({ qr_node_id: v.qr ? parseInt(v.qr) : null });
      }
      if (v.active !== !!a.active) await patch({ active: v.active ? 1 : 0 });
      await refreshBlockEditor();
      return null;
    },
    remove: async a => {
      const res = await apiSend(`/api/areas/${a.id}`, 'DELETE');
      if (!res.ok) {
        toast((await res.json().catch(() => ({}))).error || 'That area cannot be deleted.');
        return;
      }
      await refreshBlockEditor();
    },
  },

  // Every domain can be deleted, the old default included (2026-09-15).
  domain: {
    title: it => it ? 'Domain' : 'Add domain',
    save: () => 'Save domain',
    removeLabel: 'Delete domain',
    confirm: it => `Delete domain "${it.name}"? Its areas stay, in no domain, and what `
      + 'was filed under it is filed under nothing.',
    blank: () => ({ name: '', color: '', active: true }),
    load: d => ({ name: d.name, color: d.color || '', active: d.active !== 0 }),
    fields: (v, it) => [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'Domain name' },
      // THE COLOUR THE PLAN DRAWS IN. It lives on the domain because that is
      // what you think in while planning a day — the banner already asks for
      // a domain, not an area — and one edit re-colours every span ever drawn
      // for it. Clearable: no colour is a real answer, and the span falls
      // back to the accent it has always used.
      { key: 'color', label: 'Colour', kind: 'swatches', clearable: true,
        hint: 'What planned hours for this domain draw in on the calendar.' },
      ...(it ? [seStateRow('Paused: not offered when filing. Its areas keep working.')] : []),
    ],
    submit: async (v, d) => {
      const name = v.name.trim();
      if (!name) return 'Name is required.';
      if (d) {
        await apiSend(`/api/domains/${d.id}`, 'PATCH', { name, color: v.color || '',
          active: v.active ? 1 : 0 });
      } else {
        await apiSend('/api/domains', 'POST', { name, color: v.color || '' });
      }
      await refreshBlockEditor();
      // The colour is what the PLAN draws in, and this sheet opens over the
      // day as often as over Settings (MAP's roster is the other door). The
      // spans behind it are already on screen, so a repaint here is the
      // difference between seeing the edit and waiting for the 60s tick to
      // show it. refreshBlockEditor has just reloaded state.domains, which is
      // the only thing planSpanColor reads.
      renderTimeline();
      return null;
    },
    remove: async d => {
      await apiSend(`/api/domains/${d.id}`, 'DELETE');
      await refreshBlockEditor();
    },
  },

  // A location's COORDINATES stay immutable — they are what gates and context
  // tags were pinned against, and moving them would silently redefine every
  // geofence that quoted them. Its name and its state are ordinary edits, the
  // same two verbs every other settings item has.
  // A metric is a QUESTION. Its kind decides what the answer looks like, so
  // the scale bounds and the unit only appear for the kinds that have them
  // (`rerender: true` on the kind select is what makes that switch live).
  metric: {
    title: it => it ? it.name : 'Add metric',
    save: it => it ? 'Save metric' : 'Add metric',
    removeLabel: 'Delete metric',
    // Deleting the QUESTION deletes its answers — a number with no question is
    // unreadable, not history. Pausing is the verb that keeps the history, so
    // the confirm says which one this is.
    confirm: it => `Delete "${it.name}" and every answer ever recorded for it?\n\n`
      + 'Pause instead if you want to stop being asked but keep the history.',
    blank: () => ({ name: '', kind: 'scale', prompt: '', scale_min: 1, scale_max: 7,
                    unit: '', days: [], active: true }),
    load: m => ({ name: m.name, kind: m.kind, prompt: m.prompt || '',
                  scale_min: m.scale_min, scale_max: m.scale_max, unit: m.unit || '',
                  days: [...(m.days_of_week || '')].map(Number), active: !!m.active }),
    fields: (v, it) => [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'e.g. Mood' },
      { key: 'kind', label: 'Answer', kind: 'select', rerender: true,
        options: () => Object.entries(METRIC_KIND_LABELS)
          .map(([value, name]) => ({ value, name })) },
      ...(v.kind === 'scale' ? [
        { key: 'scale_min', label: 'From', kind: 'number', half: true },
        { key: 'scale_max', label: 'To', kind: 'number', half: true },
      ] : []),
      ...(v.kind === 'count' ? [
        { key: 'unit', label: 'Unit', kind: 'text', placeholder: 'e.g. cups',
          hint: 'optional — what the number counts' },
      ] : []),
      { key: 'prompt', label: 'Asked as', kind: 'text',
        placeholder: 'optional — the wording it is asked in' },
      // Under the STEP's own days, not instead of them: the step decides
      // whether the routine asks anything today, this decides whether this
      // question is one of the things it asks.
      { key: 'days', label: 'Days', kind: 'days',
        hint: v.days.length && v.days.length < 7
          ? 'Only on the lit days — and only if the step itself runs that day.'
          : 'Every day the step that asks it runs.' },
      // Read-only: a metric is bound to a step from the STEP's sheet, where
      // you can see the rest of that routine. Stating it here rather than
      // offering a second binder keeps one way to do it (same idiom as
      // Recurring's read-only "Repeats").
      ...(it ? [{ key: 'asked', label: 'Asked on', kind: 'static',
                  text: (it.steps || []).length
                    ? it.steps.map(s => s.flow_name).join(', ')
                    : 'nothing yet',
                  hint: 'Where it was asked. Routines are plain lists now '
                    + '(2026-10-05), so nothing new asks it yet.' }] : []),
      ...(it ? [seStateRow('Paused: not asked and not offered on a step. '
                           + 'Every answer already recorded stays.')] : []),
    ],
    submit: async (v, it) => {
      if (!v.name.trim()) return 'Name is required.';
      const min = parseInt(v.scale_min), max = parseInt(v.scale_max);
      if (v.kind === 'scale' && (isNaN(min) || isNaN(max) || min >= max)) {
        return 'A scale needs a low number and a higher one.';
      }
      const body = { name: v.name.trim(), kind: v.kind, prompt: v.prompt.trim(),
                     unit: v.unit.trim(), days_of_week: v.days.join('') };
      if (v.kind === 'scale') { body.scale_min = min; body.scale_max = max; }
      if (it) {
        body.active = v.active ? 1 : 0;
        const res = await apiSend(`/api/metrics/${it.id}`, 'PATCH', body);
        if (!res.ok) return 'Error saving metric.';
      } else {
        const res = await apiSend('/api/metrics', 'POST', body);
        if (!res.ok) return 'Error adding metric.';
        const created = await res.json();
        // A create inverts to a delete, like every other create.
        pushUndo(`added metric "${created.name}"`, async () => {
          await apiSend(`/api/metrics/${created.id}`, 'DELETE');
          await refreshMetricsSettings();
        });
      }
      await refreshMetricsSettings();
      return null;
    },
    remove: async m => {
      await apiSend(`/api/metrics/${m.id}`, 'DELETE');
      await refreshMetricsSettings();
    },
  },

  // A DRAWN SPAN's editor. It joins SETTINGS_SHEETS because the object door
  // demands one — a declared kind with no sheet is a door leading nowhere, and
  // client_rules_test says so — but it is the first entry here that is not
  // permanent structure, and one of the three verbs does not fit.
  //
  // NAMED GAP: there is no Pause. Pausing exists so a standing thing can stop
  // running without deleting what points at it; a span is one day's intention,
  // nothing points at it, and a paused one would be a plan that is not a plan.
  // Delete is the whole retirement story, and it is undoable. (The routine
  // sheet's missing Pause is the precedent for naming a gap rather than
  // inventing a verb to fill it.)
  // A BLOCK FOR ONE DATE's editor — the local half, never the week. Like the
  // plan span it is day data, so the same NAMED GAP: no Pause (a paused
  // one-off is a block that is not a block); Remove is its whole retirement,
  // and undoable. To change every week, the weekly block has its own sheet.
  dayblock: {
    title: () => 'Block for one date',
    save: () => 'Save block',
    removeLabel: 'Remove from this date',
    blank: () => ({ label: '', date: '', start: '', end: '', area: '', description: '' }),
    load: b => ({ label: b.label, date: b.date, start: clockHHMM(b.start_min),
                  end: clockHHMM(b.end_min), area: filingKey(b),
                  description: b.description || '' }),
    fields: v => [
      { key: 'label', label: 'Name', kind: 'text',
        hint: 'This date only. The weekly schedule is not touched — to change every '
              + 'week, edit the weekly block in Settings → Blocks.' },
      { key: 'date', label: 'Date', kind: 'date' },
      { key: 'start', label: 'From', kind: 'time', half: true },
      { key: 'end', label: 'To', kind: 'time', half: true },
      { key: 'area', label: 'For', kind: 'select', options: () => seFilingOptions(v.area) },
      { key: 'description', label: 'Purpose', kind: 'text', placeholder: 'e.g. midterm review' },
    ],
    submit: async (v, b) => {
      const label = (v.label || '').trim();
      if (!label || !v.date || !v.start || !v.end) return 'Name, date, from and to are required.';
      const lo = timeToMinutes(v.start);
      const end = spanEndMin(v.start, v.end);
      if (isNaN(lo) || isNaN(end) || end - lo < 5) return 'A block runs at least 5 minutes.';
      const fields = { label, date: v.date, start_min: lo, end_min: end,
                       ...filingBody(v.area), description: (v.description || '').trim() };
      const prev = {};
      Object.keys(fields).forEach(k => { prev[k] = b[k] === undefined ? null : b[k]; });
      const res = await apiSend(`/api/day-blocks/${b.id}`, 'PATCH', fields);
      if (!res.ok) return ((await res.json().catch(() => ({}))).error) || 'Error saving that block.';
      pushUndo(`edited "${b.label}"`, async () => {
        await apiSend(`/api/day-blocks/${b.id}`, 'PATCH', prev);
        await refreshAfterUndo();
      });
      await refreshAfterUndo();
      return null;
    },
    remove: async b => removeDayBlock(b.id),
  },

  planspan: {
    title: () => 'Planned hours',
    save: () => 'Save span',
    removeLabel: 'Remove span',
    blank: () => ({ start: '', end: '', area: '', location: '' }),
    load: s => ({ start: clockHHMM(s.start_min), end: clockHHMM(s.end_min),
                  area: filingKey(s), location: s.location || '' }),
    fields: v => [
      { key: 'start', label: 'From', kind: 'time', half: true },
      { key: 'end', label: 'To', kind: 'time', half: true },
      { key: 'area', label: 'For', kind: 'select',
        options: () => seFilingOptions(v.area),
        hint: 'What this stretch is for: a domain, or an area (which carries its '
              + 'domain, if it has one).' },
      // WHERE, as typed words — the same field the span's double-click edits
      // in place. This sheet is the finger's road to it (the menu's
      // `Edit span…`), since a double-click is a poor phone gesture.
      { key: 'location', label: 'Where', kind: 'text', placeholder: 'e.g. Firestone, 3rd floor',
        hint: 'Just words. It gates nothing — the plan is a claim about the '
              + 'day, never a geofence.' },
    ],
    submit: async (v, s) => {
      if (!v.start || !v.end) return 'From and to are required.';
      const lo = timeToMinutes(v.start);
      if (isNaN(lo)) return 'From and to are required.';
      // A span crossing midnight ends past 1440, and spanEndMin is the ONE
      // place that decides the wrap. Re-deciding it here is the bug the
      // accessors exist to stop — and client_rules_test caught exactly that
      // when this line was written by hand.
      const end = spanEndMin(v.start, v.end);
      if (isNaN(end) || end - lo < 5) return 'A span runs at least 5 minutes.';
      const res = await apiSend(`/api/plan/spans/${s.id}`, 'PATCH',
        { start_min: lo, end_min: end, ...filingBody(v.area),
          location: (v.location || '').trim() });
      if (!res.ok) return 'Error saving that span.';
      await refreshPlan(s.date);
      renderTimeline();
      return null;
    },
    remove: async s => {
      await deletePlanSpan(s);
      return true;
    },
  },

  location: {
    title: it => it ? 'Location' : 'Add location',
    save: it => it ? 'Save location' : 'Save location',
    removeLabel: 'Delete location',
    confirm: it => `Delete "${it.name}"? Gates and tags pinned to it lose their anchor.`,
    blank: () => ({ name: '', lat: '', lng: '', radius: '', active: true, offer: true }),
    load: l => ({ name: l.name, lat: l.lat, lng: l.lng, radius: l.radius_m,
                  active: l.active !== 0 }),
    fields: (v, it) => it ? [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'e.g. Mox' },
      { key: 'coords', label: 'Coordinates', kind: 'static', text: `${it.lat}, ${it.lng}`,
        hint: 'Fixed — a gate quotes these, so moving them would move the gate.' },
      { key: 'radius', label: 'Radius', kind: 'static', text: `${it.radius_m}m` },
      seStateRow('Paused: not offered to gates or tags. Ones already pinned keep their anchor.'),
    ] : [
      { key: 'find', label: 'Find it', kind: 'geocode',
        placeholder: 'e.g. 12 Nassau St, Princeton',
        hint: 'Search an address, or take this device\'s position if you are there.' },
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'e.g. Mox' },
      { key: 'lat', label: 'Latitude', kind: 'number', step: 'any', half: true },
      { key: 'lng', label: 'Longitude', kind: 'number', step: 'any', half: true },
      { key: 'radius', label: 'Radius', kind: 'number', suffix: 'm', hint: 'blank = 150m' },
      { key: 'offer', label: 'Offer it', kind: 'check', on: 'A place I use', off: 'Just this once',
        hint: 'Just this once still works as a geofence — it is simply never offered '
              + 'in the pickers. Un-pause it later to promote it.' },
    ],
    submit: async (v, it) => {
      if (it) {
        if (!v.name.trim()) return 'Name is required.';
        const res = await apiSend(`/api/locations/${it.id}`, 'PATCH', { name: v.name.trim(), active: v.active ? 1 : 0 });
        if (!res.ok) return 'Error saving location.';
        state.locations = await fetch('/api/locations').then(r => r.json())
          .catch(() => state.locations);
        await renderQrManager();
        return null;
      }
      const lat = parseFloat(v.lat);
      const lng = parseFloat(v.lng);
      if (!v.name.trim() || isNaN(lat) || isNaN(lng)) return 'Name, latitude and longitude are required.';
      const radius = parseInt(v.radius);
      await apiSend('/api/locations', 'POST', {
        name: v.name.trim(), lat, lng, radius_m: isNaN(radius) ? null : radius,
        // "Just this once" is a PAUSED location: the row exists so the
        // coordinates do, and the pickers never offer it.
        active: v.offer === false ? 0 : 1,
      });
      state.locations = await fetch('/api/locations').then(r => r.json())
        .catch(() => state.locations);
      await renderQrManager();
      return null;
    },
    remove: async l => {
      await apiSend(`/api/locations/${l.id}`, 'DELETE');
      await renderQrManager();
    },
  },

  calendar: {
    title: it => it ? 'Calendar' : 'Add calendar',
    save: it => it ? 'Save calendar' : 'Fetch calendar',
    removeLabel: 'Delete calendar',
    confirm: it => `Delete "${it.name}"? Its events leave the timeline.`,
    blank: () => ({ url: '', color: BLOCK_COLORS[0] }),
    load: c => ({ name: c.name, color: c.color, active: !!c.active }),
    fields: (v, it) => it ? [
      { key: 'name', label: 'Name', kind: 'text' },
      { key: 'color', label: 'Colour', kind: 'swatches' },
      seStateRow('Paused: not fetched, and its events leave the timeline.'),
    ] : [
      { key: 'url', label: 'iCal URL', kind: 'url', placeholder: 'https://…/basic.ics' },
      { key: 'color', label: 'Colour', kind: 'swatches' },
    ],
    submit: async (v, c) => {
      if (c) {
        await patchCalendar(c.id, { name: v.name.trim() || c.name, color: v.color, active: v.active ? 1 : 0 });
        await refreshCalendars();
        return null;
      }
      if (!v.url.trim()) return 'Paste an iCal URL.';
      const res = await apiSend('/api/calendars', 'POST', { url: v.url.trim(), color: v.color });
      const data = await res.json();
      if (!res.ok) return data.error || 'Could not add calendar.';
      await refreshCalendars();
      document.getElementById('be-ics-status').textContent =
        `Added — ${data.count} event${data.count === 1 ? '' : 's'} found.`;
      return null;
    },
    remove: async c => {
      await apiSend(`/api/calendars/${c.id}`, 'DELETE');
      await refreshCalendars();
    },
  },

};

// ── Rows ─────────────────────────────────────────────────────
//
// One shape for every list in here: an optional swatch, the name, a mono meta
// line under it, and the › that opens the sheet. Nothing else is tappable.

function beRow(opts) {
  return `<button class="be-list-row${opts.dim ? ' be-dim' : ''}" data-row="${opts.id}">
    ${opts.color ? `<span class="be-swatch" style="background:${escHtml(opts.color)}"></span>` : ''}
    <span class="be-row-text">
      <span class="be-row-name">${escHtml(opts.name)}</span>
      ${opts.meta ? `<span class="be-row-meta">${escHtml(opts.meta)}</span>` : ''}
      ${opts.sub ? `<span class="be-row-sub${opts.subClass ? ' ' + opts.subClass : ''}">${escHtml(opts.sub)}</span>` : ''}
    </span>
    ${opts.badge ? `<span class="badge">${escHtml(opts.badge)}</span>` : ''}
    <span class="be-chev">›</span>
  </button>`;
}

function beAddRow(label) {
  return `<button class="be-add-row" data-add="1">+ ${escHtml(label)}</button>`;
}

// Wires a list's rows and its one add affordance to the sheet.
// `addKind`: the kind the add row opens, where it is not the rows' own — a
// block category is made by adding its first time.
function wireBeList(el, kind, items, addKind) {
  el.querySelectorAll('[data-row]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = items.find(i => String(i.id != null ? i.id : i.key) === btn.dataset.row);
      if (item) openSeSheet(kind, item);
    });
  });
  const add = el.querySelector('[data-add]');
  if (add) add.addEventListener('click', () => openSeSheet(addKind || kind, null));
}

// ── Wiring, open, close ──────────────────────────────────────

function initBlockEditor() {
  // The sections stand in SETTINGS_SECTIONS' order — the order the index reads.
  const panes = document.getElementById('be-panes');
  SETTINGS_SECTIONS.forEach(sec => {
    const el = panes.querySelector(`.be-section[data-betab-panel="${sec.key}"]`);
    if (el) panes.appendChild(el);
  });
  document.getElementById('modal-close').addEventListener('click', closeBlockEditor);
  document.getElementById('be-back').addEventListener('click', backToSettingsIndex);
  // No click-outside-to-close: Settings is a column beside the page, and the
  // page stays usable while it is up. The gear, ✕ and Esc are the ways out.


  // The block calendar, built by the server from the same resolved days the
  // timeline draws, saved on THIS device through the one download door.
  document.getElementById('be-download-ics-btn').addEventListener('click', async () => {
    const btn = document.getElementById('be-download-ics-btn');
    const status = document.getElementById('be-ics-status');
    btn.disabled = true;
    status.textContent = 'Saving…';
    const res = await fetch('/api/blocks/export.ics').catch(() => null);
    if (!res || !res.ok) {
      btn.disabled = false;
      status.textContent = 'Could not build the calendar';
      toast('Could not build the calendar');
      return;
    }
    const path = await saveDownload(`blocks-${wallDay()}.ics`, await res.text(), 'text/calendar');
    btn.disabled = false;
    status.textContent = `Saved ${path || 'blocks.ics'} to Downloads`;
  });
}

async function openBlockEditor() {
  // Up at once on the index as last drawn; every count below repaints it.
  settingsView.section = null;
  paintSettingsNav();
  document.getElementById('modal-overlay').classList.remove('hidden');
  await reloadSettingsState();
  renderBeAreas();
  renderBeBlocks();
  await renderQrManager();
  // Routines are the third recurring kind now, and they have their own fetch —
  // so the loader is asked for the section rather than being half-fed here.
  await refreshRecurringList();
  renderBeOccasions(await apiGet('/api/occasions', []));
  // Loaded on OPEN, not only when the section is entered: the index states
  // "N metrics" beside the row, and a count that reads 0 until you tap it is
  // worse than no count.
  await loadMetrics();
  renderMetricsSettings();
  await refreshTracking();
  renderBeCalendars();
  await renderSchedules();
  settingsView.section = null;
  closeSeSheet();
  renderSettingsIndex();
  paintSettingsNav();
  document.getElementById('modal-overlay').classList.remove('hidden');
}

async function closeBlockEditor() {
  closeSeSheet();
  document.getElementById('modal-overlay').classList.add('hidden');
  // The calendar FEED is re-read here and not after every write: a calendar
  // added in here is fetched once, on the way out, rather than per keystroke.
  state.gcalEvents = await apiGet('/api/gcal', state.gcalEvents);
  await refreshDayAfterSettings();
}

// ── ONE COPY, ONE REFRESH (2026-09-23, Quentin's report) ─────
//
// Adding a block did not show it. openBlockEditor and refreshBlockEditor each
// FETCHED the blocks and handed that copy to renderBeBlocks — which drew from
// state.blocks instead (beBlockGroups, so the list and the object door agree
// on group ids), and state.blocks was written only by loadAll and by closing
// Settings. Two copies of one dataset, a renderer reading the stale one, and
// the rest of the app brought up to date only on CLOSE — which a sheet opened
// from the calendar, a gate's read-out or MAP never reaches at all.
//
// So: Settings' datasets are read INTO state (reloadSettingsState) and every
// renderer of one takes no argument and reads state — there is no second copy
// to disagree with. And every sheet write passes through ONE refresh
// (submitSeSheet / removeSeItem → refreshAfterSettingsWrite), which re-reads
// them, redraws the lists and then the day that depends on them, wherever the
// sheet was opened from. client_rules_test holds both halves.
async function reloadSettingsState() {
  const [areas, domains, blocks, locations, calendars] = await Promise.all([
    apiGet('/api/areas', state.areas),
    apiGet('/api/domains', state.domains),
    apiGet('/api/blocks', state.blocks),
    apiGet('/api/locations', state.locations),
    apiGet('/api/calendars', state.calendars),
  ]);
  Object.assign(state, { areas, domains, blocks, locations, calendars });
}

// What the day reads from those: the block in force now, the viewed day's
// served segments, the pool and the timeline.
async function refreshDayAfterSettings() {
  await refreshTodaySegments();
  // Domains and area assignments can have changed, so section 2's obligation
  // may now be a different one. This goes before renderTimeline so a timeline
  // failure (a dead gate fetch, say) can't take section 2 down with it.
  state.activeDomainId = filingDomainId(state.activeBlock);
  state.section2OverrideDomainId = null;
  state.section2OverrideItems = null;
  await fetchOverridesForDate(state.currentDate);
  await refreshActiveItems();
  renderTimeline();
  // The week draws blocks too, and a category edited from its bar has to
  // show there without paging away and back. Not awaited: seven days take a
  // couple of seconds, and the sheet should not stand open that long.
  if (calWeek.on) refreshCalWeek();
}

// The settings lists, from state. Also what a write INSIDE a sheet (an action
// row's Call off) asks for, since it has not been through the door yet.
async function refreshBlockEditor() {
  await reloadSettingsState();
  renderBeAreas();
  renderBeBlocks();
  renderBeCalendars();
  renderInbox();
}

async function refreshAfterSettingsWrite() {
  await refreshBlockEditor();
  renderSettingsIndex();
  await refreshDayAfterSettings();
}

async function refreshCalendars() {
  state.calendars = await apiGet('/api/calendars', state.calendars);
  renderBeCalendars();
}

async function patchCalendar(id, body) {
  await apiSend(`/api/calendars/${id}`, 'PATCH', body);
}

// ── Section lists ────────────────────────────────────────────

// OCCASIONS ARE THE ONE SETTINGS KIND WITH NO `SETTINGS_SHEETS` ENTRY, on
// purpose. Every other kind is reached from exactly one place, so the shared
// se-sheet IS its editor. An occasion is reached from two — Settings, and the
// event on the day it fires on, which is the whole point of the feature (you
// configure it the moment you notice, not by remembering to visit a panel).
//
// Given two doors, the choice is one editor with two doors or two editors for
// one thing. A se-sheet is a flat field form and cannot hold the ACTIONS list,
// so the second option would make Settings the LESSER surface: rename, pause
// and delete here, but edit the actions only over there. So both doors open
// #oc-sheet, which does state the state row's own words (Active / Paused, with
// the hint) and does keep Delete in its foot — the rule's substance, in a
// clarify-shaped sheet rather than an se-shaped one (#fr-sheet is the
// precedent). Do NOT "fix" this by adding an occasion entry to SETTINGS_SHEETS.
function renderBeOccasions(occs) {
  const list = document.getElementById('be-occasions-list');
  if (!list) return;
  state.occasions = Array.isArray(occs) ? occs : [];
  beCounts.occasions = state.occasions.filter(o => o.active).length;
  list.innerHTML = `
    ${state.occasions.map(o => beRow({
      id: o.id, name: o.name, dim: !o.active,
      meta: `“${o.match_text}” · ${plural((o.items || []).length, 'action')}`,
      badge: o.active ? '' : 'paused',
    })).join('')}
    ${state.occasions.length ? '' : '<div class="empty">No occasions yet. '
      + 'Add one here, or tap an event on the day.</div>'}
    ${beAddRow('Add occasion')}`;
  // Not wireBeList: that opens the shared se-sheet, and an occasion's editor is
  // #oc-sheet (see the note above).
  list.querySelectorAll('[data-row]').forEach(btn => btn.addEventListener('click', () => {
    const o = state.occasions.find(x => String(x.id) === btn.dataset.row);
    if (o) openOccasionFor(o);
  }));
  const add = list.querySelector('[data-add]');
  if (add) add.addEventListener('click', () => openOccasionNew());
}

async function refreshBeOccasions() {
  renderBeOccasions(await apiGet('/api/occasions', state.occasions || []));
  if (settingsView.section == null) renderSettingsIndex();
}

function renderBeCalendars() {
  const list = document.getElementById('be-calendars-list');
  if (!list) return;
  const calendars = state.calendars || [];
  beCounts.calendars = calendars.filter(c => c.active).length;
  list.innerHTML = calendars.map(c => beRow({
    id: c.id, color: c.color, name: c.name, dim: !c.active,
    meta: c.active ? 'On the timeline' : 'Off the timeline',
    badge: c.active ? '' : 'paused',
  })).join('') + beAddRow('Add calendar');
  wireBeList(list, 'calendar', calendars);
}

function renderBeAreas() {
  const list = document.getElementById('be-areas-list');
  if (!list) return;
  const projects = state.areas || [];
  beCounts.areas = projects.filter(p => p.active).length;
  const domainName = id => (state.domains.find(d => d.id === id) || {}).name || 'no domain';
  list.innerHTML = projects.map(p => beRow({
    id: p.id, name: p.name, dim: !p.active,
    meta: `${p.type} · ${domainName(p.domain_id)}`,
    badge: p.active ? '' : 'paused',
  })).join('') + beAddRow('Add area');
  wireBeList(list, 'area', projects);
}

// Domains are permanent structure, so they live here with the areas rather than
// on the timeline.
function groupBlocks(blocks) {
  const groups = new Map();
  for (const b of blocks) {
    const key = `${b.label}|${b.color}|${b.start_time}|${b.end_time}|${filingKey(b)}|${
      b.location_id ?? ''}|${b.description || ''}|${b.priority || ''}`;
    if (!groups.has(key)) {
      groups.set(key, { ...b, days: [b.day_of_week], rows: [b] });
    } else {
      const g = groups.get(key);
      g.days.push(b.day_of_week);
      g.rows.push(b);
    }
  }
  return [...groups.values()].sort((a, b) => {
    const pa = a.project_name || '';
    const pb = b.project_name || '';
    return pa.localeCompare(pb) || a.label.localeCompare(b.label);
  });
}

function formatDays(days) {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return 'Every day';
  const isConsecutive = sorted.length >= 3 &&
    sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (isConsecutive) return `${weekdayName(sorted[0])}–${weekdayName(sorted[sorted.length - 1])}`;
  return sorted.map(weekdayName).join(', ');
}

function renderBeBlocks() {
  const list = document.getElementById('be-blocks-list');
  if (!list) return;
  // ONE ROW PER CATEGORY (blockCategories), its times listed under the name —
  // the category's sheet opens each time's own.
  const cats = blockCategories();
  beCounts.blocks = cats.length;
  list.innerHTML = cats.map(c => {
    const on = c.rows.filter(r => r.active);
    const mins = on.reduce((n, r) => n + spanEndMin(r.start_time, r.end_time) - timeToMinutes(r.start_time), 0);
    // A change dated forward is part of what this block IS from that day, so
    // the row says so — the whole point is not having to remember it.
    const from = c.groups.flatMap(blockGroupChanges).map(x => x.effective_date).sort()[0];
    return beRow({
      id: c.id, color: c.color, name: c.label,
      dim: !on.length,
      meta: `${c.rows.length}× a week · ${humanMinutes(mins)}`,
      sub: [from ? `changes ${seWhenLabel(from)}` : null, ...c.groups.map(blockTimeLabel)]
        .filter(Boolean).join(' · '),
      subClass: 'be-row-sub-wrap',
      badge: on.length ? (from ? 'scheduled' : '') : 'paused',
    });
  }).join('') + beAddRow('Add block');
  wireBeList(list, 'blockcat', cats, 'block');
}

// A BLOCK CATEGORY IS ITS NAME (2026-09-30, Quentin's instruction: "blocks
// unified by category … each block [has] multiple custom individual times" —
// COS330, purple: Mon 08:45–10:40 assignment time, Tue 10:40–12:00 class).
// Every block row already carried its own day, hours and description, and a
// course's week was already several rows of one label, so the category is not
// a new table: it is the rows that share a label, compared as a key
// (blockCatKey), with ONE colour its sheet writes to all of them. Each time
// inside it is a groupBlocks group — the same hours and purpose across its
// days — and keeps its own sheet.
function blockCatKey(label) {
  return String(label || '').trim().toLowerCase();
}

function blockCategories() {
  const cats = new Map();
  for (const g of beBlockGroups()) {
    const key = blockCatKey(g.label);
    if (!cats.has(key)) cats.set(key, { key, label: g.label, color: g.color, groups: [], rows: [] });
    const c = cats.get(key);
    c.groups.push(g);
    c.rows.push(...g.rows);
  }
  const byDay = g => Math.min(...g.days) * DAY_MIN + timeToMinutes(g.start_time);
  return [...cats.values()]
    .sort((x, y) => x.label.localeCompare(y.label))
    .map((c, i) => ({ ...c, id: `c${i}`, groups: c.groups.sort((x, y) => byDay(x) - byDay(y)) }));
}

function blockCategoryOf(label) {
  const key = blockCatKey(label);
  return blockCategories().find(c => c.key === key) || null;
}

// One time of a category, the way the list and the sheet both say it.
function blockTimeLabel(g) {
  return [formatDays(g.days), `${g.start_time}–${g.end_time}`, g.description || null,
          g.rows.some(r => r.active) ? null : '(paused)'].filter(Boolean).join(' ');
}

// Back to a category's sheet from one of its times — or, if that save moved
// the time out of it (renamed) and nothing is left, to the list.
function reopenBlockCategory(key) {
  return async () => {
    const c = blockCategories().find(x => x.key === key);
    if (c) { openSeSheet('blockcat', c); return; }
    closeSeSheet();
    renderSettingsIndex();
  };
}

function ordinalNth(n) {
  return ['1st', '2nd', '3rd', '4th', '5th'][n - 1] || `${n}th`;
}

// HOW OFTEN AN OUTCOME COMES BACK. All four are `monthly_date` — the day of the
// month is the anchor's — so this is one interval, not a new kind and not a
// second predicate: _recurring_due already answers "every N months from the
// anchor", and 12 of them is a year. No every-N-days and no weekly here on
// purpose: a weekly outcome is a routine, and routines already exist.
const REC_PERIODS = [
  { n: 1, label: 'Monthly' },
  { n: 3, label: 'Quarterly' },
  { n: 6, label: 'Twice a year' },
  { n: 12, label: 'Yearly' },
];

function recPeriodLabel(interval) {
  const p = REC_PERIODS.find(x => x.n === interval);
  return p ? p.label.toLowerCase() : `every ${interval} months`;
}

function recurringScheduleLabel(t) {
  const every = (n, unit) => n > 1 ? `every ${n} ${unit}s` : `every ${unit}`;
  if (t.kind === 'weekly') {
    const days = (t.days_of_week || '').split('').map(weekdayName).join(', ');
    return `${days} ${every(t.interval, 'week')}`;
  }
  if (t.kind === 'monthly_nth') return `${ordinalNth(t.nth)} ${weekdayName(t.weekday)} ${every(t.interval, 'month')}`;
  if (t.kind === 'monthly_date') {
    // A yearly one is a DATE — "1 February, yearly" is what it means, and
    // "day 1 every 12 months" is the same fact said in the least useful way.
    const day = parseInt(t.anchor_date.slice(8, 10));
    if (t.interval === 12) {
      const d = new Date(`${t.anchor_date}T12:00:00`);
      return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}, yearly`;
    }
    return REC_PERIODS.some(p => p.n === t.interval)
      ? `Day ${day}, ${recPeriodLabel(t.interval)}` : `Day ${day} ${every(t.interval, 'month')}`;
  }
  return `Every ${t.interval} days`;
}

async function refreshRecurringList() {
  const [tasks, areas] = await Promise.all([
    fetch('/api/recurring').then(r => r.json()),
    fetch('/api/areas').then(r => r.json()),
  ]);
  state.projects = await fetch('/api/projects').then(r => r.json());
  renderBeRecurring(tasks, areas);
}

function renderBeRecurring(tasks, areas) {
  const list = document.getElementById('be-recurring-list');
  if (!list) return;
  beCounts.recurring = tasks.filter(t => t.active).length;
  const byId = Object.fromEntries(areas.map(p => [p.id, p]));
  const projectName = id => ((state.projects || []).find(p => p.id === id) || {}).content;
  list.innerHTML = tasks.map(t => beRow({
    id: t.id, name: t.name, dim: !t.active,
    meta: recurringScheduleLabel(t),
    sub: [filingLabel(t) || null, projectName(t.project_id),
          t.spawn === 'project' && t.deadline_md
            ? `due ${recDueLabel(t.deadline_md)}` : null]
      .filter(Boolean).join(' · '),
    // Only the non-default state earns a badge, and a row that seeds an OUTCOME
    // is not the default. Paused wins the slot: it is the louder fact.
    badge: !t.active ? 'paused' : t.spawn === 'project' ? 'project' : '',
  })).join('') + beAddRow('Add recurring task')
    + `<button class="be-add-row" data-add-project="1">+ Add recurring project</button>`;
  // Two kinds, two editors, one per kind — an ACTION is a flat set of fields
  // (se-sheet) and an OUTCOME is decided in the clarify sheet, the way every
  // other project is. The row opens whichever one made it, so nothing has two
  // editors: the #oc-sheet bargain.
  list.querySelectorAll('[data-row]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = tasks.find(x => String(x.id) === btn.dataset.row);
      if (!t) return;
      if (t.spawn === 'project') openClarifyForRecurring(t, refreshRecurringList);
      else openSeSheet('recurring', t);
    });
  });
  const add = list.querySelector('[data-add]');
  if (add) add.addEventListener('click', () => openSeSheet('recurring', null));
  const addProj = list.querySelector('[data-add-project]');
  if (addProj) addProj.addEventListener('click',
    () => openClarifyForRecurring(null, refreshRecurringList));
}

async function checkActiveBlock() {
  // Fresh server truth for TODAY before deciding, every tick — a block
  // cancelled or moved is then in force within the minute, and a cached
  // answer here is exactly how the viewed day used to leak into "now".
  await refreshTodaySegments();
  const newBlock = detectCurrentStandardBlock();
  const newProjectId = newBlock ? newBlock.area_id || null : null;
  const newDomainId = filingDomainId(newBlock);
  if (newProjectId === state.activeAreaId && newDomainId === state.activeDomainId) return;
  state.activeBlock = newBlock;
  state.activeAreaId = newProjectId;
  const domainChanged = newDomainId !== state.activeDomainId;
  state.activeDomainId = newDomainId;
  state.section2OverrideDomainId = null;
  state.section2OverrideItems = null;
  if (section2RevertTimer) { clearTimeout(section2RevertTimer); section2RevertTimer = null; }
  // A block change inside the same domain leaves the item set alone — only the
  // highlighted area moves.
  if (!newDomainId) {
    state.activeDomainItems = [];
  } else if (domainChanged) {
    state.activeDomainItems = await fetch(`/api/inbox/active?domain_id=${newDomainId}`).then(r => r.json());
  }
  // Engage no longer narrows by domain (2026-09-30), but its chip names the
  // block in force, so a block change still repaints it.
  if (domainChanged) await refreshEngage();
  // The inbox processing view suggests the current block's area; follow the
  // block change unless the user is mid-edit inside the inbox.
  const inboxSection = document.getElementById('inbox-section');
  if (inboxSection && !inboxSection.contains(document.activeElement)) renderInbox();
}

// ── Midnight: the day starts over ─────────────────────────────
//
// The app is left open for days at a time. Every day-scoped FETCH already
// computes its date at call time, so nothing is wrong with what the server
// says — what rots is the data sitting in state from before midnight: the
// daily checklist still crossed off, the timeline still pointed at yesterday.
// This rides checkActiveBlock's 60s tick and also runs when the window comes
// back (a phone sleeps through midnight rather than ticking through it), and
// reloads the day the moment the local date moves.
let dayStamp = wallDay();

// The now-highlight has to move with the clock, and re-rendering the day every
// minute to move one class is both wasteful and the kind of repaint that
// clobbers whatever the user is holding (the capture-bar rule). The rows carry
// their own span, so the classes can be re-derived in place from the DOM.
function paintNowRows() {
  const rows = document.querySelectorAll('.eg-row[data-s]');
  if (!rows.length) return;
  const now = new Date();
  const today = formatDateYMD(now);
  const shown = formatDateYMD(egViewDate());
  // Same three-way clock as renderEngage: a future day has no now, a past day
  // is entirely past.
  const nowMin = shown === today ? now.getHours() * 60 + now.getMinutes()
    : shown < today ? 5760 : -1;
  rows.forEach(el => {
    const s = Number(el.dataset.s), e = Number(el.dataset.e);
    el.classList.toggle('eg-now', e > s && s <= nowMin && nowMin < e);
    el.classList.toggle('eg-past', e <= nowMin);
  });
}

async function checkDayRollover() {
  const now = wallDay();
  if (now === dayStamp) return;
  // Only follow the timeline forward if it was sitting on the old today; a day
  // deliberately navigated to stays where it was put.
  const follow = viewDay() === dayStamp;
  dayStamp = now;
  if (follow) {
    state.currentDate = new Date();
    await fetchOverridesForDate(state.currentDate);
  }
  await loadAll();
  if (!engageView.date) await refreshEngage();
  const lists = document.getElementById('tab-lists');
  if (lists && !lists.classList.contains('hidden')) await refreshRef();
}

// ── Weekly Review (GTD) ──────────────────────────────────────
// Allen's three-phase drill, as a checklist that persists per week. The three
// counts and the stalled-project list are the parts a paper checklist can't do:
// "every active project has a next action" is the review's load-bearing check
// and it is not runnable by hand.

// The two review tallies. Two vocabularies on purpose, no shared words:
// an EXPERIMENT resolves and is evaluated here — extend (adopt the change in
// another context) / habit (start forming it) / drop — and a HABIT is judged
// here — graduate (it is automatic; stop tracking) / continue / drop (turned
// out not worth it once installed — a verdict, not a failure). Graduation is
// a DECISION, not a threshold: the rule (30 days old, last 10 days >= 70%
// ran-on-its-own) only suggests, showing its inputs.
function habitHealthDot(t) {
  // Grey until 5 marks in the window — two data points must not render a
  // confident colour. The spectrum is computed (red 0 -> green 120), which is
  // why it is an inline hsl and not a theme var; 45% lightness reads on both
  // themes.
  if (t.health == null) return '<span class="gr-hb-dot" style="background:var(--border-soft)" title="fewer than 5 marks in 14 days"></span>';
  return `<span class="gr-hb-dot" style="background:hsl(${Math.round(t.health * 120)},55%,45%)" title="adherence ${Math.round(t.health * 100)}% over 14 days"></span>`;
}

// ── THE EDITOR IS REACHED FROM THE OBJECT, FOR EVERY DATATYPE ────────────
//
// (2026-08-30, Quentin's instruction.) An INDEX is for discovery; the OBJECT
// is for maintenance. Editing a block meant the hub, Settings, the Blocks
// list, the row, then the field — while the block itself was drawn in front of
// you. The gate got its own door first, hand-wired into its read-out; wiring a
// second one per datatype is how eleven slightly different doors get built, so
// this is the door ONCE.
//
// A drawn artifact declares itself in the markup — `data-obj="kind:id"` — and
// nothing else. No per-surface listener, no second control on the row, and a
// new surface that draws a block inherits the door by carrying the attribute.
// The same idiom as `data-hub`, `data-betab` and `data-row`.
//
// WHY A MODE rather than a gesture: on the artifacts that matter, every
// gesture is already spoken for and every one of them WRITES — a block's click
// cancels its day, its long-press hides it, its drag moves it; a gate's tap
// selects, its right-click calls the day off. There is no free gesture left,
// and taking one would mean a control that sometimes edits forever and
// sometimes changes today, which is exactly the ambiguity "two surfaces, never
// mixed" exists to forbid. So the door is a MODE you turn on: while it is on,
// every artifact on screen shows a chevron and one delegated handler opens its
// sheet. One grammar applied uniformly, instead of eleven exceptions.
//
// `find` may be async: some kinds have no reliable global (a routine, a
// metric), and a door that only worked when some other surface had happened to
// populate state would be a door that works most of the time.
const OBJECT_KINDS = {
  // No settings sheet: `opens` is the gate's editor, on its own page.
  gate: { noun: 'gate', opensLabel: 'Open in Gates…',
    // From the week, the day of the gate that was pressed; else the viewed day.
    opens: id => openGatesDashboard(id, (calWeek.on && calWeek.objDate) || viewDay()),
    find: id => (state.accountabilityNodes || []).find(n => String(n.id) === String(id)) },
  area: { noun: 'area',
    find: id => (state.areas || []).find(a => String(a.id) === String(id)) },
  domain: { noun: 'domain',
    find: id => (state.domains || []).find(d => String(d.id) === String(id)) },
  location: { noun: 'location',
    find: id => (state.locations || []).find(l => String(l.id) === String(id)) },
  // A block ROW is what the timeline draws; a block SHEET edits the GROUP (the
  // same block across its weekdays), which has no server id of its own. So the
  // door resolves row -> group the way renderBeBlocks numbers them, rather
  // than asking the timeline to know about grouping.
  block: { noun: 'block', find: id => beBlockGroups()
    .find(g => g.rows.some(r => String(r.id) === String(id))) },
  metric: { noun: 'metric',
    find: async id => (((await apiGet('/api/metrics/overview', {})) || {}).metrics || [])
      .find(m => String(m.id) === String(id)) },
  recurring: { noun: 'recurring task',
    find: async id => (await apiGet('/api/recurring', []))
      .find(t => String(t.id) === String(id)) },
  // A drawn plan span. Unlike every other kind here it is DAY data rather than
  // permanent structure, so its sheet has no Pause — see the named gap on
  // SETTINGS_SHEETS.planspan.
  // A block for ONE date (the local store). Fetched by id rather than found in
  // a cache: it is drawn on the day view, the week and Engage, each holding a
  // different day.
  dayblock: { noun: 'block',
    find: async id => {
      const r = await apiGet(`/api/day-blocks/${id}`, null);
      return r && r.id ? r : null;
    } },
  planspan: { noun: 'span',
    find: id => ((state.plan || {}).spans || []).find(s => String(s.id) === String(id)) },
};

// The block list's own numbering, in one place so the settings index and the
// door cannot disagree about which group `g3` is.
function beBlockGroups() {
  return groupBlocks(state.blocks || []).map((g, i) => ({ ...g, id: `g${i}` }));
}

// THE ONE OPENER. Every door goes through here, so "what happens when you ask
// to edit a thing" is answered once: resolve the object, refuse in WORDS if it
// has gone, and hand over to the sheet that already owns its three verbs.
async function openObjectSheet(kind, id, returnTo) {
  const spec = OBJECT_KINDS[kind];
  if (spec && spec.opens) { spec.opens(id); return true; }
  if (!spec || !SETTINGS_SHEETS[kind]) { toast('Nothing edits that yet'); return false; }
  let item = null;
  try { item = await spec.find(id); } catch (e) { item = null; }
  if (!item) { toast(`That ${spec.noun} is gone`); return false; }
  openSeSheet(kind, item, returnTo);
  return true;
}

// ── THE OBJECT MENU: an object's verbs, named ────────────────────────────
//
// This replaced an edit MODE (2026-08-30, Quentin's instruction, and he was
// right). The mode was verb-noun — declare "I am editing", then hunt for the
// thing — which is the model noun-verb replaced thirty years ago, and a mode
// is a mode: the same tap did different things depending on invisible state.
//
// The norm is a CONTEXT MENU, and it dissolves the objection that sent me to a
// mode in the first place. I had argued no gesture was free because every one
// of them already WROTE, and that overloading one would make a control which
// sometimes edits forever and sometimes changes today — but a menu ITEM IS
// LABELLED, so the ambiguity was an artifact of trying to say two things with
// one gesture. "Cancel for today" and "Edit block…" cannot be confused.
//
// It is better on the money path too: calling a gate's day off used to be an
// unlabelled right-click, and is now a named item you read before you pick it.
//
// The trigger is the platform norm and the app's own touch rule: right-click,
// or a 550ms long press. The DECLARATION is unchanged — `data-obj="kind:id"`
// still says what a thing is, so every artifact that had a door keeps it.
const objMenu = { open: false };

// A tap on a `data-obj-dbl` artifact is HELD this long, to see whether a
// second one follows. One store, so the hold cannot be started twice or
// outlive the element it was armed on.
const OBJTAP_MS = 250;
const objTap = { el: null, timer: null };

function objTapCancel() {
  if (objTap.timer) clearTimeout(objTap.timer);
  objTap.timer = null;
  objTap.el = null;
}

// `…` means "opens further UI", the convention every desktop menu uses. The
// day-level verbs a surface supplies come first and the editor last, because
// the frequent thing should not be under the rare one.
function objectMenuItems(kind, extra) {
  const spec = OBJECT_KINDS[kind];
  const items = (extra || []).slice();
  if (spec && spec.opens) {
    items.push({ label: spec.opensLabel, edit: true });
  } else if (spec && SETTINGS_SHEETS[kind]) {
    items.push({ label: `Edit ${spec.noun}…`, edit: true });
  }
  return items;
}

function closeObjectMenu() {
  const el = document.getElementById('obj-menu');
  if (el) el.remove();
  objMenu.open = false;
}

// Opened AT THE POINTER (Fitts), and kept on screen: a menu that opens under
// the thumb or off the bottom edge is a menu you cannot read on a phone, which
// is the same rule placeGatePop follows.
function openObjectMenu(x, y, kind, id, extra) {
  closeObjectMenu();
  objTapCancel();   // a menu arriving by any road voids a held tap
  const items = objectMenuItems(kind, extra);
  if (!items.length) return false;
  const el = document.createElement('div');
  el.id = 'obj-menu';
  el.innerHTML = items.map((it, i) => it.info
    ? `<div class="om-info">${escHtml(it.label)}</div>`
    : `<button class="om-item${it.danger ? ' om-danger' : ''}" data-i="${i}">${escHtml(it.label)}</button>`).join('');
  document.body.appendChild(el);

  const pad = 8;
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(pad, Math.min(x, window.innerWidth - w - pad))}px`;
  el.style.top = `${Math.max(pad, Math.min(y, window.innerHeight - h - pad))}px`;
  objMenu.open = true;

  // A SECOND CLICK IS NOT A CHOICE. The menu opens AT the pointer, so its
  // first item sits directly under it — and the first item is often the
  // dangerous one (remove this span, call this gate's day off). A stray
  // double-click therefore used to pick it, having shown it for a few
  // milliseconds. Nothing human answers a menu it has not read yet, so the
  // first moment of one is not a target.
  const openedAt = Date.now();
  el.querySelectorAll('.om-item').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      if (Date.now() - openedAt < 250) return;
      const it = items[parseInt(btn.dataset.i)];
      closeObjectMenu();
      if (it.edit) openObjectSheet(kind, id);
      else if (it.run) it.run();
    });
  });
  // Any tap elsewhere dismisses, like every menu. Deferred by a frame or the
  // very click that opened it would close it again.
  setTimeout(() => document.addEventListener('pointerdown', function once(ev) {
    if (ev.target.closest && ev.target.closest('#obj-menu')) {
      document.addEventListener('pointerdown', once, { once: true });
      return;
    }
    closeObjectMenu();
  }, { once: true }), 0);
  return true;
}

// ONE delegated pair of triggers for every declared artifact. A surface that
// wants day-level verbs in the menu registers them by kind+id through
// `objectVerbs`; everything else gets the editor alone, which is still one
// gesture instead of five taps through Settings.
function verbsFor(kind, id, el) {
  // (objectVerbProviders is declared at the top of the file: surfaces register
  // into it while the script is still evaluating, long before this runs.)
  const out = [];
  objectVerbProviders.forEach(fn => {
    try { (fn(kind, id, el) || []).forEach(v => out.push(v)); } catch (e) {}
  });
  // Each provider answers only for its own surface, so an object drawn on two
  // of them does not collect both surfaces' idea of "today".
  return out;
}

// RIGHT-CLICK REMOVES, ON THE CALENDAR (2026-09-30, Quentin's instruction:
// "allow me to right click to remove gates/blocks/events"). A surface may mark
// ONE of its verbs `rightClick` — the Calendar marks the day-level removal of a
// block (cancel it for that day) and a gate (call that day off) — and then the
// right-click and the 550ms hold RUN it instead of opening the menu, the way a
// fetched event's right-click has always hidden it. The menu is still one tap
// away where it matters: a block's plain click opens it, and a gate's read-out
// has its door. Every such verb is undoable, and a gate's goes through the
// store the judge reads, so the 24h lock still decides whether it lands.
function openObjectMenuOrRemove(x, y, kind, id, el) {
  const verbs = verbsFor(kind, id, el);
  const direct = verbs.find(v => v.rightClick);
  if (direct) { direct.run(); return; }
  openObjectMenu(x, y, kind, id, verbs);
}

function initObjectDoors() {
  // LEFT CLICK, where the object has nothing else for it to mean. Opt-in
  // (`data-obj-tap`) rather than automatic: most artifacts that carry a door
  // already do something on click — a pool row opens clarify, a run button
  // runs the routine — and hijacking those would be the same overreach as
  // taking a gesture that was already spoken for.
  //
  // A click that landed on a real control INSIDE the object is that control's,
  // not the object's: the routine row opens its menu, and the ▶ on it still
  // runs the routine.
  document.addEventListener('click', e => {
    // A MODIFIED click is somebody else's gesture, explicitly: Engage's blocks
    // and events take ⌘-click and say so in their own titles. This handler is
    // in the capture phase, so without the bail it would swallow them.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // A CLICK THAT TRAILS A DRAG IS NOT A TAP. A mouse drag ends with one, on
    // the very artifact it just moved, and this handler is in the capture
    // phase — so the drag surface's own stopPropagation runs too late to stop
    // it. Every menu here opened by itself on the drop until this line.
    if (justPointerDragged()) return;
    const el = e.target.closest('[data-obj-tap]');
    // A tap that moved to a different artifact abandons any held menu.
    if (objTap.el && objTap.el !== el) objTapCancel();
    if (!el) return;
    if (e.target.closest('button, a, input, select, textarea') !== null
        && e.target.closest('button, a, input, select, textarea') !== el) return;
    const [kind, id] = String(el.dataset.obj || '').split(':');
    if (!OBJECT_KINDS[kind]) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    const x = e.clientX || r.left + r.width / 2;
    const y = e.clientY || r.top + 8;
    // DOUBLE-CLICK IS A SECOND DOOR TO THE EDITOR (2026-09-10, Quentin's
    // instruction, for the plan's spans). Opt-in per artifact
    // (`data-obj-dbl`), because it costs the menu the OBJTAP_MS it has to
    // wait to find out whether a second click is coming — a price only an
    // artifact whose editor is reached often should pay.
    //
    // It is not a touch gesture and does not have to be: the menu's
    // `Edit …` is the finger's path to the same sheet, which is the rename
    // rule's precedent (double-click is a poor phone gesture, so it is never
    // the ONLY way).
    //
    // Holding the menu is also what makes the gesture possible at all. The
    // menu opens under the pointer, so if the first click opened it the
    // second would land on the menu instead of the artifact and the dblclick
    // would never reach here.
    if (el.dataset.objDbl) {
      if (objTap.el === el && objTap.timer) {
        objTapCancel();
        // A span's double-click is its location, typed in place; any other
        // artifact that opts in still gets its editor.
        if (kind === 'planspan') editPlanSpanLocation(id, el);
        else openObjectSheet(kind, id);
        return;
      }
      objTap.el = el;
      objTap.timer = setTimeout(() => {
        objTapCancel();
        openObjectMenu(x, y, kind, id, verbsFor(kind, id, el));
      }, OBJTAP_MS);
      return;
    }
    openObjectMenu(x, y, kind, id, verbsFor(kind, id, el));
  }, true);

  // CAPTURE phase: the artifacts this covers have their own contextmenu and
  // long-press handlers that write, and the menu has to win the event rather
  // than arrive after the write has already happened.
  document.addEventListener('contextmenu', e => {
    const el = e.target.closest('[data-obj]');
    if (!el) return;
    const [kind, id] = String(el.dataset.obj).split(':');
    if (!OBJECT_KINDS[kind]) return;
    e.preventDefault();
    e.stopPropagation();
    openObjectMenuOrRemove(e.clientX, e.clientY, kind, id, el);
  }, true);

  // The finger's way in, and the same 550ms the rest of the app uses. Bound
  // once on the document rather than per element, so an artifact rendered
  // later is covered without being wired.
  let lpTimer = null, lpAt = null;
  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const el = e.target.closest('[data-obj]');
    if (!el) return;
    const [kind, id] = String(el.dataset.obj).split(':');
    if (!OBJECT_KINDS[kind]) return;
    lpAt = { x: e.clientX, y: e.clientY };
    lpTimer = setTimeout(() => {
      lpTimer = null;
      // A drag that armed on the same press owns it — onPointerDrag claims the
      // press at pointerdown, and the menu stands down exactly like onLongPress.
      if (e.pointerDragClaim) return;
      openObjectMenuOrRemove(lpAt.x, lpAt.y, kind, id, el);
    }, 550);
  }, true);
  const cancelLp = e => {
    if (lpTimer && lpAt && e.clientX != null
        && Math.hypot(e.clientX - lpAt.x, e.clientY - lpAt.y) < 8) return;
    clearTimeout(lpTimer); lpTimer = null;
  };
  document.addEventListener('pointermove', cancelLp, true);
  document.addEventListener('pointerup', () => { clearTimeout(lpTimer); lpTimer = null; }, true);
  document.addEventListener('pointercancel', () => { clearTimeout(lpTimer); lpTimer = null; }, true);
}

// ── OPEN B OVER A, AND COME BACK ─────────────────────────────
//
// One surface raised above another, then put back down where you left off.
// This was written three times before it existed as a thing:
// `be-sheet-open` (the settings sheet over the settings modal),
// `crm-over-runner` (People over the routine runner, since retired) and
// `map-over-runner` (MAP over that same runner) — the third arriving with a
// comment telling it to copy the second, which is the sound a missing abstraction makes. Each
// invented its own z-bump, its own way back down and its own rung on the Esc
// ladder, and the ladder had to be edited by hand every time.
//
// (`clarifySnapshot` is NOT one of these. It restores one sheet's half-made
// state when that sheet is re-entered, which is a different question — no
// z-layer, no ladder. It COMPOSES with this through `back` rather than being
// absorbed by it.)
//
// One stack, innermost last. A layer names itself and says how to raise and
// lower itself; `back` is what to do once it is down — re-read the surface it
// was covering, restore a snapshot, reopen a popup. `lower` is the Z-LAYER
// only: closing the SURFACE stays the surface's own job, because a layer that
// closed its own overlay would fight the overlay's close handler for who goes
// first.
const overLayers = [];

function openOver(name, spec) {
  const { raise, lower, back } = spec || {};
  if (raise) raise();
  overLayers.push({ name, lower, back });
}

function overIsOpen(name) {
  return overLayers.some(l => l.name === name);
}

// Put ONE layer down: the innermost, or the innermost carrying this name.
// Returns whether anything came down, so Esc can tell "I handled it" from
// "nothing of mine was up" without asking a second question first.
function closeOver(name) {
  let i = -1;
  for (let n = overLayers.length - 1; n >= 0; n--) {
    if (!name || overLayers[n].name === name) { i = n; break; }
  }
  if (i < 0) return false;
  const layer = overLayers.splice(i, 1)[0];
  if (layer.lower) layer.lower();
  if (layer.back) layer.back();
  return true;
}

// ── Hub rail + mobile overlays (9c) ──────────────────────────
// The day is the whole screen; every reference surface is a full-screen
// overlay reached from the ≡ hub in the capture bar. One surface at a time.

function openM(id) {
  document.querySelectorAll('.m-overlay').forEach(o => o.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  // Labels are measured, and a hidden calendar measures nothing.
  if (id === 'cal-overlay') requestAnimationFrame(settleTimelineLabels);
  renderBar();   // derived modes (✎ log / ✎ list / ◉ <list>) follow the surface
}

function closeM(id) {
  flushOpenNotes();
  const el = document.getElementById(id);
  el.classList.add('hidden');
  if (id === 'cal-overlay') { clearCalPin(); hideBlockHover(); }
  renderBar();
}

function initHub() {
  // Tapping anywhere else closes the read-out — the backdrop is transparent and
  // covers the screen, so the day stays visible behind what is describing it.
  document.getElementById('gate-pop-backdrop')
    .addEventListener('click', closeGatePop);
  document.getElementById('event-pop-backdrop')
    .addEventListener('click', closeEventPop);
  document.querySelectorAll('.m-close').forEach(btn => {
    btn.addEventListener('click', () => closeM(btn.dataset.close));
  });
  // THE PEEL ORDER, innermost first. Sheets put their own rungs on this
  // scale through defineSheet (their ranks are beside them); these are the
  // rest. A rung returns true when it took the key.
  //   -10 schedule picker   0 clarify   5 flush notes (never takes the key)
  //    10 settings sheet   20–29 read-outs, menus, transient calendar state
  //    30 occasion sheet   40 legacy overlays   50–53 ctx / event / entry /
  //    ending sheets       70–71 Social, Lists
  //    80 the .m-overlay band   90 Engage's routine card
  escRung(5, () => { flushOpenNotes(); return false; });
  // The gate read-out is the next layer in (a popup beside its pill, over
  // the calendar), so it peels before anything under it.
  escRung(20, () => { if (gatePop.nodeId == null) return false; closeGatePop(); return true; });
  // The event read-out shares the gate read-out's layer, so it peels on the
  // same rung — before the occasion sheet it can open, which sits above.
  escRung(21, () => { if (eventPop.key == null) return false; closeEventPop(); return true; });
  // A menu is always the innermost thing on screen and closing it is free,
  // so it peels before anything else Esc could reach.
  escRung(22, () => { if (!objMenu.open) return false; closeObjectMenu(); return true; });
  // A selected gate is transient state over the calendar — it peels after the
  // read-out it opens and before the overlay it is drawn on.
  escRung(23, () => clearGateSel());
  // The week's legend and range panel are transient over the calendar too.
  escRung(24, () => closeCalWeekPops());
  // So is a category lit up on it.
  escRung(25, () => clearCalPin());
  // MAP's filter menu is a transient layer again (23a) — it peels before the
  // MAP overlay in the loop below, the way every sheet peels before what
  // opened it.
  escRung(26, () => mapFilter.close() || hzMenu.close());
  escRung(29, () => calFilter.close());
  // Legacy modal overlays (they sit above the m-overlays), innermost wins; the
  // person-detail/bucket/add trio stack over People. The order here IS the
  // z-order: Settings (155) sits above map (150) and the .m-overlay band
  // (140) because it opens over whatever you already had up.
  escRung(40, () => {
    for (const id of ['person-add-overlay', 'bucket-mgr-overlay', 'person-detail-overlay',
                      'modal-overlay', 'map-overlay']) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) {
        // MAP's close does more than hide it (notes flush), so Esc goes
        // through the button rather than past it.
        if (id === 'map-overlay') document.getElementById('map-close').click();
        else if (id === 'modal-overlay' && settingsView.section) backToSettingsIndex();
        else if (id === 'modal-overlay') closeBlockEditor();
        else el.classList.add('hidden');
        return true;
      }
    }
    return false;
  });
  // Social peels an open spec/log form before ANYTHING that closes the
  // surface under it. (The focused-input case stopPropagates and never
  // reaches here.)
  escRung(70, () => {
    const soEl = document.getElementById('tab-social');
    if (!soEl || soEl.classList.contains('hidden') || !socialView.form) return false;
    socialView.form = null;
    renderSocial();
    return true;
  });
  // Lists peels an open list back one LEVEL first — a nested list goes to
  // its parent, everything else to the index.
  escRung(71, () => {
    const refEl = document.getElementById('tab-lists');
    if (!refEl || refEl.classList.contains('hidden') || refView.open == null) return false;
    const openList = refView.lists.find(l => l.id === refView.open);
    refView.open = (openList && openList.parent_id) || null;
    renderRef();
    return true;
  });
  escRung(80, () => {
    const open = [...document.querySelectorAll('.m-overlay:not(.hidden)')].pop();
    if (!open) return false;
    closeM(open.id);
    return true;
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    for (const rung of ESC_RUNGS) if (rung.peel()) return;
  });
}

// ── THE TOP STRIP (Navigation Options 8b, 2026-10-01) ────────
//
// One line of tabs over every surface. A tab is a DOOR, not a second opener:
// it puts down whatever is up and asks openSurface, the hub's own opener, so
// the strip cannot drift from the ≡ buttons. Which tab is lit is read off
// currentRoute() by paintTopNav, called from syncRoute — the address is the
// one record of what is on screen, and the strip only reads it.
function initTopNav() {
  const nav = document.getElementById('top-nav');
  nav.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.nav));
  });
  // TWO VERBS ON ONE EYE (2026-09-16, Quentin's instruction). The plain click
  // is the one you reach for in a hurry — privacy — and the panel, which is
  // set once and then left alone for weeks, moves to the second gesture. Both
  // halves of that second gesture, since a right-click is not a thing a finger
  // has: right-click AND the 550ms long press, the app's own touch rule.
  // Wired ONCE: the eye lives in the static strip now, not in Engage's header.
  document.getElementById('eg-undo').addEventListener('click', runUndo);
  paintUndo();
  const eye = document.getElementById('eg-panel-btn');
  paintPrivacyEye();
  // onLongPress swallows the click that trails a fired hold (capture phase,
  // before this one), so the plain click here is only ever a plain click.
  eye.addEventListener('click', togglePrivacy);
  // PC: the evergreen pywebview panel. Phone (no pywebview): the same active
  // section, full-screened.
  const nowDoor = async () => {
    if (window.pywebview) {
      await togglePanel();
    } else {
      await navigateTo('');
      openM('now-full');
      renderNowFull();
    }
  };
  eye.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    nowDoor();
  });
  onLongPress(eye, nowDoor);
  wireEdgeFade(nav.querySelector('.tn-tabs'));
  nav.querySelectorAll('.tn-search input').forEach(wireEdgeFade);
  window.addEventListener('resize', () =>
    document.querySelectorAll('.edge-fade').forEach(paintEdgeFade));
  paintTopNav();
}

// ── THE STRIP'S MENUS: ONE COMPONENT (2026-10-05) ─────────────
// Projects, Log and Calendar each wrote their selector out in full: the pill's
// text and ▾ and narrowed state, the menu shown or emptied, section titles over
// chip rows, the same ∧-required tag chips, the same Order pair, the same
// "show everything" foot, a close() for the Esc ladder, and a document tap-off.
// Two of the tap-offs asked `closest()` of the click's target, which a chip's
// own repaint had already detached — so they leaned on every chip remembering
// to stopPropagation, and Projects' menu was placed by a stale
// `#map-filter-menu` rule that outranked `.tn-menu`. One component now: the
// pill and the document are wired ONCE here, and the tap-off reads
// composedPath(), which still holds a node that has since been replaced.
//
// spec: pill / menu (ids), title, isOpen(), setOpen(on), pillText() →
// {text, narrowed}, sections() → [{title, chips | html}] (falsy skipped),
// foot() → html, clear() (offered as "show everything" while narrowed),
// onChange() after a pick, wire(menu, stay) for the surface's own controls.
// `stay(el, fn)` runs fn then onChange; the menu stays open across picks.
function stripMenu(spec) {
  const pill = document.getElementById(spec.pill);
  const menu = document.getElementById(spec.menu);
  // stopPropagation still, though the tap-off no longer needs it: a menu sits
  // inside a page whose own click handlers have no business with its chips.
  const stay = (el, fn) => el.addEventListener('click', e => {
    e.stopPropagation();
    fn();
    spec.onChange();
  });
  function render() {
    const p = spec.pillText();
    pill.textContent = `${p.text} ▾`;
    pill.classList.toggle('tn-pill-on', !!p.narrowed);
    pill.title = spec.title;
    menu.classList.toggle('hidden', !spec.isOpen());
    if (!spec.isOpen()) { menu.innerHTML = ''; return; }
    const foot = (p.narrowed && spec.clear
      ? '<button class="chip" data-tn-clear>⟳ show everything</button>' : '')
      + (spec.foot ? spec.foot() : '');
    menu.innerHTML = spec.sections().filter(Boolean).map(s =>
      `<div class="tn-menu-sec">${escHtml(s.title)}</div>${
        s.chips != null ? `<div class="tn-menu-chips">${s.chips}</div>` : s.html}`).join('')
      + (foot ? `<div class="tn-menu-foot">${foot}</div>` : '');
    const clear = menu.querySelector('[data-tn-clear]');
    if (clear) stay(clear, spec.clear);
    spec.wire(menu, stay);
  }
  function close() {
    if (!spec.isOpen()) return false;
    spec.setOpen(false);
    render();
    return true;
  }
  pill.addEventListener('click', e => {
    e.stopPropagation();
    spec.setOpen(!spec.isOpen());
    render();
  });
  document.addEventListener('click', e => {
    if (spec.isOpen() && !e.composedPath().some(n => n === menu || n === pill)) close();
  });
  return { render, close };
}

// A menu's tag vocabulary: every selected tag REQUIRED, said the same way
// wherever tags narrow a list (∧ on the chip, the title saying which).
function tagChipsHtml(vocab, selected, attr, empty) {
  if (!vocab.length) return empty ? `<span class="cl-hint">${escHtml(empty)}</span>` : '';
  return vocab.map(t => {
    const on = selected.has(t);
    return `<button class="chip${on ? ' on' : ''}" ${attr}="${escHtml(t)}"
      title="${on ? 'required — click to clear' : 'click to require'}"
      >${on ? '∧' : ''}${escHtml(t)}</button>`;
  }).join('');
}

// One of several, exactly one lit (a lens, an order, Day | Week).
function pickChipsHtml(opts, current, attr) {
  return opts.map(o => `<button class="chip${o.value === current ? ' on' : ''}"
    ${attr}="${escHtml(o.value)}"${o.title ? ` title="${escHtml(o.title)}"` : ''}
    >${escHtml(o.label)}</button>`).join('');
}

// An independent on/off.
function toggleChipHtml(on, attrs, label) {
  return `<button class="chip${on ? ' on' : ''}" ${attrs}>${escHtml(label)}</button>`;
}

function toggleInSet(set, v) {
  if (set.has(v)) set.delete(v);
  else set.add(v);
}

// TEXT FADES AT A BAR'S EDGE (2026-10-02, Quentin's instruction): the strip's
// tabs and the bars' fields used to stop dead mid-word. Whichever side has
// more text past it fades (.fade-l / .fade-r), so the cut says "there is
// more" — read off the element's own scroll, so it is right at any width.
function paintEdgeFade(el) {
  const max = el.scrollWidth - el.clientWidth;
  el.classList.toggle('fade-l', el.scrollLeft > 1);
  el.classList.toggle('fade-r', el.scrollLeft < max - 1);
}
function wireEdgeFade(el) {
  el.classList.add('edge-fade');
  // A frame later: a field scrolls to its caret AFTER the key or the blur.
  const paint = () => requestAnimationFrame(() => paintEdgeFade(el));
  ['scroll', 'input', 'focus', 'blur', 'keyup', 'pointerup'].forEach(t =>
    el.addEventListener(t, paint));
  paint();
}

function paintTopNav() {
  // Mid-switch the screen is briefly NOW (one page down, the next not up
  // yet); the tab lights for where you are going, not that gap.
  const top = routeView.moving ? routeView.target : currentRoute().split('/')[0];
  const lit = top;
  document.querySelectorAll('#top-nav [data-nav]').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.nav === lit);
  });
  calFilter.render();
  // Each page's selector and search, shown only while it is that page.
  document.querySelectorAll('#top-nav .tn-tools').forEach(g =>
    g.classList.toggle('hidden', g.dataset.page !== lit));
  if (lit === 'calendar') calFilter.render();
  // The page's tools just took (or gave back) the tabs' width.
  document.querySelectorAll('#top-nav .edge-fade').forEach(paintEdgeFade);
}

// Put down every surface over the day — the top-level rungs of the Esc
// ladder, each through its own close so nothing it flushes is skipped.
async function closeSurfaces() {
  const shown = id => {
    const el = document.getElementById(id);
    return !!el && !el.classList.contains('hidden');
  };
  flushOpenNotes();
  mapFilter.close();
  hzMenu.close();
  calFilter.close();
  if (seSheet.kind) closeSeSheet();
  if (occasionView.open) closeOccasionSheet();
  // Not awaited: each hides itself FIRST and then finishes its writes and
  // re-reads (Settings' feed + day refresh) in the background.
  // Waiting on them is what made the next page lag behind the click.
  if (shown('modal-overlay')) closeBlockEditor();
  if (shown('map-overlay')) document.getElementById('map-close').click();
  document.querySelectorAll('.m-overlay:not(.hidden)').forEach(o => closeM(o.id));
}

async function navigateTo(dest) {
  if (dest === 'gates') dest = 'settings/qr';
  if (dest === 'tracking') dest = 'settings/tracking';
  // The gear is a toggle: Settings is a column beside the page, so a second
  // press puts it down and leaves the page as it was.
  if (dest === 'settings' && currentRoute().startsWith('settings')) {
    await closeBlockEditor();
    return;
  }
  await goRoute(dest, true);
}

// ONE SWITCH, ONE ADDRESS (2026-10-01, Quentin's report: the URL read "/"
// and then "/#/map" on every click, and switching lagged). The address is
// written ONCE, after the page is up — pushed for a click, so Back works —
// and nothing the switch does on the way (the old page going down, the day
// showing for a moment) gets to write one of its own.
async function goRoute(route, push) {
  // Leaving the Calendar mid-pick gives the pick up: clarify comes back.
  const pk = clarifyView.picking && CLARIFY_FLOWS.find(f => f.key === clarifyView.picking.flow);
  const pickLeft = !!pk && String(route).split('/')[0] !== pk.route().split('/')[0];
  if (pickLeft) clarifyView.picking = null;
  routeView.moving = true;
  routeView.target = String(route || '').split('/')[0];
  paintTopNav();
  // The address goes up WITH the click, not after the page has read its data
  // (Settings and the week read a dozen things first). The Calendar's day/week
  // is decided now by the same rule openSurface asks, so the address it gets
  // is the one it keeps.
  const lands = route === 'calendar' && calWeekAvailable() && calWantsWeek() ? 'calendar/week' : route;
  if (push && location.pathname !== routePath(lands)) history.pushState(null, '', routePath(lands));
  try {
    // SETTINGS IS A COLUMN, NOT A PAGE (2026-10-05, Quentin's instruction):
    // it opens beside whatever is up, so it puts nothing down.
    if (!String(route).startsWith('settings')) await closeSurfaces();
    if (route) await openRoute(route);
  } finally {
    routeView.moving = false;
  }
  syncRoute();
  if (pickLeft && clarifyView.open) renderClarify();
}

// THE ONE OPENER for a hub surface, asked by the hub's buttons and by the
// address bar alike — a route that re-did what a button does would be the
// parallel implementation that agrees until one of them grows a step. `sub` is
// the level inside it (a list, a log, a settings section).
async function openSurface(dest, sub) {
  sub = sub || {};
  if (dest === 'calendar') {
    openM('cal-overlay');
    // An address that names the week asks for it; any other opening follows
    // the window. A bare `calendar` is NOT a request for the day: the last
    // route is shared by every device, so the phone's day must not pin the
    // laptop to it.
    if (sub.view === 'week') calWeek.pref = 'week';
    await setCalView(calWantsWeek());
    if (sub.view === 'week' && !calWeek.on && sub.say) {
      toast('The week needs a window at least 800px wide — showing the day');
    }
    renderTimeline();
  }
  else if (dest === 'lists') {
    refView.open = sub.list != null ? sub.list : null;
    openM('tab-lists');
    refreshRef();
  }
  else if (dest === 'map') { openMap(sub.horizon); }
  else if (dest === 'tracking') { await openSurface('settings', { section: 'tracking' }); }
  else if (dest === 'gates') { await openSurface('settings', { section: 'qr' }); }
  else if (dest === 'social') {
    // Belt-and-braces: the button is hidden below, but the hub is also
    // reachable by keyboard and a dead door is worse than an absent one.
    if (!socialEnabled()) return;
    socialView.form = null; openM('tab-social'); refreshSocial();
  }
  else if (dest === 'settings') {
    await openBlockEditor();
    if (sub.section && SETTINGS_SECTIONS.some(s => s.key === sub.section)) {
      openSettingsSection(sub.section);
    }
  }
}

// ── WHERE YOU WERE: every surface has an address ─────────────
//
// (2026-09-15, Quentin's instruction: "start back where I was operating
// from".) The address is a HASH (`#/lists/12`) because Flask serves one shell
// at `/` and must stay JSON-only; nothing server-side routes on it.
//
// It is DERIVED from what is on screen, never kept beside it: a second record
// of "which overlay is open" would be one more thing the Esc ladder had to
// remember to update. Openers stay unaware of it — the overlays' class changes
// and the three renders that change a level inside a surface call syncRoute.
//
// The last address is ALSO a setting row, not only localStorage: pywebview
// runs in private mode, so the desktop window forgets its storage on every
// launch, and a phone and the laptop reading one server is where "where was
// I" is actually asked. An address in the URL itself wins over the remembered
// one.
function currentRoute() {
  const shown = id => {
    const el = document.getElementById(id);
    return !!el && !el.classList.contains('hidden');
  };
  if (shown('modal-overlay')) return settingsView.section ? `settings/${settingsView.section}` : 'settings';
  if (shown('map-overlay')) return mapView.horizon === 'projects' ? 'map' : `map/${mapView.horizon}`;
  if (shown('tab-lists')) {
    return refView.open != null ? `lists/${refView.open}` : 'lists';
  }
  if (shown('cal-overlay') && calWeek.on) return 'calendar/week';
  for (const [id, name] of [['cal-overlay', 'calendar'], ['tab-social', 'social']]) {
    if (shown(id)) return name;
  }
  return '';
}

const routeView = { ready: false, saved: null, timer: null, moving: false, target: '' };

// A route is the app's own name for a page (`map`, `lists/12`); the PATH is
// what the address bar shows (`/projects`, `/lists/12`). One page is named
// differently out there, after its tab. Flask serves the shell at every one
// of these (APP_PAGES in app.py). The Log left for ef-writing (2026-10-06):
// an old `logs` route or `/log` path opens nothing, which lands on Now.
const ROUTE_PATHS = { map: 'horizons' };
// An address from before the page was renamed (2026-10-07) still opens it.
const OLD_ROUTE_PATHS = { projects: 'map' };

function routePath(route) {
  if (!route) return '/';
  const [top, ...rest] = route.split('/');
  return '/' + [ROUTE_PATHS[top] || top, ...rest].join('/');
}

function pathRoute(path) {
  const [top, ...rest] = String(path || '').replace(/^\/+|\/+$/g, '').split('/');
  if (!top || top === 'now') return '';
  const name = Object.keys(ROUTE_PATHS).find(k => ROUTE_PATHS[k] === top)
    || OLD_ROUTE_PATHS[top] || top;
  return [name, ...rest].join('/');
}

function syncRoute() {
  paintTopNav();
  // Nothing is written until the remembered address has been reopened, or
  // the empty screen of a page still loading would overwrite it — nor while
  // a switch is under way, which writes its one address when it lands.
  if (!routeView.ready || routeView.moving) return;
  const route = currentRoute();
  const want = routePath(route);
  if (location.pathname + location.hash !== want) history.replaceState(null, '', want + location.search);
  if (route === routeView.saved) return;
  clearTimeout(routeView.timer);
  routeView.timer = setTimeout(() => {
    routeView.saved = route;
    apiSend('/api/settings', 'PATCH', { last_route: route }).catch(() => {});
  }, 1000);
}

async function openRoute(route) {
  const [top, a, b] = String(route || '').replace(/^#?\/?/, '').split('/');
  const num = v => (/^\d+$/.test(v || '') ? parseInt(v) : null);
  // `run/<id>` and `lists/routine/<id>` were the routine runner and editor;
  // both are gone (2026-10-05), so an old address lands on Lists.
  if (top === 'run') await openSurface('lists', {});
  else if (top === 'lists') {
    await openSurface('lists', a === 'routine' ? {} : { list: num(a) });
  }
  else if (top === 'settings') await openSurface('settings', { section: a });
  else if (top === 'calendar') {
    // Said out loud only when the ADDRESS BAR asked; a remembered route
    // restored on the phone is not something to apologise for.
    await openSurface('calendar', { view: a === 'week' ? 'week' : null,
                                    say: routeView.fromAddress && a === 'week' });
  }
  else if (top === 'map') await openSurface('map', { horizon: a });
  else if (['tracking', 'social'].includes(top)) await openSurface(top);
}

async function initRoutes() {
  const saved = (state.settings || {}).last_route;
  routeView.saved = saved == null ? '' : saved;
  // The address wins: a path (`/projects`), or an old `#/map` link. Only a
  // bare `/` falls back to where you last were; `/now` means the day.
  routeView.fromAddress = true;
  const route = location.hash.length > 2 ? location.hash.replace(/^#\/?/, '')
    : location.pathname !== '/' ? pathRoute(location.pathname) : routeView.saved;
  try { await openRoute(route); } catch (e) {}
  routeView.fromAddress = false;
  routeView.ready = true;
  const watch = new MutationObserver(syncRoute);
  ['modal-overlay', 'map-overlay', 'cal-overlay', 'tab-lists',
   'tab-social'].forEach(id => {
    const el = document.getElementById(id);
    if (el) watch.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  // Back and Forward go where the address says; so does a pasted old
  // `#/…` link, which then turns into its path.
  window.addEventListener('popstate', () => goRoute(pathRoute(location.pathname), false));
  window.addEventListener('hashchange', () => {
    if (location.hash.length > 2) goRoute(location.hash.replace(/^#\/?/, ''), false);
  });
  syncRoute();
}


const refView = { lists: [], open: null };

async function refreshRef() {
  refView.lists = await apiGet('/api/ref', refView.lists);
  renderRef();
}

// LISTS ARE A FILE SYSTEM (2026-10-08, Quentin's instruction): every row is a
// DIRECTORY (holds the other two and more directories), a LIST (checkable
// items) or a DOCUMENT (a title and a body). The index is the HOME directory —
// parent_id null. Only a directory holds anything; the server refuses the
// rest (storage._ref_parent_error). These helpers are the one reading of the
// tree, asked by this page and by clarify's Reference browser alike.
const REF_KIND_WORD = { dir: 'directory', list: 'list', doc: 'document' };

// The three kinds' marks (Quentin's "Lists File System" design): a folder, a
// bulleted list, a page. Stroke only, so they take the text's colour.
const REF_ICON = {
  dir: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.8"/>',
  doc: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/>',
};
const refIcon = kind => `<svg class="ref-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round">${REF_ICON[kind]}</svg>`;

// What a directory holds, directories first, each group in its own order.
function refChildren(lists, pid) {
  const here = lists.filter(l => (l.parent_id || null) === (pid || null));
  return [...here.filter(l => l.kind === 'dir'), ...here.filter(l => l.kind === 'list'),
          ...here.filter(l => l.kind === 'doc')];
}

// "~/Books/" — the path to a directory (null is home).
function refPath(lists, id) {
  const names = [];
  for (let cur = lists.find(l => l.id === id); cur; cur = lists.find(l => l.id === cur.parent_id)) {
    names.unshift(cur.name);
  }
  return '~/' + names.map(n => n + '/').join('');
}

// One row, whatever its kind: its mark, its name, a quiet count (what a
// directory holds, a list's open items), and a directory's chevron. `on` is
// the row whose contents stand in the next column.
function refEntryRow(l, on) {
  const tail = l.kind === 'dir' ? refChildren(refView.lists, l.id).length
    : l.kind === 'list' ? l.items.filter(i => !i.done).length : '';
  return `<div class="ref-row${on ? ' ref-on' : ''}" data-id="${l.id}">
    ${refIcon(l.kind)}
    <span class="ref-name" title="Tap to open · double-click to rename">${escHtml(l.name)}</span>
    <span class="count">${tail}</span>
    ${l.kind === 'dir' ? '<span class="ref-chev">›</span>' : ''}
    <button class="ref-del" data-id="${l.id}" title="Delete ${REF_KIND_WORD[l.kind]}">×</button>
  </div>`;
}

function refAddButtonsHtml() {
  return `<button class="map-add-btn" data-ref-add="dir">+ directory</button>
    <button class="map-add-btn" data-ref-add="list">+ list</button>
    <button class="map-add-btn" data-ref-add="doc">+ document</button>`;
}

// A directory's rows and its add buttons, `onId` lit.
function refDirHtml(pid, onId) {
  return `<div class="ref-list" data-ref-dir="${pid || ''}">${
    refChildren(refView.lists, pid).map(l => refEntryRow(l, l.id === onId)).join('')
    || emptyHtml(pid ? 'Empty.' : 'Nothing here yet.')}
    ${refAddButtonsHtml()}</div>`;
}

// Create a directory, list or document in `pid` (null is home): the one
// opener behind the + buttons and the right-click menu.
function refCreate(kind, pid) {
  const where = pid ? (refView.lists.find(l => l.id === pid) || {}).name : null;
  openEntrySheet({
    title: `New ${REF_KIND_WORD[kind]}${where ? ` in ${where}` : ''}`,
    placeholder: `Name the ${REF_KIND_WORD[kind]}…`, button: 'Create', closeOnAdd: true,
    add: async name => {
      const res = await apiSend('/api/ref/lists', 'POST', { name, kind, parent_id: pid });
      const created = await res.json();
      if (!res.ok) { toast(created.error || 'Could not create it'); return; }
      pushUndo(`created ${REF_KIND_WORD[kind]} "${name}"`, async () => {
        await apiSend(`/api/ref/lists/${created.id}`, 'DELETE');
        await refreshAfterUndo();
      });
      refView.open = created.id;
      await refreshRef();
    },
  });
}

// RIGHT-CLICK CREATES (2026-10-08, Quentin's instruction): on a directory's
// rows or the space under them, the menu offers the three kinds — inside the
// directory that was pressed, else in the one being shown — and, on a row,
// that row's Rename and Delete. The 550ms hold is the same menu on a finger.
function refMenu(x, y, dirPid, row) {
  const l = row && refView.lists.find(v => String(v.id) === row.dataset.id);
  const into = l && l.kind === 'dir' ? l.id : dirPid;
  const name = into ? (refView.lists.find(v => v.id === into) || {}).name : 'Home';
  const items = ['dir', 'list', 'doc'].map(kind => ({
    label: `New ${REF_KIND_WORD[kind]}${into !== dirPid ? ` in ${name}` : ''}`, run: () => refCreate(kind, into) }));
  if (l) {
    items.push({ label: 'Rename', run: () => refListRename(row.querySelector('.ref-name')) },
               { label: `Delete ${REF_KIND_WORD[l.kind]}`, danger: true, run: () => refDelete(l.id) });
  }
  openObjectMenu(x, y, 'ref', into || 0, items);
}

// The rows and add buttons of every directory drawn inside `scope`: the same
// gestures wherever a directory is drawn, each filing into its own.
function wireRefEntries(scope) {
  scope.querySelectorAll('[data-ref-dir]').forEach(dirEl => {
    const pid = dirEl.dataset.refDir ? parseInt(dirEl.dataset.refDir) : null;
    dirEl.querySelectorAll('[data-ref-add]').forEach(b => b.addEventListener('click', () =>
      refCreate(b.dataset.refAdd, pid)));
    // The whole column, not just the rows: the empty space under them is
    // where a new thing goes.
    const area = dirEl.closest('.ref-col') || dirEl;
    area.addEventListener('contextmenu', e => {
      e.preventDefault();
      refMenu(e.clientX, e.clientY, pid, e.target.closest('.ref-row[data-id]'));
    });
    let press = null;
    area.addEventListener('pointerdown', e => { press = { x: e.clientX, y: e.clientY, t: e.target }; });
    onLongPress(area, () => {
      if (press) refMenu(press.x, press.y, pid, press.t.closest('.ref-row[data-id]'));
    });
    dirEl.querySelectorAll('.ref-row[data-id]').forEach(row => {
      const span = row.querySelector('.ref-name');
      onTapOrDouble(row, () => {
        refView.open = parseInt(row.dataset.id);
        renderRef();
      }, () => refListRename(span));
    });
    dirEl.querySelectorAll('.ref-del[data-id]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      refDelete(parseInt(b.dataset.id));
    }));
  });
}

// Delete, with the inverse. New ids are fine — nothing outside Lists holds a
// ref id (unlike inbox restore). A directory's contents splice up a level on
// the server, so its undo files them back into the recreated directory.
async function refDelete(id) {
  const l = refView.lists.find(x => x.id === id);
  if (!l) return;
  const inside = refView.lists.filter(x => x.parent_id === id).map(x => x.id);
  await apiSend(`/api/ref/lists/${id}`, 'DELETE');
  pushUndo(`deleted ${REF_KIND_WORD[l.kind]} "${l.name}"`, async () => {
    const nl = await apiSend('/api/ref/lists', 'POST', {
      name: l.name, kind: l.kind, body: l.body || '', parent_id: l.parent_id }).then(r => r.json());
    for (const it of l.items) {
      await apiSend('/api/ref/items', 'POST', { list_id: nl.id, content: it.content, done: it.done });
    }
    for (const cid of inside) {
      await apiSend(`/api/ref/lists/${cid}`, 'PATCH', { parent_id: nl.id });
    }
    await refreshAfterUndo();
  });
  if (refView.open === id) refView.open = l.parent_id || null;
  await refreshRef();
}

// An open list or document — the same pane in the phone's one column and in
// the laptop's last one: a list's name over its items, a document's title over
// its body.
function refPaneHtml(open) {
  if (open.kind === 'doc') {
    return `<div class="ref-pane"><div class="ref-doc-title" title="Double-click to rename">${escHtml(open.name)}</div>
      <textarea class="ref-doc" data-ref-doc="${open.id}" placeholder="Write…"
        spellcheck="true">${escHtml(open.body || '')}</textarea></div>`;
  }
  return `<div class="ref-pane"><div class="ref-pane-head"><span class="ref-pane-name">${escHtml(open.name)}</span>
      <span class="count">${open.items.filter(i => !i.done).length}</span></div>
    <div class="ref-list">${open.items.map(i => `
      <div class="ref-row ref-item" data-item="${i.id}">
        <span class="eg-check ref-check${i.done ? ' ref-checked' : ''}" data-item="${i.id}"
          title="${i.done ? 'Uncheck' : 'Check off'}">${i.done ? '✓' : ''}</span>
        <span class="ref-text${i.done ? ' ref-done' : ''}" title="Double-click to rewrite">${escHtml(i.content)}</span>
        <button class="ref-del" data-item="${i.id}" title="Remove">×</button>
      </div>`).join('') || emptyHtml('Empty.')}
    <button class="map-add-btn" data-ref-add-item>+ item</button></div></div>`;
}

function wireRefPane(scope, open) {
  if (open.kind === 'doc') {
    const ta = scope.querySelector('[data-ref-doc]');
    const title = scope.querySelector('.ref-doc-title');
    title.addEventListener('dblclick', () => inlineEdit(title, {
      value: open.name,
      onCancel: refreshRef,
      onCommit: async name => {
        await apiSend(`/api/ref/lists/${open.id}`, 'PATCH', { name });
        await refreshRef();
      },
    }));
    // A document is a notes field: the notes debounce, every close flushes
    // it, and ONE undo per editing session.
    let undoPushed = false;
    const before = open.body || '';
    wireNotesAutosave(ta, async value => {
      if (value === (open.body || '')) return;
      if (!undoPushed) {
        undoPushed = true;
        pushUndo(`edited "${open.name}"`, async () => {
          await apiSend(`/api/ref/lists/${open.id}`, 'PATCH', { body: before });
          await refreshAfterUndo();
        });
      }
      await apiSend(`/api/ref/lists/${open.id}`, 'PATCH', { body: value });
      open.body = value;
    });
    return;
  }
  scope.querySelector('[data-ref-add-item]').addEventListener('click', () => openEntrySheet({
    title: open.name, placeholder: `Add to ${open.name}…`,
    add: async raw => {
      const created = await apiSend('/api/ref/items', 'POST', { list_id: open.id, content: raw }).then(r => r.json());
      pushUndo(`added "${raw}" to ${open.name}`, async () => {
        await apiSend(`/api/ref/items/${created.id}`, 'DELETE');
        await refreshAfterUndo();
      });
      await refreshRef();
    },
  }));
  scope.querySelectorAll('.ref-check').forEach(c => c.addEventListener('click', async () => {
    const id = parseInt(c.dataset.item);
    const it = open.items.find(x => x.id === id);
    const to = it.done ? 0 : 1;
    await apiSend(`/api/ref/items/${id}`, 'PATCH', { done: to });
    pushUndo(`${to ? 'checked' : 'unchecked'} "${it.content}"`, async () => {
      await apiSend(`/api/ref/items/${id}`, 'PATCH', { done: it.done });
      await refreshAfterUndo();
    });
    await refreshRef();
  }));
  scope.querySelectorAll('.ref-row[data-item] .ref-text').forEach(span => {
    span.addEventListener('dblclick', () => {
      const id = parseInt(span.closest('.ref-row').dataset.item);
      inlineEdit(span, {
        value: span.textContent,
        onCancel: refreshRef,
        onCommit: async content => {
          await apiSend(`/api/ref/items/${id}`, 'PATCH', { content });
          await refreshRef();
        },
      });
    });
  });
  scope.querySelectorAll('.ref-del[data-item]').forEach(b => b.addEventListener('click', async () => {
    const id = parseInt(b.dataset.item);
    const it = open.items.find(x => x.id === id);
    await apiSend(`/api/ref/items/${id}`, 'DELETE');
    pushUndo(`removed "${it.content}"`, async () => {
      await apiSend('/api/ref/items', 'POST', { list_id: open.id, content: it.content, done: it.done });
      await refreshAfterUndo();
    });
    await refreshRef();
  }));
}

// Flush a document being written before the page moves off it.
async function refFlushDoc(body) {
  const ta = body.querySelector('[data-ref-doc]');
  if (ta && ta.__flushNotes) await ta.__flushNotes();
}

// THE LAPTOP'S LISTS ARE COLUMNS (2026-10-08, Quentin's pick of design 1a):
// a directory on the left, what is open in it in the middle, and the list or
// document opened from THAT on the right — the page's own three sections.
// Everything is read off refView.open, so the address still names one thing:
//   nothing open        home on the left
//   a directory         its parent on the left, it in the middle
//   a list/doc at home  home on the left, it in the middle
//   a list/doc deeper   its directory's parent, its directory, it
// Deeper than the left column, a back row at its top steps up a level.
function renderRefColumns(body, open) {
  let leftDir = null, midDir, midPane = null, rightPane = null, leftOn = null;
  if (open && open.kind === 'dir') {
    leftDir = open.parent_id || null; midDir = open.id; leftOn = open.id;
  } else if (open && !open.parent_id) {
    midPane = open; leftOn = open.id;
  } else if (open) {
    const dir = refView.lists.find(l => l.id === open.parent_id);
    leftDir = dir ? dir.parent_id || null : null; midDir = open.parent_id; leftOn = open.parent_id;
    rightPane = open;
  }
  const upTo = leftDir ? refView.lists.find(l => l.id === leftDir) : null;
  body.innerHTML = `<div class="ref-cols">
    <div class="ref-col">${upTo ? `<button id="ref-back" class="log-back-btn">‹ ${
      upTo.parent_id ? escHtml((refView.lists.find(l => l.id === upTo.parent_id) || {}).name || '') : 'Home'}</button>` : ''}
      ${refDirHtml(leftDir, leftOn)}</div>
    <div class="ref-col ref-col-mid">${midDir !== undefined ? refDirHtml(midDir, rightPane && rightPane.id)
      : midPane ? refPaneHtml(midPane) : emptyHtml('Open a directory, list or document.')}</div>
    <div class="ref-col">${rightPane ? refPaneHtml(rightPane) : ''}</div>
  </div>`;
  wireRefEntries(body);
  const pane = midPane || rightPane;
  if (pane) wireRefPane(body.querySelector('.ref-pane').parentElement, pane);
  const back = body.querySelector('#ref-back');
  if (back) back.addEventListener('click', async () => {
    await refFlushDoc(body);
    refView.open = leftDir;
    renderRef();
  });
}

function renderRef() {
  const body = document.getElementById('ref-body');
  const title = document.getElementById('ref-title');
  if (!body) return;
  syncRoute();

  const open = refView.lists.find(l => l.id === refView.open);
  const wide = SETTINGS_WIDE.matches;
  // LISTS PAGE (2026-10-01, Quentin's design): the index wears the Now shell
  // and needs no header of its own; on a phone one open entry keeps its head
  // (it carries the name and the way back). The laptop's columns never do.
  document.getElementById('tab-lists').classList.toggle('ref-index', wide || !open);

  // A document being written in is not repainted under the cursor — half-typed
  // text is data (the renderBar rule).
  const live = body.querySelector('[data-ref-doc]');
  if (live && live === document.activeElement && open && live.dataset.refDoc === String(open.id)) return;

  if (wide) { renderRefColumns(body, open); return; }

  if (!open) {
    title.textContent = 'Lists';
    body.innerHTML = mpSection('', '', refDirHtml(null, null));
    wireRefEntries(body);
    return;
  }

  title.textContent = open.name;
  const parent = open.parent_id ? refView.lists.find(l => l.id === open.parent_id) : null;
  body.innerHTML = `<button id="ref-back" class="log-back-btn">‹ ${parent ? escHtml(parent.name) : 'Home'}</button>
    ${open.kind === 'dir' ? refDirHtml(open.id, null) : refPaneHtml(open)}`;
  if (open.kind === 'dir') wireRefEntries(body); else wireRefPane(body, open);

  // Back peels one LEVEL, not to the index — nesting made "up" and "out"
  // different things.
  document.getElementById('ref-back').addEventListener('click', async () => {
    await refFlushDoc(body);
    refView.open = open.parent_id || null;
    renderRef();
  });
}

// The page's shape follows the window, so crossing 900px redraws it.
SETTINGS_WIDE.addEventListener('change', () => {
  const tab = document.getElementById('tab-lists');
  if (tab && !tab.classList.contains('hidden')) renderRef();
});

// CLARIFY'S REFERENCE EXIT FILES INTO THE TREE: a directory gets a NEW
// document (the capture is its title, the notes its body); an existing list
// gets the capture as an item; an existing document gets it at its end. ONE
// writer for the inbox and external doors alike, returning its own inverse —
// the caller's undo runs it beside whatever else it reverses.
async function refFileCapture(target, content, notes) {
  const undo = await refFileWrite(target, content, (notes || '').trim());
  // The sheet stays open for the next capture: it must see what was just
  // made, and a document's undo must restore the body as it now stands.
  clarifyView.refLists = await apiGet('/api/ref', clarifyView.refLists);
  return undo;
}

async function refFileWrite(target, content, extra) {
  if (target.kind === 'new') {
    const res = await apiSend('/api/ref/lists', 'POST',
      { name: content, kind: 'doc', body: extra, parent_id: target.dir });
    const created = await res.json();
    if (!res.ok) throw new Error(created.error || 'could not file it');
    return () => apiSend(`/api/ref/lists/${created.id}`, 'DELETE');
  }
  const l = (clarifyView.refLists || []).find(x => x.id === target.id);
  if (target.kind === 'doc') {
    const prev = l ? l.body || '' : '';
    await apiSend(`/api/ref/lists/${target.id}/append`, 'POST',
      { text: extra ? `${content}\n${extra}` : content });
    return () => apiSend(`/api/ref/lists/${target.id}`, 'PATCH', { body: prev });
  }
  const created = await apiSend('/api/ref/items', 'POST', { list_id: target.id, content }).then(r => r.json());
  return () => apiSend(`/api/ref/items/${created.id}`, 'DELETE');
}

// The browser the Reference pill opens: the HOME directory first, a
// directory's rows to walk down, `‹` to walk up, and the two ways to file —
// tap a list or document to add to it, or make a new document right here.
function clarifyRefHtml() {
  const lists = clarifyView.refLists || [];
  const dir = clarifyView.refDir;
  const chips = refChildren(lists, dir).map(l => l.kind === 'dir'
    ? `<button class="chip chip-sm" data-ref-into="${l.id}">${escHtml(l.name)}/</button>`
    : `<button class="chip chip-sm" data-ref-file="${l.id}" data-ref-kind="${l.kind}"
        title="Add this to the end of the ${REF_KIND_WORD[l.kind]}">${escHtml(l.name)}</button>`).join('');
  return `<div class="cl-chips cl-ref-row">
    <span class="cl-label">${escHtml(refPath(lists, dir))}</span>
    ${dir ? `<button class="chip chip-sm" id="cl-ref-up" title="Up a directory">‹ up</button>` : ''}
    ${chips}
    <button class="chip chip-sm" id="cl-ref-here">+ new document here</button>
  </div>`;
}

// Reference opens on the HOME directory, every time (Quentin's instruction):
// where you last filed is not where this capture belongs.
function clarifyToggleRef() {
  clarifyView.refOpen = !clarifyView.refOpen;
  clarifyView.refDir = null;
  renderClarify();
}

function wireClarifyRef(sheet) {
  const into = id => { clarifyView.refDir = id; renderClarify(); };
  sheet.querySelectorAll('[data-ref-into]').forEach(b => b.addEventListener('click', () =>
    into(parseInt(b.dataset.refInto))));
  const up = sheet.querySelector('#cl-ref-up');
  if (up) up.addEventListener('click', () => {
    const cur = (clarifyView.refLists || []).find(l => l.id === clarifyView.refDir);
    into(cur ? cur.parent_id || null : null);
  });
  sheet.querySelectorAll('[data-ref-file]').forEach(b => b.addEventListener('click', () =>
    fileClarify('reference', { kind: b.dataset.refKind, id: parseInt(b.dataset.refFile) })));
  const here = sheet.querySelector('#cl-ref-here');
  if (here) here.addEventListener('click', () =>
    fileClarify('reference', { kind: 'new', dir: clarifyView.refDir || null }));
}


function humanMinutes(m) {
  if (!m) return '';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} hr ${r}` : `${h} hr`;
}

// The metric DEFINITIONS, held once: Settings needs them to edit. Entries are
// never cached here — those are per day and per step.
const metricsView = { all: [] };

async function loadMetrics() {
  metricsView.all = await apiGet('/api/metrics', metricsView.all);
  return metricsView.all;
}

const METRIC_KIND_LABELS = { scale: 'likert scale', count: 'count',
                             yesno: 'yes / no', text: 'text' };

// Settings → Metrics. A metric is a settings item, so per the 2026-08-15 rule
// it owes all three verbs: edit, PAUSE and delete, in the same words and the
// same place as every other kind. Pausing stops it being ASKED and stops it
// being offered on a step; it never touches an answer already recorded.
// The row states, the SHEET decides — the same shape as every other settings
// list (beRow + beAddRow + wireBeList → SETTINGS_SHEETS.metric). It used to
// carry Pause/Resume and Delete as buttons on the row and had no sheet at all,
// which meant a metric was the one settings item you could not EDIT: no
// rename, no change of kind, scale or unit. Two rules at once — "a row is its
// text, its badges and ONE control", and "every settings kind can be edited,
// paused and deleted, in the same words and the same place".
function renderMetricsSettings() {
  const el = document.getElementById('be-metrics-list');
  if (!el) return;
  const rows = metricsView.all || [];
  el.innerHTML = rows.map(m => beRow({
    id: m.id, name: m.name, dim: !m.active,
    meta: metricShape(m),
    // Where it is asked is the thing you actually come here to check, and a
    // count cannot answer it — the whole point of the join is that the morning
    // step and the night step are different questions about one day.
    sub: (m.steps || []).length
      ? 'asked on ' + m.steps.map(s => s.flow_name).join(', ')
      : 'not asked anywhere yet',
    subClass: '',
    badge: m.active ? '' : 'paused',
  })).join('') + beAddRow('Add metric');
  wireBeList(el, 'metric', rows);
}

// Kind, range and unit in one line: "likert scale 1–7", "count · cups".
function metricShape(m) {
  return (METRIC_KIND_LABELS[m.kind] || m.kind)
    + (m.kind === 'scale' ? ` ${m.scale_min}–${m.scale_max}` : '')
    + (m.unit ? ` · ${m.unit}` : '')
    + (m.days_of_week ? ' · ' + daysWord(m.days_of_week) : '');
}

// '0'=Mon…'6'=Sun as letters, the same grammar the picker writes.
function daysWord(dow) {
  return [...dow].sort().map(d => (WEEKDAYS[parseInt(d)] || {}).letter || '').join('');
}

async function refreshMetricsSettings() {
  await loadMetrics();
  renderMetricsSettings();
  if (settingsView.section == null) renderSettingsIndex();
}


// ── New calendar event: the write half of the gcal mirror ─────
//
// Creates go to Google (POST /api/gcal/events — service account, see
// aggregator.create_gcal_event) and the server inserts the event locally in
// the same request, because the iCal feed is cached for hours and a write
// that doesn't render reads as a write that failed. The client then just
// re-reads /api/gcal — a db-only read, no external fetch — so the event's
// color and shape come from the same query as every other event.
// Undo deletes the event from Google AND the local mirror; created-by-us is
// the one thing the read-only-mirror rule lets the app delete.
const evSheet = { open: false };

function openEvSheet() {
  evSheet.open = true;
  renderEvSheet();
}

function closeEvSheet() {
  evSheet.open = false;
  hideSheet('ev-sheet');
}

// It peels before the Calendar overlay it opened from (the focused-input
// case stopPropagates and never reaches the ladder).
defineSheet('ev-sheet', { rank: 51, isOpen: () => evSheet.open, close: closeEvSheet });

// Re-read the local mirror and repaint both surfaces that draw it.
async function reloadGcal() {
  state.gcalEvents = await fetch('/api/gcal').then(r => r.json())
    .catch(() => state.gcalEvents);
  renderTimeline();
  renderEngage();
}

function renderEvSheet() {
  const sheet = document.getElementById('ev-sheet');
  showSheet('ev-sheet');
  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">new calendar event</span>
      <span class="cl-spacer"></span>
      <button class="modal-close-btn" id="ev-close">✕</button>
    </div>
    <div class="cl-action-wrap">
      <input type="text" class="cl-action" id="ev-summary" placeholder="What is it?">
    </div>
    <div class="cl-sec"><span class="cl-label">When</span></div>
    <div class="cl-row ev-when">
      <input type="date" class="cl-date" id="ev-date"
        value="${escHtml(viewDay())}">
      <input type="time" class="cl-date" id="ev-start">
      <span class="ev-dash">–</span>
      <input type="time" class="cl-date" id="ev-end" title="Blank = one hour">
    </div>
    ${recentList('evtime').length ? `<div class="cl-chips">
      ${recentList('evtime').slice(0, 4).map(t => {
        const [s, e] = t.split('|');
        return `<button class="chip chip-sm" data-evtime="${escHtml(t)}">${
          escHtml(s + (e ? '–' + e : ''))}</button>`;
      }).join('')}
    </div>` : ''}
    <div class="cl-row">
      <button class="cl-pill" id="ev-save">Add to Google Calendar</button>
    </div>`;

  const save = async () => {
    const summary = sheet.querySelector('#ev-summary').value.trim();
    const date = sheet.querySelector('#ev-date').value;
    const start = sheet.querySelector('#ev-start').value;
    const end = sheet.querySelector('#ev-end').value;
    if (!summary) { toast('The event needs a name'); return; }
    if (!date || !start) { toast('The event needs a date and a start time'); return; }
    const resp = await apiSend('/api/gcal/events', 'POST', { summary, date, start, end: end || null });
    const created = await resp.json();
    // The sheet stays open on failure — the config-missing message has to be
    // readable, and closing would throw the typed event away with it.
    if (!resp.ok) { toast(created.error || 'Google refused the write'); return; }
    // Times have no natural sort, so the sheet remembers the ones you use —
    // the chips above the When row (see recentBump).
    recentBump('evtime', start + '|' + (end || ''));
    pushUndo(`added event "${summary}"`, async () => {
      const r = await apiSend(`/api/gcal/events/${encodeURIComponent(created.event_id)}`
        + `?uid=${encodeURIComponent(created.uid)}`, 'DELETE');
      if (!r.ok) throw new Error('delete failed');
      await reloadGcal();
    });
    closeEvSheet();
    await reloadGcal();
  };

  sheet.querySelector('#ev-close').addEventListener('click', closeEvSheet);
  sheet.querySelector('#ev-save').addEventListener('click', save);
  sheet.querySelectorAll('[data-evtime]').forEach(b => b.addEventListener('click', () => {
    const [s, e] = b.dataset.evtime.split('|');
    sheet.querySelector('#ev-start').value = s;
    sheet.querySelector('#ev-end').value = e || '';
  }));
  sheet.querySelectorAll('input').forEach(el => el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.stopPropagation(); save(); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeEvSheet(); }
  }));
  sheet.querySelector('#ev-summary').focus();
}

// ── OCCASIONS: the actions a KIND of event always brings ──────
//
// "Every time I meet this guy I have to do X and Y." The rule is matched on the
// event's TITLE, case-insensitively, and not on a calendar series: the same
// meeting is often booked ad hoc — Tuesday 14:00, then Friday 17:00 — as two
// unrelated events, and a series rule would fire on neither. The one thing both
// bookings share is what you called them.
//
// Configuration happens HERE, on the event, the first time you notice you keep
// doing the same two things. The event row is the only row on the day that had
// no sheet to open, which is also why tapping one was free.
//
// This is ALSO the editor Settings → Occasions opens, so an occasion has one
// editor and two doors rather than two editors — see renderBeOccasions for why
// it is not a SETTINGS_SHEETS kind. `summary` is the event you came from, and
// is empty when you came from Settings: it seeds a new occasion's fields and
// names what the sheet is about, nothing more.
const occasionView = { open: false, summary: '', occ: null };

function occasionFor(list, summary) {
  const s = (summary || '').toLowerCase();
  // Paused ones match too, or the sheet couldn't offer to un-pause the very
  // occasion you came here looking for.
  return (list || []).find(o =>
    (o.match_text || '').trim() && s.includes(o.match_text.trim().toLowerCase())) || null;
}

// Door 1: an EVENT on the day. Finds the occasion that fires on it, or offers
// to make one seeded from its title.
async function openOccasionSheet(summary) {
  const list = await apiGet('/api/occasions', []);
  occasionView.summary = summary || '';
  occasionView.occ = occasionFor(list, summary);
  occasionView.open = true;
  renderOccasionSheet();
}

// Door 2: a row in Settings → Occasions. The occasion is already known, so
// there is no event to match against and no title to seed from.
function openOccasionFor(occ) {
  occasionView.summary = '';
  occasionView.occ = occ;
  occasionView.open = true;
  renderOccasionSheet();
}

// Door 3: + Add occasion in Settings. Nothing to seed from, so the sheet asks
// for the two fields it cannot guess instead of showing the event's pitch.
function openOccasionNew() {
  occasionView.summary = '';
  occasionView.occ = null;
  occasionView.open = true;
  renderOccasionSheet();
}

// Closing REFRESHES the day. Minting happens on the placements read, so an
// occasion set up for an event that is on the screen right now produces nothing
// visible until something re-reads — and "I just configured this and my day
// didn't change" reads as a write that failed. Every close path lands here:
// ✕, the backdrop, and Esc through initHub's ladder.
function closeOccasionSheet() {
  const was = occasionView.open;
  occasionView.open = false;
  occasionView.occ = null;
  hideSheet('oc-sheet');
  if (!was) return;
  refreshEngage();
  // Settings may be the surface underneath, and its list states the name, the
  // match word, the action count and the paused badge — all four of which this
  // sheet can have just changed.
  if (!document.getElementById('modal-overlay').classList.contains('hidden')) {
    refreshBeOccasions();
  }
}

// Re-read the occasion and repaint, then the day — a template that just changed
// does not retro-mint, but adding the FIRST one to today's event should show up
// without a reload.
//
// Re-found by ID where there is one. Re-matching on the event title is only
// right on the way IN: once the sheet is open, editing the match word must not
// make the occasion you are editing vanish from under you — and from Settings
// there is no title to match on at all.
async function refreshOccasionSheet() {
  const list = await apiGet('/api/occasions', []);
  const id = occasionView.occ && occasionView.occ.id;
  occasionView.occ = id != null
    ? (list.find(o => o.id === id) || null)
    : occasionFor(list, occasionView.summary);
  renderOccasionSheet();
  await refreshEngage();
}

// It peels before whatever it was opened from — and that is Settings as often
// as it is the day, so its rung sits ABOVE the overlay loop, or Esc would
// close Settings out from under an open sheet.
defineSheet('oc-sheet', { rank: 30, isOpen: () => occasionView.open, close: closeOccasionSheet });

function renderOccasionSheet() {
  const sheet = document.getElementById('oc-sheet');
  showSheet('oc-sheet');
  const o = occasionView.occ;
  const areaName = id => (state.areas.find(a => a.id === id) || {}).name || '';

  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">Occasion</span>
      <span class="cl-spacer"></span>
      <button class="modal-close-btn" id="oc-close">✕</button>
    </div>
    ${occasionView.summary ? `<div class="oc-ev">${escHtml(occasionView.summary)}</div>` : ''}
    ${!o && occasionView.summary ? `
    <div class="oc-hint">Nothing is attached to events like this yet. Set one up and
      every future event whose title contains the word you choose brings these
      actions onto its day by itself.</div>
    <div class="cl-row"><button class="cl-pill" id="oc-new">Set up an occasion</button></div>`
    : !o ? `
    <div class="oc-hint">An occasion is a set of actions that arrive with a kind of
      calendar event. Name it, and give it a word its title contains.</div>
    <div class="cl-sec"><span class="cl-label">Called</span></div>
    <div class="cl-action-wrap">
      <input type="text" class="cl-action" id="oc-new-name" placeholder="e.g. Dave 1:1"></div>
    <div class="cl-sec"><span class="cl-label">Fires on</span>
      <span class="cl-hint">any event whose title contains this</span></div>
    <div class="cl-row">
      <input type="text" class="oc-match" id="oc-new-match" placeholder="e.g. dave"></div>
    <div class="cl-row"><button class="cl-pill" id="oc-create">Create occasion</button></div>`
    : `
    <div class="cl-sec"><span class="cl-label">Called</span></div>
    <div class="cl-action-wrap">
      <input type="text" class="cl-action" id="oc-name" value="${escHtml(o.name)}"></div>
    <div class="cl-sec"><span class="cl-label">Fires on</span>
      <span class="cl-hint">any event whose title contains this</span></div>
    <div class="cl-row">
      <input type="text" class="oc-match" id="oc-match" value="${escHtml(o.match_text)}"
        placeholder="e.g. dave"></div>
    <div class="oc-hint">Case doesn't matter. Keep it short and distinctive — it
      matches anywhere in the title, so <em>dave</em> would also catch
      “Dave's birthday”.</div>
    <div class="cl-sec"><span class="cl-label">State</span>
      <span class="cl-hint">paused: no new actions are minted, and ones already
        on a day stay. Nothing is deleted.</span></div>
    <div class="cl-row"><div class="seg">
      <button class="${o.active ? 'on' : ''}" data-ocstate="1">Active</button>
      <button class="${o.active ? '' : 'on'}" data-ocstate="0">Paused</button>
    </div></div>
    <div class="cl-sec"><span class="cl-label">Every time</span>
      <span class="cl-hint">${o.items.length} action${o.items.length === 1 ? '' : 's'}</span></div>
    ${o.items.map(it => `
      <div class="oc-item">
        <span class="oc-item-text">${escHtml(it.content)}</span>
        <span class="oc-item-meta">${escHtml(filingLabel(it))}</span>
        <button class="oc-item-go" data-ocitem="${it.id}" title="Clarify this action">›</button>
      </div>`).join('')}
    <div class="cl-row"><button class="cl-pill" id="oc-add">+ action</button></div>
    <div class="cl-foot">
      <span class="cl-then">Already-placed actions stay put</span>
      <button class="cl-pill oc-del" id="oc-delete">Delete occasion</button>
    </div>`}`;

  sheet.querySelector('#oc-close').addEventListener('click', closeOccasionSheet);

  const newBtn = sheet.querySelector('#oc-new');
  if (newBtn) newBtn.addEventListener('click', async () => {
    // Both fields default to the event's own title: the name because that IS
    // what you call this thing, the match because the title you just booked is
    // the best available guess at the title you'll book next time. Both are
    // editable right below, which is the point of landing you on the full sheet
    // rather than asking two questions first.
    const seed = (occasionView.summary || 'Occasion').trim();
    const created = await apiSend('/api/occasions', 'POST',
      { name: seed, match_text: seed }).then(r => r.json());
    occasionView.occ = created;
    renderOccasionSheet();
  });

  // The Settings door: nothing to seed from, so both fields are asked for.
  const createBtn = sheet.querySelector('#oc-create');
  if (createBtn) {
    const create = async () => {
      const name = sheet.querySelector('#oc-new-name').value.trim();
      const match = sheet.querySelector('#oc-new-match').value.trim() || name;
      // A refusal has to be visible where the thumb is, not only in a foot the
      // keyboard covers.
      if (!name) { toast('The occasion needs a name'); return; }
      const res = await apiSend('/api/occasions', 'POST', { name, match_text: match });
      const created = await res.json();
      if (!res.ok) { toast(created.error || 'Could not create it'); return; }
      occasionView.occ = created;
      renderOccasionSheet();
    };
    createBtn.addEventListener('click', create);
    sheet.querySelectorAll('#oc-new-name, #oc-new-match').forEach(el =>
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.stopPropagation(); create(); }
      }));
  }

  const patch = async body => {
    const updated = await apiSend(`/api/occasions/${o.id}`, 'PATCH', body).then(r => r.json());
    occasionView.occ = updated;
  };
  const nameEl = sheet.querySelector('#oc-name');
  if (nameEl) nameEl.addEventListener('change', async e => {
    const v = e.target.value.trim();
    if (!v) { e.target.value = o.name; return; }
    await patch({ name: v });
  });
  const matchEl = sheet.querySelector('#oc-match');
  if (matchEl) matchEl.addEventListener('change', async e => {
    const v = e.target.value.trim();
    if (!v) { e.target.value = o.match_text; return; }
    await patch({ match_text: v });
    // The new word may no longer match the event you opened this from, and the
    // sheet must say so rather than keep showing a rule that has stopped
    // applying here.
    await refreshOccasionSheet();
  });
  sheet.querySelectorAll('[data-ocstate]').forEach(b => b.addEventListener('click', async () => {
    await patch({ active: b.dataset.ocstate === '1' });
    renderOccasionSheet();
  }));
  sheet.querySelectorAll('[data-ocitem]').forEach(b => b.addEventListener('click', () => {
    const it = o.items.find(x => x.id === parseInt(b.dataset.ocitem));
    if (!it) return;
    closeOccasionSheet();
    openClarifyForOccasion(o, it, () => openOccasionSheet(occasionView.summary));
  }));
  const addBtn = sheet.querySelector('#oc-add');
  if (addBtn) addBtn.addEventListener('click', () => {
    closeOccasionSheet();
    openClarifyForOccasion(o, null, () => openOccasionSheet(occasionView.summary));
  });
  const delBtn = sheet.querySelector('#oc-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    // Asked, like every other settings delete: this takes the standing actions
    // with it. What it already put on a day is not touched, and saying so is
    // the difference between a confirm and a scare.
    if (!confirm(`Delete "${o.name}"? Its ${plural(o.items.length, 'standing action')}`
                 + ' go with it. Actions already on a day stay.')) return;
    await apiSend(`/api/occasions/${o.id}`, 'DELETE');
    closeOccasionSheet();
    toast(`deleted the “${o.name}” occasion`);
    await refreshEngage();
  });
  sheet.querySelectorAll('input').forEach(el => el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.stopPropagation(); e.target.blur(); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeOccasionSheet(); }
  }));
}

// ── The ENTRY SHEET: one input, risen from the bottom ─────────
//
// The capture bar is for CAPTURING (Quentin, 2026-08-11) — its derived modes
// (✎ log, ✎ list, ◉ <list>, ◉ <routine>) made typed text land somewhere other
// than the inbox depending on what was open, which is exactly the ambiguity a
// capture bar cannot afford. Every list-shaped datatype now adds through a
// button on its own surface that opens THIS sheet: same geometry as clarify,
// same peel rules, one input. Rapid entry survives — Enter adds and the sheet
// stays open (unless the spec says adding OPENS the thing, e.g. a new log) —
// and Enter on an empty input is Done, the bar's old rhythm.
const entrySheet = { open: false, spec: null, tags: new Set() };

function openEntrySheet(spec) {
  entrySheet.open = true;
  entrySheet.spec = spec;
  entrySheet.tags = new Set(spec.initialTags || []);
  if (spec.when) {
    const date = spec.when.date || '';
    entrySheet.when = { date, month: (date || wallDay()).slice(0, 7),
                        time: spec.when.minute != null ? clockHHMM(spec.when.minute) : '' };
  }
  renderEntrySheet();
}

function closeEntrySheet() {
  entrySheet.open = false;
  entrySheet.spec = null;
  hideSheet('en-sheet');
}

// It peels before whatever surface opened it.
defineSheet('en-sheet', { rank: 52, isOpen: () => entrySheet.open, close: closeEntrySheet });

function renderEntrySheet() {
  const sheet = document.getElementById('en-sheet');
  const spec = entrySheet.spec;
  showSheet('en-sheet');
  if (spec.when) { renderEntryWhen(sheet, spec); return; }
  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">${escHtml(spec.title)}</span>
      <span class="cl-spacer"></span>
      <button class="modal-close-btn" id="en-close">✕</button>
    </div>
    <div class="cl-action-wrap">
      <input type="text" class="cl-action" id="en-input"
        placeholder="${escHtml(spec.placeholder || '')}" autocomplete="off">
    </div>
    ${spec.hint ? `<div class="cl-donow">${escHtml(spec.hint)}</div>` : ''}
    ${spec.suggest && spec.suggest.length ? `
    <div class="cl-chips">
      ${spec.suggest.map(t => `<button class="chip" data-ensug="${escHtml(t)}">${escHtml(t)}</button>`).join('')}
    </div>` : ''}
    ${spec.tags ? `
    <div class="cl-sec"><span class="cl-label">Tags</span></div>
    <div class="cl-chips" id="en-tag-chips">
      ${tagChipsHtml([...new Set([...(spec.tagVocab || []), ...entrySheet.tags])].sort(),
                     entrySheet.tags, 'data-entag')}
      <input type="text" class="cl-action en-tag-new" id="en-tag-new"
        placeholder="+ tag" autocomplete="off">
    </div>` : ''}
    <div class="cl-row">
      <button class="cl-pill" id="en-add">${escHtml(spec.button || 'Add')}</button>
      <button class="cl-pill" id="en-done">Done</button>
    </div>`;

  const input = sheet.querySelector('#en-input');
  if (spec.tags) {
    // A chip toggles; the field mints. Re-render keeps the NAME you have
    // already typed — half-typed text is data (renderBar's rule).
    sheet.querySelectorAll('[data-entag]').forEach(b =>
      b.addEventListener('click', () => {
        toggleInSet(entrySheet.tags, b.dataset.entag);
        const typed = input.value;
        renderEntrySheet();
        const again = document.getElementById('en-input');
        if (again) { again.value = typed; again.focus(); }
      }));
    const tagNew = sheet.querySelector('#en-tag-new');
    tagNew.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      const t = (tagNew.value || '').trim().toLowerCase().replace(/^#/, '')
        .replace(/[^a-z0-9_-]/g, '');
      if (!t) return;
      entrySheet.tags.add(t);
      const typed = input.value;
      renderEntrySheet();
      const again = document.getElementById('en-input');
      if (again) { again.value = typed; }
      const field = document.getElementById('en-tag-new');
      if (field) field.focus();
    });
  }
  const add = async () => {
    const raw = input.value.trim();
    if (!raw) { closeEntrySheet(); return; }   // empty Enter = done
    input.value = '';
    await spec.add(raw, [...entrySheet.tags]);
    if (spec.closeOnAdd) { closeEntrySheet(); return; }
    input.focus();
  };
  // A suggestion is the same as typing it and pressing Enter.
  sheet.querySelectorAll('[data-ensug]').forEach(b => b.addEventListener('click', () => {
    input.value = b.dataset.ensug;
    add();
  }));
  sheet.querySelector('#en-close').addEventListener('click', closeEntrySheet);
  sheet.querySelector('#en-done').addEventListener('click', closeEntrySheet);
  sheet.querySelector('#en-add').addEventListener('click', add);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.stopPropagation(); add(); }
    else if (e.key === 'Escape') {
      e.stopPropagation();
      if (input.value) { input.value = ''; return; }   // peel text first
      closeEntrySheet();
    }
  });
  input.focus();
}

// A DAY, AND OPTIONALLY A TIME, PICKED INSIDE THE PAGE. Deliberately not
// <input type="date"> / type="time": the browser draws those pickers OUTSIDE
// the document, where privacy mode's filter on <html> cannot reach them, and
// every popup has to fade with the rest (Quentin, 2026-09-23). So the month is
// a grid of buttons and the time a text field parsed by parseClockText.
// Arrows move the day (←→ one, ↑↓ a week), Enter saves, Esc closes — each
// stopped here, or the same key would also reach the surface underneath.
// `spec.save({ date, minute })`: date '' clears, minute is null without a time.
function renderEntryWhen(sheet, spec) {
  const w = entrySheet.when;
  const today = wallDay();
  const first = w.month + '-01';
  const lead = jsDateToDayOfWeek(new Date(first + 'T12:00:00'));   // weeks start Monday
  const [y, m] = w.month.split('-').map(Number);
  const weeks = Math.ceil((lead + new Date(y, m, 0).getDate()) / 7);
  const cells = [];
  for (let n = 0; n < weeks * 7; n++) cells.push(localDatePlusDays(first, n - lead));
  const monthName = new Date(first + 'T12:00:00')
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const picked = w.date
    ? new Date(w.date + 'T12:00:00').toLocaleDateString('en-US',
        { weekday: 'long', month: 'short', day: 'numeric' })
    : 'No date';
  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">${escHtml(spec.title)}</span>
      <span class="cl-spacer"></span>
      <button class="modal-close-btn" id="en-close">✕</button>
    </div>
    <div class="enw-picked">${escHtml(picked)}</div>
    ${dateNavHtml({ cls: 'enw-nav', unit: 'month', prev: 'data-enw-month="-1"', next: 'data-enw-month="1"',
      label: `<span class="enw-month">${escHtml(monthName)}</span>` })}
    <div class="enw-grid">
      ${/* A column header has room for the name, so it takes the name (the
            WEEKDAYS rule) — 'T' twice and 'S' twice was the one place the
            week lost its R and U. */''}
      ${WEEKDAYS.map(w => `<span class="enw-dow">${w.name}</span>`).join('')}
      ${cells.map(d => `<button class="enw-day${d.slice(0, 7) !== w.month ? ' enw-out' : ''}${
        d === today ? ' enw-today' : ''}${d === w.date ? ' enw-on' : ''}" data-enw-day="${d}"
        >${Number(d.slice(8))}</button>`).join('')}
    </div>
    <div class="cl-row">
      <button class="cl-pill" data-enw-day="${today}">Today</button>
      <button class="cl-pill" data-enw-day="${localDatePlusDays(today, 1)}">Tomorrow</button>
      <button class="cl-pill" data-enw-day="${localDatePlusDays(today, 7)}">+1 week</button>
      <button class="cl-pill" data-enw-day="">Clear</button>
    </div>
    ${spec.when.withTime ? `
    <div class="cl-sec"><span class="cl-label">Time</span>
      <span class="cl-hint">optional — a time also puts it on that day's schedule</span></div>
    <div class="cl-action-wrap">
      <input type="text" class="cl-action" id="enw-time" inputmode="numeric"
        placeholder="e.g. 9:30, 14:00, 7pm" autocomplete="off" value="${escHtml(w.time)}">
    </div>` : ''}
    <div class="cl-row">
      <button class="cl-pill" id="en-add">Save</button>
      <button class="cl-pill" id="en-done">Cancel</button>
    </div>`;

  const timeEl = sheet.querySelector('#enw-time');
  const refocus = () => {
    renderEntrySheet();
    document.getElementById('en-sheet').focus();
  };
  const setDay = d => {
    w.date = d;
    if (d) w.month = d.slice(0, 7);
    refocus();
  };
  const save = async () => {
    let minute = null;
    if (timeEl && timeEl.value.trim()) {
      minute = parseClockText(timeEl.value);
      if (minute == null) { toast('A time looks like 9:30, 14:00 or 7pm'); return; }
      if (!w.date) { toast('Pick a day for that time'); return; }
    }
    closeEntrySheet();
    await spec.save({ date: w.date, minute });
  };
  sheet.querySelectorAll('[data-enw-day]').forEach(b =>
    b.addEventListener('click', () => setDay(b.dataset.enwDay)));
  sheet.querySelectorAll('[data-enw-month]').forEach(b => b.addEventListener('click', () => {
    const d = new Date(w.month + '-15T12:00:00');
    d.setMonth(d.getMonth() + Number(b.dataset.enwMonth));
    w.month = formatDateYMD(d).slice(0, 7);
    refocus();
  }));
  if (timeEl) timeEl.addEventListener('input', () => { w.time = timeEl.value; });
  sheet.querySelector('#en-close').addEventListener('click', closeEntrySheet);
  sheet.querySelector('#en-done').addEventListener('click', closeEntrySheet);
  sheet.querySelector('#en-add').addEventListener('click', save);
  sheet.tabIndex = -1;
  sheet.focus();
}

// The date picker's keys, on the sheet itself and wired ONCE (the sheet is
// re-rendered on every arrow, its element is not). A no-op for the text form.
document.getElementById('en-sheet').addEventListener('keydown', e => {
  if (!entrySheet.open || !entrySheet.spec || !entrySheet.spec.when) return;
  const w = entrySheet.when;
  const sheet = e.currentTarget;
  if (e.key === 'Escape') { e.stopPropagation(); closeEntrySheet(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    sheet.querySelector('#en-add').click();
    return;
  }
  if (e.target.id === 'enw-time') return;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
  const d = localDatePlusDays(w.date || wallDay(), w.date ? step : 0);
  w.date = d;
  w.month = d.slice(0, 7);
  renderEntrySheet();
  sheet.focus();
});

// Typed clock text → minutes from midnight, or null. Accepts 9, 930, 9:30,
// 21:00, 7pm, 7:15 am. The parse happens ONCE, here; minutes from then on.
function parseClockText(text) {
  const m = String(text).trim().toLowerCase()
    .match(/^(\d{1,2})(?::?(\d{2}))?\s*(am?|pm?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3][0] === 'p' ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}



// ── ENDING one thing, in a sheet ──────────────────────────────
//
// Ending an experiment or a habit is a DECISION, so it happens in a
// clarify-shaped sheet like every other decision — and behind three doors that
// share it: the nightly routine's journal page, Tracking, and the weekly
// review. All three used to ask with window.prompt(), which is not a gesture
// the device this app is shaped for has: no touch target, no theme, no place in
// the Esc ladder, and in the pywebview shell a prompt the host declines comes
// back null, which the callers read as Cancel — the button did nothing and said
// nothing.
//
// The line it asks for is the EVIDENCE the weekly review judges, so the sheet
// requires it where the review will need it (the server refuses a blank one
// too) and refuses with a toast, never only in the foot, where the keyboard is.
const endSheet = { open: false, spec: null };

function openEndSheet(spec) {
  endSheet.open = true;
  endSheet.spec = spec;
  renderEndSheet();
}

function closeEndSheet() {
  endSheet.open = false;
  endSheet.spec = null;
  hideSheet('ex-sheet');
}

// It peels before the surface under it.
defineSheet('ex-sheet', { rank: 53, isOpen: () => endSheet.open, close: closeEndSheet });

function renderEndSheet() {
  const sheet = document.getElementById('ex-sheet');
  const spec = endSheet.spec;
  showSheet('ex-sheet');
  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">${escHtml(spec.title)}</span>
      <span class="cl-spacer"></span>
      <button class="modal-close-btn" id="ex-close">✕</button>
    </div>
    <div class="ex-subject">${escHtml(spec.subject)}</div>
    ${spec.meta ? `<div class="ex-meta">${escHtml(spec.meta)}</div>` : ''}
    <div class="cl-sec"><span class="cl-label">${escHtml(spec.label)}</span></div>
    <div class="cl-action-wrap">
      <input type="text" class="cl-action" id="ex-note"
        placeholder="${escHtml(spec.placeholder || '')}" autocomplete="off">
    </div>
    ${spec.next ? `
    <div class="cl-sec"><span class="cl-label">${escHtml(spec.next.label)}</span></div>
    <div class="cl-action-wrap">
      <input type="text" class="cl-action" id="ex-next"
        placeholder="${escHtml(spec.next.placeholder || '')}" autocomplete="off">
    </div>
    ${spec.next.hint ? `<div class="cl-donow">${escHtml(spec.next.hint)}</div>` : ''}` : ''}
    <div class="cl-row">
      ${spec.actions.map((a, i) =>
        `<button class="cl-pill" data-exdo="${i}">${escHtml(a.label)}</button>`).join('')}
      <button class="cl-pill" id="ex-cancel">Cancel</button>
    </div>`;

  const note = sheet.querySelector('#ex-note');
  const nextField = sheet.querySelector('#ex-next');
  const run = async i => {
    const text = note.value.trim();
    // A refusal has to be visible where the thumb is, not only in the foot.
    if (spec.required && !text) { toast(spec.requireHint || 'One line first'); return; }
    if (await spec.actions[i].run(text, nextField ? nextField.value.trim() : '')) closeEndSheet();
  };
  sheet.querySelectorAll('[data-exdo]').forEach(b =>
    b.addEventListener('click', () => run(parseInt(b.dataset.exdo))));
  sheet.querySelector('#ex-close').addEventListener('click', closeEndSheet);
  sheet.querySelector('#ex-cancel').addEventListener('click', closeEndSheet);
  [note, nextField].forEach(f => {
    if (!f) return;
    f.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        // Enter commits only where there is ONE end to commit to. With two
        // (weekly review / drop) it moves on instead: guessing which end you
        // meant is the one thing this sheet must not do.
        if (spec.actions.length === 1) run(0);
        else if (f === note && nextField) nextField.focus();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (f.value) { f.value = ''; return; }   // peel the text first
        closeEndSheet();
      }
    });
  });
  note.focus();
}

// ENDING ONE EXPERIMENT AND STARTING TOMORROW'S IS ONE ACT (2026-08-19,
// Quentin's instruction). One runs at a time, so the next can only start once
// this one is closed — and the night you close it is the night you decide the
// next one. The server does both in the ONE patch, which is also why this works
// from the journal page without submitting the night: the experiment lifecycle
// and the journal entry are separate stores, and the sheet touches only the
// first. `after` repaints whichever surface opened the sheet.
function endExperimentSheet(ex, day, after) {
  openEndSheet({
    title: 'End the experiment',
    subject: ex.content,
    meta: ex.started_on ? `running since ${ex.started_on}` : '',
    label: 'How did it resolve?',
    placeholder: 'one line — the review judges this',
    required: true,
    requireHint: 'One line on how it resolved — that line is what the review judges',
    next: {
      label: 'Tomorrow’s experiment',
      placeholder: 'change one cue, one cost, or one reward',
      hint: 'Optional, and it starts as soon as this one ends — nothing else on the page has to be saved first.',
    },
    actions: [
      { label: 'End it → weekly review', run: (n, nx) => endExperiment(ex, day, n, nx, false, after) },
      { label: 'End it → drop', run: (n, nx) => endExperiment(ex, day, n, nx, true, after) },
    ],
  });
}

async function endExperiment(ex, day, note, next, drop, after) {
  const body = { resolution: note, date: day };
  if (drop) body.outcome = 'drop';
  if (next) body.next = next;
  const res = await apiSend(`/api/habit-experiments/${ex.id}`, 'PATCH', body);
  if (!res.ok) { toast((await res.json()).error || 'could not end it'); return false; }
  const row = await res.json().catch(() => ({}));
  const started = (row && row.next_experiment) || null;
  pushUndo(started ? `ended the experiment and started “${started.content}”`
                   : (drop ? 'dropped the experiment' : 'sent the experiment to the review'),
    async () => {
      // The new one closes FIRST: one runs at a time, and reopen refuses while
      // another is running — an undo must not be the way around that rule.
      if (started) await apiSend(`/api/habit-experiments/${started.id}`, 'PATCH',
                                 { resolution: 'undone', outcome: 'drop' });
      // One call whichever end it was: reopen wipes the resolution, any
      // evaluation, and any habit the promotion minted.
      const r = await apiSend(`/api/habit-experiments/${ex.id}/reopen`, 'POST');
      if (!r.ok) toast((await r.json()).error || 'could not reopen it');
      if (after) await after();
    });
  toast(started ? `running: ${started.content}`
                : (drop ? 'dropped' : 'waiting for the weekly review'));
  if (after) await after();
  return true;
}

// A list's name, renamed in place — the index rows and a list's child rows.
function refListRename(span) {
  const id = parseInt(span.closest('.ref-row').dataset.id);
  inlineEdit(span, {
    value: span.textContent,
    onCancel: refreshRef,
    onCommit: async name => {
      await apiSend(`/api/ref/lists/${id}`, 'PATCH', { name });
      await refreshRef();
    },
  });
}

// ── Markdown editing: shortcuts + editing gestures (notes fields) ─
//
// Every mutation goes through document.execCommand('insertText') instead of
// assigning ta.value. Assigning wipes the textarea's native undo stack, and
// inside a text field the BROWSER's Ctrl+Z is deliberately the one that wins
// (see Undo: the app stack ignores keystrokes in text fields). Selecting the
// range first and letting insertText do the write is the whole reason a note
// stays undoable one step at a time. insertText also fires `input`, so the
// autosave timer comes along for free — no handler
// below has to remember to trigger them.

// Typing one of these over a SELECTION wraps it instead of replacing it.
// Deliberately no auto-closing on an empty caret: that is the half of
// auto-pairing everyone turns off.
const LOG_PAIRS = { '*': '*', '_': '_', '`': '`', '~': '~', '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
const LOG_WORD = /[\p{L}\p{N}_]/u;

function logEdit(ta, start, end, text, selStart, selEnd) {
  if (!text && start === end) return;
  ta.setSelectionRange(start, end);
  if (text) document.execCommand('insertText', false, text);
  else document.execCommand('delete');
  if (selStart != null) ta.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
}

function logLineStart(v, pos) {
  return pos <= 0 ? 0 : v.lastIndexOf('\n', pos - 1) + 1;
}

function logLineEnd(v, pos) {
  const i = v.indexOf('\n', pos);
  return i === -1 ? v.length : i;
}

function logWordAt(v, pos) {
  let s = pos, e = pos;
  while (s > 0 && LOG_WORD.test(v[s - 1])) s--;
  while (e < v.length && LOG_WORD.test(v[e])) e++;
  return [s, e];
}

// Wrap / unwrap an inline span. With no selection it takes the word under the
// caret, so Ctrl+B mid-word bolds the word rather than opening empty markers.
function logWrap(ta, left, right) {
  const v = ta.value;
  let s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e) [s, e] = logWordAt(v, s);
  const sel = v.slice(s, e);
  // '*' must never unwrap '**': stripping one layer would silently turn bold
  // into italic. Nesting them is legal markdown, so fall through and wrap.
  const doubled = left === '*' && sel.startsWith('**') && sel.endsWith('**');
  if (!doubled && sel.length >= left.length + right.length
      && sel.startsWith(left) && sel.endsWith(right)) {
    const inner = sel.slice(left.length, sel.length - right.length);
    logEdit(ta, s, e, inner, s, s + inner.length);
    return;
  }
  if (v.slice(s - left.length, s) === left && v.slice(e, e + right.length) === right
      && !(left === '*' && v.slice(s - 2, s) === '**')) {
    const ns = s - left.length;
    logEdit(ta, ns, e + right.length, sel, ns, ns + sel.length);
    return;
  }
  logEdit(ta, s, e, left + sel + right, s + left.length, s + left.length + sel.length);
}

// Rewrite every line the selection touches. A bare caret keeps its column
// (shifted by whatever the prefix added or removed); a real selection ends up
// covering the block, so Tab-Tab-Tab keeps indenting the same lines.
function logMapLines(ta, fn) {
  const v = ta.value;
  const caret = ta.selectionStart, caretEnd = ta.selectionEnd;
  const s = logLineStart(v, caret);
  const e = logLineEnd(v, caretEnd);
  const before = v.slice(s, e);
  const lines = before.split('\n');
  const after = lines.map(fn).join('\n');
  if (after === before) return;
  if (caret === caretEnd) {
    const d = after.split('\n')[0].length - lines[0].length;
    logEdit(ta, s, e, after, Math.max(s, caret + d));
  } else {
    logEdit(ta, s, e, after, s, s + after.length);
  }
}

// level 0 strips the heading; pressing the level a line already has toggles
// it off, so Ctrl+2 twice is a round trip.
function logHeading(ta, level) {
  logMapLines(ta, line => {
    const indent = line.match(/^\s*/)[0];
    const rest = line.slice(indent.length);
    const m = rest.match(/^(#{1,6})\s+/);
    const bare = m ? rest.slice(m[0].length) : rest;
    if (!level || (m && m[1].length === level)) return indent + bare;
    return indent + '#'.repeat(level) + ' ' + bare;
  });
}

// Block toggles read the whole selection first: a mixed block gets marked,
// and only a fully-marked block gets cleared. Blank lines never count against
// "all marked", or one stray empty line would flip the gesture.
function logBlockToggle(ta, kind) {
  const v = ta.value;
  const s = logLineStart(v, ta.selectionStart);
  const e = logLineEnd(v, ta.selectionEnd);
  const lines = v.slice(s, e).split('\n');
  const re = kind === 'quote' ? /^\s*>\s?/
    : kind === 'ordered' ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
  const all = lines.every(l => !l.trim() || re.test(l));
  let n = 0;
  logMapLines(ta, line => {
    const indent = line.match(/^\s*/)[0];
    const rest = line.slice(indent.length);
    if (kind === 'quote') {
      return all ? indent + rest.replace(/^>\s?/, '') : indent + '> ' + rest;
    }
    const bare = rest.replace(/^([-*+]|\d+\.)\s+/, '');
    if (all) return indent + bare;
    if (!line.trim()) return line;
    n++;
    return indent + (kind === 'ordered' ? n + '. ' : '- ') + bare;
  });
}

// Ctrl+Enter. A plain line becomes a task, a bullet gains a box, a box flips.
function logCheckbox(ta) {
  logMapLines(ta, line => {
    const indent = line.match(/^\s*/)[0];
    const rest = line.slice(indent.length);
    const m = rest.match(/^([-*+]|\d+\.)\s+(\[([ xX])\]\s+)?/);
    if (m && m[2]) {
      return indent + m[1] + ' [' + (m[3] === ' ' ? 'x' : ' ') + '] ' + rest.slice(m[0].length);
    }
    if (m) return indent + m[1] + ' [ ] ' + rest.slice(m[0].length);
    return indent + '- [ ] ' + rest;
  });
}

// Enter continues the list, quote or task you are standing in. Returns false
// when there is nothing to continue, so the caller leaves Enter alone.
function logEnter(ta) {
  const v = ta.value;
  const pos = ta.selectionStart;
  if (pos !== ta.selectionEnd) return false;
  const s = logLineStart(v, pos);
  const line = v.slice(s, pos);
  const m = line.match(/^(\s*)(>\s?|([-*+])\s+(\[[ xX]\]\s+)?|(\d+)\.\s+(\[[ xX]\]\s+)?)/);
  if (!m) return false;
  // Enter on a marker with nothing after it EXITS the list instead of adding
  // another empty bullet — the standard gesture, and the only way out that
  // doesn't mean backspacing over the marker.
  if (line.length === m[0].length && !v.slice(pos, logLineEnd(v, pos)).trim()) {
    logEdit(ta, s, pos, '', s);
    return true;
  }
  const marker = m[5] ? (parseInt(m[5]) + 1) + '. ' + (m[6] ? '[ ] ' : '')
    : m[3] ? m[3] + ' ' + (m[4] ? '[ ] ' : '')
    : '> ';
  const ins = '\n' + m[1] + marker;
  logEdit(ta, pos, pos, ins, pos + ins.length);
  return true;
}

// Tab is two spaces in prose and a real indent inside a list or a multi-line
// selection — the two things Tab means in a markdown file.
function logIndent(ta, out) {
  const v = ta.value;
  const multi = ta.selectionStart !== ta.selectionEnd
    && v.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
  const line = v.slice(logLineStart(v, ta.selectionStart), logLineEnd(v, ta.selectionStart));
  const onList = /^\s*([-*+]|\d+\.)\s/.test(line) || /^\s*>/.test(line);
  if (!out && !multi && !onList) {
    document.execCommand('insertText', false, '  ');
    return;
  }
  logMapLines(ta, l => out ? l.replace(/^ {1,2}/, '') : (l.trim() ? '  ' + l : l));
}

function logMoveLines(ta, dir) {
  const v = ta.value;
  const s = logLineStart(v, ta.selectionStart);
  const e = logLineEnd(v, ta.selectionEnd);
  const block = v.slice(s, e);
  if (dir < 0) {
    if (s === 0) return;
    const ps = logLineStart(v, s - 1);
    const text = block + '\n' + v.slice(ps, s - 1);
    logEdit(ta, ps, e, text, ps, ps + block.length);
  } else {
    if (e >= v.length) return;
    const ne = logLineEnd(v, e + 1);
    const next = v.slice(e + 1, ne);
    const text = next + '\n' + block;
    logEdit(ta, s, ne, text, s + next.length + 1, s + next.length + 1 + block.length);
  }
}

function logDuplicateLines(ta) {
  const v = ta.value;
  const s = logLineStart(v, ta.selectionStart);
  const e = logLineEnd(v, ta.selectionEnd);
  const block = v.slice(s, e);
  logEdit(ta, e, e, '\n' + block, e + 1, e + 1 + block.length);
}

function logDeleteLines(ta) {
  const v = ta.value;
  const s = logLineStart(v, ta.selectionStart);
  let e = logLineEnd(v, ta.selectionEnd);
  if (e < v.length) e++;                    // take the trailing newline with it
  else if (s > 0) { logEdit(ta, s - 1, e, '', s - 1); return; }
  logEdit(ta, s, e, '', s);
}

function logLink(ta) {
  const v = ta.value;
  let s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e) [s, e] = logWordAt(v, s);
  const sel = v.slice(s, e);
  // Selection already a URL? It becomes the target and the caret lands in the
  // label. Otherwise it becomes the label and the caret lands in the target.
  if (/^(https?:\/\/|mailto:|www\.)\S*$/.test(sel)) {
    logEdit(ta, s, e, `[](${sel})`, s + 1);
  } else {
    const out = `[${sel}]()`;
    logEdit(ta, s, e, out, s + out.length - 1);
  }
}

function logKeydown(e) {
  const ta = e.currentTarget;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;

  if (!mod && !e.altKey && LOG_PAIRS[k] && ta.selectionStart !== ta.selectionEnd) {
    e.preventDefault();
    logWrap(ta, k, LOG_PAIRS[k]);
    return;
  }
  if (k === 'Tab') { e.preventDefault(); logIndent(ta, e.shiftKey); return; }
  if (k === 'Enter' && mod) { e.preventDefault(); logCheckbox(ta); return; }
  if (k === 'Enter' && !e.shiftKey && !e.altKey) {
    if (logEnter(ta)) e.preventDefault();
    return;
  }
  if (e.altKey && !mod && (k === 'ArrowUp' || k === 'ArrowDown')) {
    e.preventDefault();
    if (e.shiftKey) logDuplicateLines(ta);
    else logMoveLines(ta, k === 'ArrowUp' ? -1 : 1);
    return;
  }
  if (!mod) return;

  // Digits and punctuation come off e.code: e.key for Ctrl+Shift+8 is '*' on a
  // US layout and something else everywhere else.
  if (e.shiftKey) {
    if (e.code === 'Digit8') { e.preventDefault(); logBlockToggle(ta, 'bullet'); return; }
    if (e.code === 'Digit7') { e.preventDefault(); logBlockToggle(ta, 'ordered'); return; }
    if (e.code === 'Period') { e.preventDefault(); logBlockToggle(ta, 'quote'); return; }
    if (k.toLowerCase() === 'x') { e.preventDefault(); logWrap(ta, '~~', '~~'); return; }
    if (k.toLowerCase() === 'k') { e.preventDefault(); logDeleteLines(ta); return; }
    return;
  }
  const digit = e.code.match(/^Digit([0-6])$/);
  if (digit) { e.preventDefault(); logHeading(ta, parseInt(digit[1])); return; }
  switch (k.toLowerCase()) {
    case 'b': e.preventDefault(); logWrap(ta, '**', '**'); break;
    case 'i': e.preventDefault(); logWrap(ta, '*', '*'); break;
    case 'e': e.preventDefault(); logWrap(ta, '`', '`'); break;
    case 'k': e.preventDefault(); logLink(ta); break;
    // Save-now saves THIS field: a notes textarea flushes its own autosave
    // (wireNotesAutosave stamps __flushNotes).
    case 's': e.preventDefault(); if (ta.__flushNotes) ta.__flushNotes(); break;
  }
}

// The whole suite for any markdown-capable textarea. The engine (logKeydown/
// logPaste and every log* helper above — named for the log editor it was
// written for, which left with ef-writing) is textarea-agnostic —
// handlers read e.currentTarget — so notes fields get bold/italic/code/strike,
// links, headings, list/quote/task toggles, Enter continuation, Tab indent,
// line move/duplicate/delete and wrap-on-typing for free. Everything still
// goes through execCommand('insertText'), so the field's NATIVE undo survives
// and `input` fires — which is what keeps wireNotesAutosave's debounce and
// #cl-notes' clarifyView mirror working without any extra plumbing.
function wireMdShortcuts(ta) {
  ta.addEventListener('keydown', logKeydown);
  ta.addEventListener('paste', logPaste);
}

// Pasting a bare URL over a selection links it — the one paste worth
// intercepting, and the gesture that makes citing a source in a note free.
function logPaste(e) {
  const ta = e.currentTarget;
  if (!e.clipboardData) return;
  if (ta.selectionStart === ta.selectionEnd) return;
  const url = (e.clipboardData.getData('text') || '').trim();
  if (!/^(https?:\/\/|mailto:)\S+$/.test(url)) return;
  e.preventDefault();
  const s = ta.selectionStart, en = ta.selectionEnd;
  const out = `[${ta.value.slice(s, en)}](${url})`;
  logEdit(ta, s, en, out, s + out.length);
}

// ── Social exposure v1 (dryrun) ──────────────────────────────
//
// The grid: a rep is a cell of axis levels; its price is the sum of the
// levels' calibrated 0-10 anticipatory-pressure ratings. Two daily lines,
// both ✓/✗ only (no money path exists here): SPEC — one intended rep,
// specified to startability, whose price arithmetically clears D — and
// DOSE — today's rep prices sum to ≥ D. D is the anchor cell's price,
// never a free number. Prices are stamped on the rep at log time, so
// recalibration never rewrites history. Design log:
// ai-docs/26-8-6 Social stakes system design Q&A.md

// `date` was set only while the routine runner raised this surface (the
// RUN's pinned day); the runner is gone, so it is always null — today, decided
// by the SERVER (every social route already defaults that way).
// THE SOCIAL SURFACE IS OFF (2026-09-07, Quentin's instruction). The server
// owns the answer (storage.SOCIAL_ENABLED, served on /api/settings) and this is
// the ONE reader of it -- a second client-side switch is how the two start
// disagreeing about whether a step kind exists. Default OFF while settings are
// still loading: showing a door that is about to vanish is worse than a door
// that appears a beat late.
function socialEnabled() {
  return (state.settings || {}).social_enabled === true;
}

const socialView = { config: null, day: null, date: null, cues: '', form: null, calOpen: false };

// The day this surface is speaking about, as a query string and as a field on a
// write. Empty for today: the route's own default is the one answer.
function socialQ() {
  return socialView.date ? `?date=${socialView.date}` : '';
}

async function refreshSocialDot() {
  if (!socialEnabled()) return;
  socialView.day = await apiGet('/api/social/day', socialView.day);
  paintSocialDot();
}

function paintSocialDot() {
  const btn = document.getElementById('tn-social');
  const day = socialView.day;
  if (!btn) return;
  // Gold dot = calibrated and a line is still open today. Uncalibrated stays
  // quiet — the feature doesn't nag before it exists.
  btn.classList.toggle('has-due', !!(day && day.d != null && !(day.specOk && day.doseCleared)));
}

async function refreshSocial() {
  if (!socialEnabled()) return;
  const [config, day, engage] = await Promise.all([
    apiGet('/api/social', socialView.config),
    apiGet(`/api/social/day${socialQ()}`, socialView.day),
    apiGet('/api/engage/day', null),
  ]);
  socialView.config = config;
  socialView.day = day;
  // The evening tally's retrieval cue: walking the day's structure beats a
  // blank "anything?" — the blocks are the cue, not a metric.
  if (engage && engage.rows) {
    socialView.cues = [...new Set(engage.rows
      .filter(r => r.kind !== 'action' && r.label).map(r => r.label))].join(' → ');
  }
  paintSocialDot();
  renderSocial();
}

async function refreshSocialIfOpen() {
  if (!socialEnabled()) return;
  const el = document.getElementById('tab-social');
  if (el && !el.classList.contains('hidden')) await refreshSocial();
  else await refreshSocialDot();
}

function socialLevelById(id) {
  return ((socialView.config || {}).levels || []).find(l => l.id === id);
}

function socialShortLabel(id) {
  const l = socialLevelById(id);
  return l ? l.label.split('—')[0].split('(')[0].trim() : '';
}

function socialRepDesc(rep) {
  const parts = Object.values(rep.levels || {}).map(socialShortLabel).filter(Boolean);
  return parts.join(' · ') + (rep.person ? ` — ${rep.person}` : '');
}

// MIRROR of storage.social_price — see the note there. Preview only: the
// server reprices on save and its number is the one that gets stamped, so a
// drift here is cosmetic. It still has to be a mirror, not a variant.
function socialFormPrice(f) {
  const axes = ((socialView.config || {}).axes || {})[f.family] || [];
  let sum = 0;
  for (const a of axes) {
    const l = socialLevelById((f.levels || {})[a]);
    if (!l || l.rating == null) return null;
    sum += l.rating;
  }
  return sum;
}

const SOCIAL_AXIS_TITLES = {
  warmth: 'Warmth', medium: 'Medium', ask: 'Ask size',
  audience: 'Audience', disclosure: 'Self-disclosure',
  micro: 'Micro moves — price = rating',
};

function renderSocial() {
  const body = document.getElementById('social-body');
  if (!body || !socialView.config) return;
  const cfg = socialView.config;
  const day = socialView.day || { reps: [], total: 0 };
  const calibrated = cfg.d != null;
  const byAxis = {};
  (cfg.levels || []).forEach(l => { (byAxis[l.axis] = byAxis[l.axis] || []).push(l); });
  const f = socialView.form;

  const chipRow = (axis, sel) => (byAxis[axis] || []).map(l =>
    `<button class="chip chip-sm so-lvl${sel === l.id ? ' on' : ''}" data-axis="${axis}" data-id="${l.id}">
       ${escHtml(socialShortLabel(l.id))}${l.rating != null ? ` <span class="so-rating">${l.rating}</span>` : ''}
     </button>`).join('');

  let main = '';
  if (calibrated) {
    const pct = Math.min(100, Math.round(100 * day.total / day.d));
    main += `
      <div class="so-meter">
        <span class="so-meter-text">${day.total} / ${day.d}</span>
        <div class="so-meter-bar"><div class="so-meter-fill${day.doseCleared ? ' so-fill-ok' : ''}" style="width:${pct}%"></div></div>
        <span class="so-line${day.specOk ? ' so-ok' : ''}" title="The morning line: today's plan sums to D">spec ${day.specTotal || 0}/${day.d} ${day.specOk ? '✓' : '·'}</span>
        <span class="so-line${day.doseCleared ? ' so-ok' : ''}" title="The evening line: logged prices sum to D">dose ${day.doseCleared ? '✓' : '·'}</span>
      </div>`;

    // The spec cards — today's intended reps, each startable from its card
    // alone. A plan can hold several interactions and they ADD UP to the
    // morning line (2026-08-15): no single one has to carry it, so a card is
    // never refused for being small — the meter says how far the plan is from D.
    const specs = day.specs || [];
    const specShort = day.d == null ? 0 : Math.max(0, day.d - (day.specTotal || 0));
    if (!f || f.intent !== 'spec') {
      specs.forEach((s, i) => {
        main += `
        <div class="so-card">
          <div class="so-card-top"><span class="cl-label">${specs.length > 1 ? `Spec ${i + 1}` : "Today's spec"}</span>
            <span class="so-price">${s.price}</span>
            ${s.price >= day.d ? '<span class="so-ok">carries the line</span>' : ''}</div>
          <div class="so-spec-desc">${escHtml(socialRepDesc(s))}</div>
          ${s.opener ? `<div class="so-opener">“${escHtml(s.opener)}”</div>` : ''}
          <div class="so-card-btns">
            <button class="so-spec-did" data-spec="${s.id}" title="Log it as done, planned">✓ did it</button>
            <button class="so-spec-edit" data-spec="${s.id}" title="Re-spec — free, any time">↻ replace</button>
            <button class="so-spec-del" data-spec="${s.id}" title="Unplan it">×</button>
          </div>
        </div>`;
      });
    }
    if (!f) {
      main += specs.length
        ? `<button id="so-spec-new" class="so-add">+ plan another interaction${
            specShort ? ` <span class="cl-hint">${specShort} still short of D</span>` : ''}</button>`
        : `<button id="so-spec-new" class="so-add">+ plan today's rep <span class="cl-hint">the morning line — person, channel, opener</span></button>`;
    }

    if (f) {
      const price = socialFormPrice(f);
      const spec = f.intent === 'spec';
      main += `
        <div class="so-card so-form">
          <div class="so-card-top"><span class="cl-label">${spec ? "Plan today's rep" : 'Log a rep'}</span></div>
          <div class="cl-chips">
            <button class="chip chip-sm so-fam${f.family === 'directed' ? ' on' : ''}" data-fam="directed">directed</button>
            <button class="chip chip-sm so-fam${f.family === 'broadcast' ? ' on' : ''}" data-fam="broadcast">broadcast</button>
          </div>
          ${(cfg.axes[f.family] || []).map(axis => `
            <div class="so-axis"><span class="cl-hint">${SOCIAL_AXIS_TITLES[axis] || axis}</span>
              <div class="cl-chips">${chipRow(axis, (f.levels || {})[axis])}</div></div>`).join('')}
          ${f.family === 'directed' ? `<input type="text" id="so-person" class="so-input" placeholder="who — name them" value="${escHtml(f.person || '')}">` : ''}
          ${spec ? `<textarea id="so-opener" class="cl-notes" rows="2" placeholder="the opening message, verbatim — ready to send">${escHtml(f.opener || '')}</textarea>` : ''}
          ${spec ? '' : `<input type="number" id="so-pre" class="so-input so-pre" min="0" max="10" placeholder="pressure 0–10 (optional)" value="${f.pre ?? ''}">`}
          <div class="so-card-btns">
            <span class="so-price">${price == null ? '—' : price}</span>
            ${spec && price != null ? (() => {
              // Specs SUM to the morning line (2026-08-15): the plan as a whole
              // has to reach D, no single interaction has to. So a small spec is
              // saveable — the hint says what the plan would still be missing,
              // which is the number to act on, and no button is ever dead.
              const others = (day.specs || [])
                .filter(s => s.id !== f.editId).reduce((n, s) => n + s.price, 0);
              const left = cfg.d - (others + price);
              return left <= 0
                ? `<span class="so-ok">${others ? 'plan clears D' : 'clears D'}</span>`
                : `<span class="so-short">plan still ${left} short of D</span>`;
            })() : ''}
            <button id="so-form-go" ${price == null ? 'disabled' : ''}>${spec ? 'Save spec' : 'Log it'}</button>
            <button id="so-form-x">cancel</button>
          </div>
        </div>`;
    }

    // Micro chips: one tap logs; the count is today's reps of that move.
    main += `
      <div class="so-axis"><span class="cl-hint">micro — one tap logs it</span>
        <div class="cl-chips">${(byAxis.micro || []).map(l => {
          const n = (day.reps || []).filter(r => r.family === 'micro' && r.levels.micro === l.id).length;
          return `<button class="chip chip-sm so-micro" data-id="${l.id}" ${l.rating == null ? 'disabled title="rate this in calibration first"' : ''}>
            ${escHtml(socialShortLabel(l.id))}${l.rating != null ? ` <span class="so-rating">${l.rating}</span>` : ''}${n ? ` ×${n}` : ''}</button>`;
        }).join('')}
        ${f ? '' : '<button class="chip chip-sm" id="so-log-open">+ log a rep…</button>'}</div></div>`;

    if (socialView.cues) main += `<div class="so-cues cl-hint" title="The evening tally's retrieval cue">walk the day: ${escHtml(socialView.cues)}</div>`;

    main += `<div class="so-reps">${(day.reps || []).map(r => `
      <div class="so-rep" data-id="${r.id}">
        <span class="so-price">${r.price}</span>
        <span class="so-rep-text">${escHtml(socialRepDesc(r))}</span>
        ${r.planned ? '<span class="so-planned" title="spec’d in advance">◆</span>' : ''}
        ${r.pre_rating != null ? `<span class="cl-hint">felt ${r.pre_rating}</span>` : ''}
        <button class="so-del" data-id="${r.id}" title="Remove">×</button>
      </div>`).join('') || emptyHtml('Nothing logged today.')}</div>`;
  } else {
    main += `<div class="so-intro">Rate each level below for anticipatory pressure (0–10),
      then pick the <b>anchor</b> — the directed cell whose price becomes D, your daily dose.
      Moderate band: hard enough to train, clearable 6 of 7 days. Dryrun — ✓/✗ only, no money.</div>`;
  }

  // Calibration & anchor — config surface (deliberately not undoable, like
  // Settings). Open until calibrated, folded after.
  const anchor = cfg.anchor || {};
  main += `<div class="so-fold-head" id="so-cal-head">Calibration &amp; anchor
    <span class="cl-hint">${calibrated ? `D = ${cfg.d}` : 'required first'} ${socialView.calOpen || !calibrated ? '⌃' : '⌄'}</span></div>`;
  if (socialView.calOpen || !calibrated) {
    main += Object.keys(byAxis).map(axis => `
      <div class="so-axis"><span class="cl-hint">${SOCIAL_AXIS_TITLES[axis] || axis}</span>
        ${(byAxis[axis] || []).map(l => `
        <div class="so-cal-row"><span class="so-rep-text">${escHtml(l.label)}</span>
          <input type="number" class="so-input so-rate" data-id="${l.id}" min="0" max="10" value="${l.rating ?? ''}"></div>`).join('')}
      </div>`).join('');
    main += `
      <div class="so-axis"><span class="cl-hint">Anchor — the cell whose price IS D (one at-anchor rep clears the day)</span>
        ${['warmth', 'medium', 'ask'].map(axis => `<div class="cl-chips so-anchor" data-axis="${axis}">${chipRow(axis, anchor[axis])}</div>`).join('')}
      </div>`;
  }

  body.innerHTML = main;

  const head = body.querySelector('#so-cal-head');
  if (head) head.addEventListener('click', () => { socialView.calOpen = !socialView.calOpen; renderSocial(); });

  body.querySelectorAll('.so-rate').forEach(inp => inp.addEventListener('change', async () => {
    const v = inp.value === '' ? null : Math.max(0, Math.min(10, parseInt(inp.value) || 0));
    await apiSend(`/api/social/levels/${inp.dataset.id}`, 'PATCH', { rating: v });
    await refreshSocial();
  }));

  body.querySelectorAll('.so-anchor .so-lvl').forEach(b => b.addEventListener('click', async () => {
    const next = { ...(socialView.config.anchor || {}) };
    next[b.dataset.axis] = parseInt(b.dataset.id);
    if (next.warmth && next.medium && next.ask) {
      await apiSend('/api/social/anchor', 'PUT', next);
      await refreshSocial();
    } else {
      socialView.config.anchor = next;
      renderSocial();
    }
  }));

  const specNew = body.querySelector('#so-spec-new');
  if (specNew) specNew.addEventListener('click', () => {
    socialView.form = { intent: 'spec', family: 'directed', levels: {}, person: '', opener: '' };
    renderSocial();
  });
  const specById = id => (socialView.day.specs || []).find(s => s.id === parseInt(id));
  // Replays a removed spec verbatim — id AND price — so an undo after
  // recalibration restores the plan as it was, not as it would price now.
  const respec = s => apiSend('/api/social/specs', 'POST', { id: s.id, date: s.date, family: s.family, levels: s.levels,
                           person: s.person, opener: s.opener, price: s.price });
  body.querySelectorAll('.so-spec-edit').forEach(b => b.addEventListener('click', () => {
    const s = specById(b.dataset.spec);
    socialView.form = { intent: 'spec', editId: s.id, family: s.family,
                        levels: { ...s.levels }, person: s.person, opener: s.opener };
    renderSocial();
  }));
  body.querySelectorAll('.so-spec-did').forEach(b => b.addEventListener('click', async () => {
    const s = specById(b.dataset.spec);
    const rep = await apiSend('/api/social/reps', 'POST', { family: s.family, levels: s.levels, person: s.person, planned: 1 }).then(r => r.json());
    pushUndo(`logged the spec'd rep (+${rep.price})`, async () => {
      await apiSend(`/api/social/reps/${rep.id}`, 'DELETE');
      await refreshSocialIfOpen();
    });
    await refreshSocial();
  }));
  body.querySelectorAll('.so-spec-del').forEach(b => b.addEventListener('click', async () => {
    const s = specById(b.dataset.spec);
    await apiSend(`/api/social/specs/${s.id}`, 'DELETE');
    pushUndo('unplanned an interaction', async () => {
      await respec(s);
      await refreshSocialIfOpen();
    });
    await refreshSocial();
  }));

  const logOpen = body.querySelector('#so-log-open');
  if (logOpen) logOpen.addEventListener('click', () => {
    socialView.form = { intent: 'log', family: 'directed', levels: {}, person: '', pre: '' };
    renderSocial();
  });

  if (f) {
    body.querySelectorAll('.so-fam').forEach(b => b.addEventListener('click', () => {
      f.family = b.dataset.fam; f.levels = {};
      renderSocial();
    }));
    body.querySelectorAll('.so-form .so-lvl').forEach(b => b.addEventListener('click', () => {
      f.levels[b.dataset.axis] = parseInt(b.dataset.id);
      renderSocial();
    }));
    const person = body.querySelector('#so-person');
    if (person) person.addEventListener('input', e => { f.person = e.target.value; });
    const opener = body.querySelector('#so-opener');
    if (opener) opener.addEventListener('input', e => { f.opener = e.target.value; });
    const pre = body.querySelector('#so-pre');
    if (pre) pre.addEventListener('input', e => { f.pre = e.target.value; });
    // Esc peels the form, not the overlay — same idea as MAP's capture field.
    body.querySelectorAll('.so-form input, .so-form textarea').forEach(el =>
      el.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        socialView.form = null;
        renderSocial();
      }));
    const go = body.querySelector('#so-form-go');
    if (go) go.addEventListener('click', async () => {
      if (f.intent === 'spec') {
        // Replacing = add the new, then remove the one being edited; one
        // undo entry reverses both, so half a replacement can't survive.
        const prev = f.editId ? specById(f.editId) : null;
        const spec = await apiSend('/api/social/specs', 'POST', { family: f.family, levels: f.levels,
                                 person: f.person, opener: f.opener,
                                 date: socialView.date || undefined }).then(r => r.json());
        if (spec.error) return;
        if (prev) await apiSend(`/api/social/specs/${prev.id}`, 'DELETE');
        pushUndo(prev ? 'replaced a planned interaction' : 'planned an interaction', async () => {
          await apiSend(`/api/social/specs/${spec.id}`, 'DELETE');
          if (prev) await respec(prev);
          await refreshSocialIfOpen();
        });
      } else {
        const rep = await apiSend('/api/social/reps', 'POST', { family: f.family, levels: f.levels, person: f.person,
                                 date: socialView.date || undefined,
                                 pre_rating: f.pre === '' || f.pre == null ? null
                                   : Math.max(0, Math.min(10, parseInt(f.pre) || 0)) }).then(r => r.json());
        if (rep.error) return;
        pushUndo(`logged social rep (+${rep.price})`, async () => {
          await apiSend(`/api/social/reps/${rep.id}`, 'DELETE');
          await refreshSocialIfOpen();
        });
      }
      socialView.form = null;
      await refreshSocial();
    });
    const cancel = body.querySelector('#so-form-x');
    if (cancel) cancel.addEventListener('click', () => { socialView.form = null; renderSocial(); });
  }

  body.querySelectorAll('.so-micro').forEach(b => b.addEventListener('click', async () => {
    const rep = await apiSend('/api/social/reps', 'POST', { family: 'micro', levels: { micro: parseInt(b.dataset.id) },
                             date: socialView.date || undefined }).then(r => r.json());
    if (rep.error) return;
    pushUndo(`logged "${socialShortLabel(rep.levels.micro)}" (+${rep.price})`, async () => {
      await apiSend(`/api/social/reps/${rep.id}`, 'DELETE');
      await refreshSocialIfOpen();
    });
    await refreshSocial();
  }));

  body.querySelectorAll('.so-del').forEach(b => b.addEventListener('click', async () => {
    const id = parseInt(b.dataset.id);
    const rep = (socialView.day.reps || []).find(r => r.id === id);
    await apiSend(`/api/social/reps/${id}`, 'DELETE');
    // Replay verbatim — id and stamped price included, so undo can't reprice.
    pushUndo(`removed rep (${rep ? '+' + rep.price : ''})`, async () => {
      await apiSend('/api/social/reps', 'POST', rep);
      await refreshSocialIfOpen();
    });
    await refreshSocial();
  }));
}


// ── Init ─────────────────────────────────────────────────────

// ── HOW TALL THE SCREEN ACTUALLY IS ──────────────────────────
//
// Every full-height surface here is `position: fixed`, and a fixed box is laid
// out against the LAYOUT viewport — which on a phone includes the strip behind
// the URL bar and does not shrink when the keyboard comes up. So the surface is
// taller than what you can see, its inner scroller believes its content fits,
// and the rows at the bottom are unreachable: content clipped with nothing to
// scroll, on the device the app is shaped for. `100vh` has the same fault and
// `100dvh` fixes only the URL-bar half.
//
// `visualViewport.height` is the one number that means VISIBLE, so it is
// published once as `--vvh` and every fixed layer is sized from it. One
// variable, read in CSS, so a new surface inherits the answer instead of
// re-deriving it: the same bargain as --gbar-h.
//
// AND THE PAGE MAY NOT PAN UNDER IT (2026-10-02, Quentin's report: a huge gap
// while typing, and stuck in a log). Opening the keyboard also SCROLLS the
// page to bring the field into view, while the layers already rose by the
// keyboard's height off --vvh — so they rose twice: a keyboard-high gap
// under the capture bar, and the top strip (the tabs, "‹ All logs") panned
// off the top with no way back to it, sometimes even after the keyboard
// closed. Nothing in this document scrolls the WINDOW — every surface is a
// fixed layer with its own scroller — so any window scroll is that pan, and
// it is put back. Not while pinch-zoomed: that pan is the reader's own.
function initVisibleHeight() {
  const vv = window.visualViewport;
  const set = () => {
    document.documentElement.style.setProperty(
      '--vvh', Math.round(vv ? vv.height : window.innerHeight) + 'px');
    const zoomed = vv && Math.abs(vv.scale - 1) > 0.01;
    if (!zoomed && (window.scrollY || window.scrollX)) window.scrollTo(0, 0);
  };
  set();
  if (vv) {
    vv.addEventListener('resize', set);
    // The URL bar sliding away is a visual-viewport SCROLL, not a resize.
    vv.addEventListener('scroll', set);
  }
  window.addEventListener('resize', set);
  window.addEventListener('scroll', set, { passive: true });
  // The rotation fires before the new size is settled, hence the beat.
  window.addEventListener('orientationchange', () => setTimeout(set, 80));
}

document.addEventListener('DOMContentLoaded', () => {
  initVisibleHeight();          // before anything is measured or sized
  initThemeToggle();
  initPanelToggle();
  initBlockEditor();
  initTimeline();
  initHub();
  initTopNav();
  initObjectDoors();
  initCalBlockPin();
  initUndo();
  initPrivacyHotkey();
  renderBar();
  initGeo();
  initEngage();
  // Engage IS the home screen (9c): the day renders once everything is loaded.
  // Last line of defence for unsaved notes. visibilitychange is the one that
  // actually lands — it fires while the page is still allowed to run fetches,
  // unlike pagehide, which is often too late to finish a PATCH.
  document.addEventListener('visibilitychange', () => {
    // Coming BACK is when a sleeping device notices midnight happened.
    if (document.visibilityState !== 'hidden') { checkDayRollover(); return; }
    flushOpenNotes();
  });
  window.addEventListener('pagehide', () => {
    flushOpenNotes();
  });
  loadAll().then(() => { openEngage(); initTimezone(); refreshSocialDot(); initRoutes(); });
  setInterval(() => { checkDayRollover(); checkActiveBlock(); paintNowRows(); }, 60000);
});

// ── Accountability ────────────────────────────────────────────

// A GATE IS ONE SQUARE (2026-08-22, Quentin's instruction). No name, no time,
// no verdict mark — a scan target glyph, and a colour saying whether the day
// is done, still to do or missed. Everything else was legible somewhere else
// already: the TIME is where the square sits against the hour gutter, and the
// rest is one tap away in the read-out.
//
// The glyph is the same in every state on purpose. It says "this is a gate";
// the colour says how it went, and a shape that changed too would be two
// codings of one fact.
const QR_GLYPH = '▣';

// What the square is worth SAYING, for the things that can ask in words: the
// tooltip, and assistive technology. The read-out says all of it on a tap.
function qrPillTitle(node, endHHMM, offsetDays, locked, outcome) {
  const state = { success: 'met', partial: 'half met', failed: 'missed' }[outcome]
    || 'still to do';
  return `${node.label} — ${endHHMM}${offsetDays ? ' +1d' : ''} · ${state}`
    + (locked ? ' · locked, within 24h' : '');
}

// ── THE GATE READ-OUT (2026-08-21, Quentin's instruction) ─────────────────
//
// Tap a gate on the calendar and it says what this box knows about that gate on
// that day: the window and WHICH LAYER decided it, the pinned place and radius,
// every scan with how far away it landed, the routine, the minutes pawned into
// it, and the judgment. It exists because a gate that will not clear had no
// surface to ask — "the scan does not work and I cannot see why" is not
// answerable from a pill reading `Kanji Hall 10:00`.
//
// SERVED, never mirrored. Every value comes from /api/accountability/nodes/:id
// /day, which resolves through qr_judge's own functions, so the read-out cannot
// tell you a story the judge disagrees with. The client formats; it decides
// nothing. It does now WRITE one thing — calling the day off — and that is the
// same rule kept, not broken: the button sends the intent and the server
// decides both which window is being called off and whether the 24h lock
// refuses it.
const gatePop = { nodeId: null, date: null };

// When a deadline drag last finished. A drag's trailing click must not open the
// read-out, and the flag cannot live on the pill: saving a drag re-renders the
// layer, so the marked element is gone before the click arrives.

async function openGatePop(nodeId, date, anchorEl) {
  gatePop.nodeId = nodeId;
  gatePop.date = date;
  const el = document.getElementById('gate-pop');
  const back = document.getElementById('gate-pop-backdrop');
  el.innerHTML = '<div class="gp-note">reading…</div>';
  el.classList.remove('hidden');
  back.classList.remove('hidden');
  placeGatePop(el, anchorEl);
  let d = null;
  try {
    const r = await fetch(`/api/accountability/nodes/${nodeId}/day?date=${date}`);
    d = r.ok ? await r.json() : null;
  } catch (e) { d = null; }
  // Still the gate that was asked for: a second tap while the first was in
  // flight must not paint the previous gate's day over the new one.
  if (gatePop.nodeId !== nodeId || gatePop.date !== date) return;
  if (!d) {
    el.innerHTML = '<div class="gp-note">Could not read this gate — the app is'
      + ' offline, so the day cannot be resolved. Nothing has changed.</div>';
    return;
  }
  el.innerHTML = gatePopHtml(d);
  placeGatePop(el, anchorEl);
  el.querySelector('.gp-close').addEventListener('click', closeGatePop);
  // The read-out is READ-ONLY; changing this gate or this day is the
  // dashboard's job, and this is the door to it.
  const open = el.querySelector('#gp-open');
  if (open) open.addEventListener('click', () => openGatesDashboard(nodeId, date));
}

// Beside the pill, and inside the screen. A popup that opens under the thumb or
// off the bottom edge is a popup you cannot read on a phone.
function placeGatePop(el, anchorEl) {
  const pad = 12;
  // An ELEMENT or the rect it was measured at: the mouse path re-renders the
  // pill out from under itself, so it hands over the measurement instead.
  const r = !anchorEl
    ? { left: pad, right: pad, top: window.innerHeight / 3, bottom: window.innerHeight / 3 }
    : (anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : anchorEl);
  const w = el.offsetWidth || 340;
  const h = el.offsetHeight || 300;
  let left = Math.min(Math.max(pad, r.left), window.innerWidth - w - pad);
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function closeGatePop() {
  gatePop.nodeId = null;
  gatePop.date = null;
  document.getElementById('gate-pop').classList.add('hidden');
  document.getElementById('gate-pop-backdrop').classList.add('hidden');
}

// ── The EVENT read-out (2026-09-02, Quentin asked for it) ────
//
// What the calendar knows about the one event you tapped: where it is and what
// the invite said. The gate read-out's twin, deliberately — same box, same
// layer, same backdrop, and read-only in the same way. Nothing here writes.
//
// It TOOK the plain tap, which used to open the event's occasion. That is not a
// loss: an occasion is about the KIND of event (it matches by title, across
// every booking of it), and location and notes are about THIS ONE, so the
// specific thing is what a tap on the specific row should answer with. The
// occasion is one tap further, in the foot.
//
// Hiding is untouched: long-press, right-click and Cmd-click still drop the
// event from the day.
const eventPop = { key: null };

function epLinkify(text) {
  // Escaped FIRST, then linked: escaping cannot manufacture something that
  // looks like a URL, so the pattern only ever sees the real text.
  return escHtml(text).replace(/https?:\/\/[^\s<]+/g, u =>
    `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}

function eventPopFind(key) {
  return (state.gcalEvents || []).find(e => eventKey(e) === key) || null;
}

function openEventPop(key, anchorEl) {
  const e = eventPopFind(key);
  if (!e) return;
  eventPop.key = key;
  const el = document.getElementById('event-pop');
  const back = document.getElementById('event-pop-backdrop');
  const when = e.allday
    ? 'All day'
    : `${isoToAmPm(e.start)}–${isoToAmPm(e.end)}`;
  const day = formatTodoDate(new Date(e.start));
  const bits = [];
  if (e.location) {
    bits.push(`<div class="ep-loc"><span class="ep-loc-mark">⌖</span>`
      + `<span>${epLinkify(e.location)}</span></div>`);
  }
  if (e.description) bits.push(`<div class="ep-desc">${epLinkify(e.description)}</div>`);
  // Saying nothing is an ANSWER here. A past event predates the columns and a
  // refresh only rewrites from today forward, so "no location" and "we never
  // read one" are different facts and the second one is the honest wording.
  if (!bits.length) {
    bits.push(`<div class="ep-none">${
      (e.start || '') < wallDay()
        ? 'Nothing was stored for this event — the feed only fills in today forward.'
        : 'No location or notes on this event.'}</div>`);
  }
  el.innerHTML = `
    <div class="gp-head">
      <span class="gp-title">${escHtml(e.summary || 'Event')}</span>
      <button class="gp-close" id="ep-close">✕</button>
    </div>
    <div class="ep-when">${escHtml(day)} · ${escHtml(when)}${
      e.moved ? ' · moved here' : ''}</div>
    ${bits.join('')}
    <div class="ep-foot">
      <button class="cl-pill" id="ep-occasion">Open occasion ›</button>
    </div>`;
  el.classList.remove('hidden');
  back.classList.remove('hidden');
  placeGatePop(el, anchorEl);
  el.querySelector('#ep-close').addEventListener('click', closeEventPop);
  el.querySelector('#ep-occasion').addEventListener('click', () => {
    const summary = e.summary || '';
    closeEventPop();
    openOccasionSheet(summary);
  });
}

function closeEventPop() {
  eventPop.key = null;
  document.getElementById('event-pop').classList.add('hidden');
  document.getElementById('event-pop-backdrop').classList.add('hidden');
}

function gpRow(k, v, cls) {
  return `<div class="gp-row"><span class="gp-k">${escHtml(k)}</span>`
    + `<span class="gp-v${cls ? ' ' + cls : ''}">${v}</span></div>`;
}

// The hours ladder on the read-out. Every number here is SERVED — a judged day
// comes off its frozen row, an open one through hours_satisfies, the same
// predicate that charges — so this cannot describe a day the judge does not
// believe in. It replaces the scan list rather than joining it: an hours gate
// has no scans, and "nothing reached this gate" about a gate nothing is meant
// to reach reads as a fault.
function gatePopHoursHtml(hr) {
  let s = '<div class="gp-sect">The hours it asks for</div>';
  s += gpRow('Target', `<span class="gp-mono">${humanMinutes(hr.target_minutes)}</span> a day`);
  // Absent on a judged day, and deliberately: the incoming bucket is not
  // stored and is not recoverable from what is, so a figure here would be a
  // guess at a number the judge actually used.
  if (hr.bucket_minutes != null) {
    s += gpRow('Carried in', hr.bucket_minutes
      ? `<span class="gp-mono">${humanMinutes(hr.bucket_minutes)}</span> banked from the days before`
      : 'nothing — the bucket is empty');
  }
  s += gpRow('This day owes', hr.required_minutes > 0
    ? `<span class="gp-mono">${humanMinutes(hr.required_minutes)}</span>`
    : '<span class="gp-ok">nothing — the bucket already covers it</span>');
  s += gpRow('Logged', hr.logged_minutes
    ? `<span class="gp-mono">${humanMinutes(hr.logged_minutes)}</span>`
      + (hr.passes ? ' <span class="gp-ok">— enough</span>'
                   : ` <span class="gp-no">— ${humanMinutes(
                       hr.required_minutes - hr.logged_minutes)} short</span>`)
    : '<span class="gp-no">nothing entered</span>');
  s += gpRow('Carries forward', `<span class="gp-mono">${hr.bucket_after_minutes > 0
    ? humanMinutes(hr.bucket_after_minutes) : 'nothing'}</span>`);
  s += `<div class="gp-note">${hr.frozen
    ? 'These are the numbers this day was JUDGED against, read back off its own row.'
      + ' Correcting the hours now cannot move them — a judged day is frozen, which is'
      + ' what stops a change today rewriting what a past day was charged for.'
    : 'A met day banks whatever it worked beyond the target; a missed one still banks'
      + ' half of what was worked, so missing never raises tomorrow’s bar. The bucket'
      + ' needs no cap because a met day always spends the full target.'}</div>`;
  return s;
}

function gatePopHtml(d) {
  const w = d.window;
  const allDay = !!w.all_day;
  const rows = [];

  rows.push(gpRow(allDay ? 'Drawn at' : 'Window',
    `<span class="gp-mono">${escHtml(w.start)}–${escHtml(w.end)}`
    + `${w.offset_days && !allDay ? ' +1d' : ''}</span>`));
  rows.push(gpRow('Set by', escHtml(w.from)));
  // AN ALL-DAY GATE'S WINDOW JUDGES NOTHING. It is where the pill sits on the
  // timeline and nothing more, so the read-out says so next to the times
  // rather than letting them read as the commitment they are on a gate whose
  // window IS the deadline (2026-09-03) — off the server's `all_day`, because
  // the client deciding which gates have a deadline is exactly the
  // re-derivation this read-out exists not to do.
  if (allDay) rows.push(gpRow('', '<span class="gp-note">Where it sits on the day.'
    + ' This gate has no deadline — the times judge nothing, and anything that'
    + ' clears it counts any time today.</span>'));
  // A ROUTINE gate is a proof that no longer exists (2026-10-05): the server
  // never runs one (qr_judge.is_retired_proof), so the read-out says why.
  if (!d.applies) rows.push(gpRow('Runs today', d.proof_mode === 'routine'
    ? '<span class="gp-no">no — routine gates are gone, so this gate never runs.'
      + ' Give it another proof in Gates.</span>'
    : '<span class="gp-no">no — its schedule has no occurrence on this day</span>'));
  if (!d.active) rows.push(gpRow('Gate', '<span class="gp-no">paused</span>'));

  // THE PART THAT ANSWERS THE QUESTION. The pin, the radius, and then every
  // scan with the distance the scan server measured — a 220m miss with 65m of
  // GPS error is a different problem from a wrong pin, and the two look
  // identical from a failed day.
  let out = '';
  if (d.location) {
    out += '<div class="gp-sect">Where it must be scanned</div>';
    out += gpRow('Pinned', escHtml(d.location.name || 'an unnamed place'));
    out += gpRow('Position', `<span class="gp-mono">${d.location.lat.toFixed(5)}, `
      + `${d.location.lng.toFixed(5)}</span>`);
    out += gpRow('Radius', `<span class="gp-mono">${d.location.radius_m || 0}m</span>`);
  }

  // AN HOURS GATE HAS NO SCANS, and saying "nothing reached this gate" about a
  // gate nothing is supposed to reach would read as a fault. Its proof is the
  // ladder below instead — every number of which is SERVED: a judged day comes
  // off its frozen row, an open one through hours_satisfies, the same
  // predicate that charges. A read-out that re-derived the requirement would
  // show a day the judge does not believe in, which is the one thing this
  // surface exists not to do.
  let scans = d.hours ? gatePopHoursHtml(d.hours)
                      : '<div class="gp-sect">Scans on this day</div>';
  if (d.hours) {
    // Nothing further. An hours gate's proof is the ladder above — and
    // reporting "nothing reached this gate" about a gate nothing is supposed
    // to reach reads as a fault.
  } else if (!d.scans.length) {
    scans += '<div class="gp-note">None. Nothing reached this gate on this day.</div>';
  } else {
    scans += d.scans.map(sc => {
      const t = sc.local_time || sc.scanned_at.slice(11, 16);
      const bits = [];
      if (sc.distance_m != null) bits.push(`${sc.distance_m}m away`);
      if (sc.accuracy_m != null) bits.push(`±${Math.round(sc.accuracy_m)}m fix`);
      if (sc.proof === 'tag') bits.push('tag tap');
      if (!sc.in_window) bits.push('outside the window');
      const verdict = sc.satisfies && sc.in_window
        ? '<span class="gp-ok">counts</span>'
        : `<span class="gp-no">${sc.satisfies ? 'too late' : 'does not count'}</span>`;
      return gpRow(t, `${verdict}${bits.length ? ' · ' + escHtml(bits.join(' · ')) : ''}`);
    }).join('');
    // The distance is the whole diagnosis, so say what it means rather than
    // leaving two numbers to be compared by eye.
    const near = d.scans.filter(sc => sc.distance_m != null && !sc.satisfies);
    if (near.length && d.location) {
      const best = Math.min(...near.map(sc => sc.distance_m));
      scans += `<div class="gp-note">The closest scan landed ${best}m from the pin,`
        + ` and the fence is ${d.location.radius_m || 0}m. Either the pin is not where`
        + ` you actually stand, or the radius is tighter than the fix your phone gets`
        + ` indoors — widening it is an easing, so it takes 24h.</div>`;
    }
  }

  const cr = d.verdict || {};
  let verdict = '<div class="gp-sect">The verdict</div>';
  // ONE PROOF, ONE STATEMENT (2026-09-02). This replaced two "half" rows that
  // priced a scan and a routine against one stake. The row is named for the
  // proof this gate actually asks for, because a Scan row on a gate that has
  // never had a scan is a read-out describing a different gate.
  if (cr.proof !== 'hours' && cr.proof !== 'routine') {
    verdict += gpRow('Scan', cr.met
      ? '<span class="gp-ok">met — scanned inside the window</span>'
      : '<span class="gp-no">not met — no scan counted in the window</span>');
  }
  if (d.judged) {
    verdict += gpRow('Judged', d.judged.failure_reason
      ? `<span class="gp-no">${escHtml(gateReason(d.judged.failure_reason))}</span>`
      : '<span class="gp-ok">satisfied</span>');
    verdict += gpRow('Charge', escHtml(gateStatus(d.judged.charge_status))
      + (d.judged.amount_cents ? ` · $${(d.judged.amount_cents / 100).toFixed(2)}` : ''));
  } else if (!d.applies) {
    verdict += '<div class="gp-note">It does not run on this day, so nothing is judged.</div>';
  } else if (!w.closed) {
    verdict += `<div class="gp-note">Still open. It is judged when the window closes at`
      + ` ${escHtml(w.end)}${w.offset_days ? ' tomorrow' : ''}.</div>`;
  } else {
    verdict += '<div class="gp-note">Closed, and the judge has not reached it yet.</div>';
  }
  verdict += gpRow(d.judged ? 'Cost' : 'As it stands',
    `<span class="gp-mono">$${((cr.owed_cents == null ? d.stake_cents : cr.owed_cents) / 100)
      .toFixed(2)}</span> of $${(d.stake_cents / 100).toFixed(2)}`
    + `${d.live ? '' : ' · not charging for real yet'}`);
  if (d.proof_mode === 'tag') {
    verdict += gpRow('Proof', 'a verified NFC tap, and nothing else');
  }
  if (d.proof_mode === 'hours') {
    verdict += gpRow('Proof', 'the hours you report, on the honor system');
  }

  // THE ONE VERB IN HERE, and it is a real one. There used to be a cosmetic
  // "grey it out for this day" sitting where this button is, next to a
  // right-click that also only greyed things — two look-alike gestures on a
  // money-path object, neither of which the judge could see. A gate's day is
  // either on or off; there is no third, decorative state for it to be in.
  //
  // Locked is SERVED (skip_locked), and the button says so rather than going
  // quiet: a dead button on the day you most want to press it is how the
  // original gesture read.
  // HOW THIS GATE HAS BEEN GOING, in the four-word vocabulary the pills
  // already speak: green met, amber a half-met day frozen under the 50/50
  // split (nothing writes one now), red missed, and a hollow square for a day
  // it did not run. The verdicts are
  // the SERVER's (judged_outcome, read off frozen rows) - a strip that scored
  // the days itself would be the same bug as a client re-deriving a window,
  // one surface further out.
  //
  // Oldest on the left, so it reads like time. A day with no row is left out
  // rather than drawn as anything: today has not been judged, and neither has
  // any day before the gate existed.
  let hist = '';
  const h = d.history;
  if (h && h.days.length) {
    const cells = h.days.map(x => `<i class="gh-d gh-${x.outcome}" title="${
      escHtml(x.date)}${x.amount_cents ? ' · $' + (x.amount_cents / 100).toFixed(2) : ''}"></i>`).join('');
    const met = h.days.filter(x => x.outcome === 'success').length;
    const ran = h.days.filter(x => x.outcome !== 'off').length;
    hist = '<div class="gp-sect">The last 14 days</div>'
      + `<div class="gh-strip">${cells}</div>`
      + gpRow('Met', ran ? `${met} of ${ran} day${ran === 1 ? '' : 's'} it ran` : 'it has not run yet')
      + gpRow('Cost so far', `<span class="gp-mono">$${(h.charged_cents / 100).toFixed(2)}</span>`);
  } else if (h) {
    hist = '<div class="gp-sect">The last 14 days</div>'
      + '<div class="gp-note">Nothing judged yet — this gate has no record to show.</div>';
  }

  const foot = `<div class="gp-foot"><button id="gp-open" class="se-inline-act">${
    d.skipped ? 'Called off — change it in Gates ›' : 'Open in Gates ›'}</button></div>`;
  return `<div class="gp-head">
      <span class="gp-title">${escHtml(d.label)}</span>
      <button class="gp-close" title="Close">✕</button>
    </div>
    <div class="gp-date">${escHtml(d.date)}</div>
    ${rows.join('')}${out}${scans}${verdict}${hist}${foot}`;
}

// ── ONE TAP SHOWS THE WINDOW, THE SECOND EXPLAINS IT (2026-08-24, Quentin's
// instruction) ───────────────────────────────────────────────────────────────
//
// The square used to open the whole read-out on the first tap: a card of
// scans, distances, halves and money over the day you were reading, when the
// question is nearly always the small one — when does this open, when does it
// close, and when is its routine due. So the first tap SELECTS: four dotted
// lines against the same hour gutter everything else is read against. The
// second tap opens the card, which is still the only place the detail lives.
//
// The lines come from the SERVER's resolution of that gate's day — the same
// payload the card renders — so the two can never disagree about a window.
async function selectGate(nodeId, date, anchor) {
  // Tapping the gate that is already selected is the second tap: the card.
  if (state.gateSel && state.gateSel.nodeId === nodeId && state.gateSel.date === date) {
    openGatePop(nodeId, date, anchor);
    return;
  }
  state.gateSel = { nodeId, date, day: null };
  renderQrLayer();
  let d = null;
  try {
    const r = await fetch(`/api/accountability/nodes/${nodeId}/day?date=${date}`);
    d = r.ok ? await r.json() : null;
  } catch (e) { d = null; }
  // A second tap on another gate while this was in flight wins.
  if (!state.gateSel || state.gateSel.nodeId !== nodeId || state.gateSel.date !== date) return;
  if (!d) {
    state.gateSel = null;
    toast('Could not read this gate — nothing has changed');
    renderQrLayer();
    return;
  }
  state.gateSel.day = d;
  // renderTimeline, not renderQrLayer: the window may have to STRETCH to hold
  // a line outside it, and that repaints the grid and every other layer.
  renderTimeline();
}

function clearGateSel() {
  if (!state.gateSel) return false;
  state.gateSel = null;
  renderTimeline();
  return true;
}

// The dotted lines themselves. Drawn into the gate layer so they share its
// coordinate space, under the squares — a line is the explanation, the square
// is still the thing you press.
function renderGateSelLines(layer) {
  const lines = gateSelLines();
  if (!lines.length) return;
  // TWO TAGS MAY NOT SHARE A LINE, the same rule the event boxes follow — and
  // here the collision is the COMMON case, not the unlucky one: a routine with
  // no offset is due exactly when the gate closes, so its tag would print
  // straight over "scan closes" and neither would be readable. The lines
  // themselves may coincide (that is the truth about the day); only the words
  // move, and only downward, so a tag always sits below the line it names.
  const bodyH = document.getElementById('tl-body').clientHeight || 600;
  const rowPct = (14 / Math.max(bodyH, 1)) * 100;
  const stack = [];
  lines.forEach(l => {
    const pct = minutesToViewPercent(l.min);
    if (pct < -0.01 || pct > 100.01) return;   // gateSelBounds should prevent this
    const el = document.createElement('div');
    el.className = `tl-gate-line tl-gate-line-${l.kind}`;
    el.style.top = `${pct}%`;
    el.dataset.lineKind = l.kind;
    el.dataset.lineMin = l.min;
    const tag = document.createElement('span');
    tag.className = 'tl-gate-line-tag';
    const say = min => `${l.label} ${clockHHMM(min)}${min >= DAY_MIN ? ' +1d' : ''}`;
    tag.textContent = say(l.min);
    // A tag ON the top or bottom edge would print half off the body.
    if (pct >= 97) tag.style.top = '-15px';
    else {
      const clash = stack.filter(p0 => Math.abs(p0 - pct) < rowPct).length;
      stack.push(pct);
      if (clash) tag.style.top = `${-8 + clash * 13}px`;
    }
    el.appendChild(tag);
    // A line stops its own click: tapping one is aiming AT it, not tapping the
    // day off the selection.
    el.addEventListener('click', e => e.stopPropagation());
    layer.appendChild(el);
  });
}

// Re-read the selected gate's day: the lines are the SERVER's answer, so after
// any write they are re-asked rather than patched into place.
async function refreshGateSel() {
  const sel = state.gateSel;
  if (!sel) return;
  try {
    const r = await fetch(`/api/accountability/nodes/${sel.nodeId}/day?date=${sel.date}`);
    if (r.ok && state.gateSel === sel) sel.day = await r.json();
  } catch (e) { /* keep what we had — the day on screen is still the last truth */ }
  renderTimeline();
}

function renderQrLayer() {
  const layer = document.getElementById('tl-qr-layer');
  if (!layer) return;
  layer.innerHTML = '';
  renderGateSelLines(layer);
  const pageDate = viewDay();
  // THE SERVED DAY (viewGatesFor), and drawn the way a week column draws it:
  // one dot at the deadline in the right rail, a sun or moon for the wake and
  // sleep gates, the state in its colour (2026-09-29, Quentin's instruction:
  // the day should look exactly like a day of the week). A paused gate draws
  // too, muted and saying so, rather than vanishing — it is not judged, and
  // the day should still show that it exists.
  wkDayGatesFrom(viewGatesFor(pageDate)).forEach(g => {
    const node = (state.accountabilityNodes || []).find(n => n.id === g.node_id)
      || { id: g.node_id, label: g.label };
    const pct = minutesToViewPercent(g.window.end_min);
    if (pct < -0.01 || pct > 100.01) return;
    const outcome = state.qrOutcomes[`${node.id}:${pageDate}`];
    const st = wkGateState(g);
    const selected = !!state.gateSel && state.gateSel.nodeId === node.id
      && state.gateSel.date === pageDate;

    const line = document.createElement('div');
    line.className = `tl-qr-line wk-gate-${st}` + (selected ? ' tl-qr-selected' : '');
    line.style.top = `${pct}%`;

    const label = document.createElement('span');
    label.className = 'tl-qr-label' + (wkRole(node.id) !== 'none' ? ' wk-gate-role' : '');
    // ON THE LABEL, not on the line: the line is a zero-height rule and the
    // mark is what a finger can hit.
    label.dataset.obj = `gate:${node.id}`;
    label.innerHTML = wkGateMark(node.id);
    label.title = qrPillTitle(node, g.window.end, g.window.offset_days, false, outcome)
      + (st === 'paused' ? ' · paused, not judged' : st === 'off' ? ' · called off' : '');
    line.appendChild(label);
    layer.appendChild(line);

    // Marks centre on their time; near the top/bottom edge that would clip.
    if (pct >= 98.5) label.style.top = '-14px';
    else if (pct <= 1.5) label.style.top = '0px';

    line.addEventListener('contextmenu', e => e.preventDefault());
    // TAP TO READ IT: the first tap draws the window's lines, the second opens
    // the read-out. A gate's day is changed on /gates, the one editor.
    label.addEventListener('click', e => {
      e.stopPropagation();
      if (label.dataset.lpDragged === '1' || justPointerDragged()) { delete label.dataset.lpDragged; return; }
      selectGate(node.id, pageDate, label);
    });
    initGateDrag(label, g, pageDate, dayDragGeo(), min => {
      line.style.top = `${Math.min(100, Math.max(0, minutesToViewPercent(min)))}%`;
    });
  });
}

// ── A GATE'S DAY, FROM THE CALENDAR (2026-09-30, Quentin's instruction: "allow
// me to right click to remove gates … and let me drag gates to move them") ──
//
// Two DAY-LEVEL verbs come back to the calendar that 2026-09-29 moved to
// /gates: calling a day off and moving a day's window. Nothing else does — a
// gate's configuration, its tags, its money are still edited on /gates alone.
// Both write the stores the dashboard writes (qr_override, through the same
// two routes), so the judge sees them and the server's 24h lock decides
// whether an easing lands; a refusal is read back and toasted, never
// predicted here. The gate is the one the calendar was SERVED
// (/api/gates/day), found by the date its surface is showing.
function calGateOn(el, nodeId) {
  const wk = el.closest('#cal-week [data-date]');
  const d = wk ? wk.dataset.date : viewDay();
  const list = wk ? (calWeek.days[d] || {}).gates : viewGatesFor(d);
  const g = (list || []).find(x => String(x.node_id) === String(nodeId));
  return g ? { g, d } : null;
}

// Re-read whichever calendar is up. The marks are the server's answer, so a
// write is followed by asking again rather than by patching them in place.
//
// ONLY THE DAY THAT WAS WRITTEN, and in parallel (2026-09-30, Quentin's report
// that moving a gate lagged). This used to re-read the gate list and THEN the
// whole week — blocks, overrides and seven days of gates — and the week's
// refresh repaints at once from what it already holds, so a dropped mark
// jumped back to its old time for a second and only then to where it was put.
// A gate write changes one gate's one day; that day's served answer is all
// that has to come back, and nothing repaints until it has.
async function reloadCalGates(dateStr) {
  const nodes = apiGet('/api/accountability/nodes', state.accountabilityNodes);
  if (calWeek.on && dateStr && calWeek.days[dateStr]) {
    const [n, day] = await Promise.all([nodes, apiGet(`/api/gates/day?date=${dateStr}`, null)]);
    state.accountabilityNodes = n;
    if (day && day.date === dateStr && Array.isArray(day.gates) && calWeek.days[dateStr]) {
      calWeek.days[dateStr].gates = day.gates;
    }
    renderCalWeek();
    return;
  }
  if (calWeek.on) {
    state.accountabilityNodes = await nodes;
    await refreshCalWeek();
    return;
  }
  const [n] = await Promise.all([nodes, fetchOverridesForDate(state.currentDate)]);
  state.accountabilityNodes = n;
  if (state.gateSel) await refreshGateSel(); else renderTimeline();
}

async function calGateSkip(nodeId, dateStr, want) {
  const res = want
    ? await apiSend(`/api/accountability/nodes/${nodeId}/overrides`, 'POST', { date: dateStr, skipped: true })
    : await apiSend(`/api/accountability/nodes/${nodeId}/overrides/${dateStr}`, 'DELETE');
  if (!res || !res.ok) {
    const msg = res ? await res.json().catch(() => ({})) : {};
    toast(msg.error || (want ? 'Could not call that day off' : 'Could not put that day back'));
    return false;
  }
  await reloadCalGates(dateStr);
  return true;
}

// A GESTURE IS A BUTTON, and this one moves money: its inverse is the state
// the day was in. Putting a day back re-commits it and the lock never refuses
// that, so the undo of a call-off always lands. The forward act is toasted,
// unlike most: it has no label on screen, and it is the real-money path.
async function toggleCalGateSkip(nodeId, label, dateStr, skipped) {
  if (!await calGateSkip(nodeId, dateStr, !skipped)) return;
  const when = formatTodoDate(new Date(dateStr + 'T12:00:00'));
  toast(skipped ? `"${label}" is back on for ${when}` : `"${label}" is called off for ${when}`);
  pushUndo(skipped ? `put "${label}" back` : `called off "${label}"`,
    () => calGateSkip(nodeId, dateStr, skipped));
}

registerObjectVerbs('calendar-gate', (kind, id, el) => {
  if (kind !== 'gate' || !el.closest('#cal-week, #tl-qr-layer')) return [];
  const hit = calGateOn(el, id);
  if (!hit || (!hit.g.applies && !hit.g.skipped)) return [];
  const { g, d } = hit;
  return [{
    label: g.skipped ? 'Put this day back on' : 'Call this day off',
    danger: !g.skipped, rightClick: true,
    run: () => toggleCalGateSkip(g.node_id, g.label, d, !!g.skipped),
  }];
});

// The inverse of a moved window: the day's own override as the server stored
// it before the drop, or none, and then a DELETE — an override that merely
// agrees with the default is not an undo (gates.js's restoreWindow, same rule).
async function restoreCalGateWindow(nodeId, dateStr, prev) {
  const res = prev
    ? await apiSend(`/api/accountability/nodes/${nodeId}/overrides`, 'POST', {
        date: dateStr, window_start: prev.window_start, window_end: prev.window_end,
        window_end_offset_days: prev.window_end_offset_days || 0 })
    : await apiSend(`/api/accountability/nodes/${nodeId}/overrides/${dateStr}`, 'DELETE');
  if (!res || !res.ok) {
    const msg = res ? await res.json().catch(() => ({})) : {};
    toast(msg.error || 'Could not undo that window');
    return;
  }
  await reloadCalGates(dateStr);
}

function undoableGateWindow(nodeId, dateStr, prev, label) {
  pushUndo(label, () => restoreCalGateWindow(nodeId, dateStr, prev));
}

// DRAG THE MARK, MOVE THE GATE — for that day. The window TRANSLATES: it keeps
// its length, which is a decision of its own (the 2026-08-24 rule the old pill
// drag followed), and its opening cannot be pushed back past midnight. A mouse
// drags on its left button and right-click calls the day off; a finger holds
// 550ms and then drags, and a hold released WITHOUT moving is the finger's
// right-click. A called-off day has no deadline to move.
//   place(min)  draw the mark at a deadline while it is being dragged
function initGateDrag(handle, g, dateStr, geo, place) {
  if (g.skipped || !g.window || g.window.start_min == null || g.window.end_min == null) return;
  const s0 = g.window.start_min, e0 = g.window.end_min;
  onPointerDrag(handle, { keepClick: true, start(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return null;
    e.stopPropagation();
    const touch = e.pointerType !== 'mouse';
    const startY = e.clientY;
    const bodyPx = geo.px();
    const span = geo.end - geo.start;
    const lo = Math.max(-s0, -720), hi = Math.min(2 * DAY_MIN - 5 - e0, 720);
    const slop = touch ? 0 : 5;
    const title = handle.title;
    let moved = false, delta = 0;
    if (touch) handle.dataset.lpDragged = '1';
    return {
      move(clientY) {
        if (!moved && Math.abs(clientY - startY) < slop) return;
        moved = true;
        handle.dataset.lpDragged = '1';
        delta = Math.min(hi, Math.max(lo, Math.round(((clientY - startY) / bodyPx) * span / 5) * 5));
        const at = e0 + delta;
        place(at);
        handle.title = `${g.label} → ${hhmmToAmPm(clockHHMM(at))}${at >= DAY_MIN ? ' +1d' : ''}`;
        document.body.style.cursor = 'grabbing';
      },
      async end() {
        document.body.style.cursor = '';
        handle.title = title;
        if (!moved) {
          if (touch) toggleCalGateSkip(g.node_id, g.label, dateStr, !!g.skipped);
          return;
        }
        if (!delta) { geo.repaint(); return; }
        const prev = g.override && !g.override.skipped ? g.override : null;
        const ns = s0 + delta, ne = e0 + delta;
        const res = await apiSend(`/api/accountability/nodes/${g.node_id}/overrides`, 'POST', {
          date: dateStr, window_start: clockHHMM(ns), window_end: clockHHMM(ne),
          window_end_offset_days: ne >= DAY_MIN ? 1 : 0,
        });
        if (res && res.ok) {
          undoableGateWindow(g.node_id, dateStr, prev, `moved "${g.label}"`);
        } else {
          // The mark already sits where it was dropped, so silence would read
          // as "saved"; the 24h lock is the refusal a hand can produce.
          const msg = res ? await res.json().catch(() => ({})) : {};
          toast(msg.error || 'Could not move it');
        }
        await reloadCalGates(dateStr);
      },
    };
  } });
}

// ── SEMANTIC MINUTES (2026-08-17) ────────────────────────────
//
// A clock face is 0..1440, but a SPAN can run past midnight and a previous
// day's span reaches back BELOW zero. Those are semantic minutes, and every
// wrap bug came from re-deciding the wrap by hand at a call site:
// detectCurrentStandardBlock compared '23:00' < '01:00' as STRINGS (false, so
// a 22:00–01:00 block was never active and the derived domain was wrong for
// its whole span), flowDueMin added 1440 to the wrong interval, and a gate's
// +1d was read as `off ? 1440 : 0` in three places and `offset == 1` in three
// others.
//
// THE RULE: HH:MM is a BOUNDARY FORMAT. Parse it once, through these, and
// compare minutes from then on. Do not order or compare HH:MM strings outside
// this block — lexicographic order is right only within one day, which is
// exactly the assumption that keeps breaking.
// The accessors themselves — DAY_MIN, timeToMinutes, minutesToHHMM,
// spanEndMin, windowEndMin, clockHHMM, minutesSince — are in static/common.js
// (2026-10-05), so the gates dashboard and the NOW panel ask the same ones.

// Effective default window for a weekday (0=Mon..6=Sun): the node's
// weekly_windows entry for that day, else the node-wide defaults.
// Mirrors the Worker's weeklyWindowFor resolution.
// A gate's effective window for a weekday. `day_windows` is the SERVER's
// resolution — the same qr_judge.resolve_window the judgment uses — keyed by
// date, so the first date matching the weekday answers for it. Falling back to
// weekly_windows/defaults keeps a gate that has no source yet working, which is
// what makes the adoption additive.
function nodeWindowForDow(node, dow) {
  const fromSource = nodeSourceWindowForDow(node, dow);
  if (fromSource) return fromSource;
  let w = null;
  if (node.weekly_windows) {
    try { w = JSON.parse(node.weekly_windows)[String(dow)] || null; } catch (e) { w = null; }
  }
  return w
    ? { window_start: w.window_start, window_end: w.window_end, window_end_offset_days: w.window_end_offset_days || 0 }
    : { window_start: node.window_start, window_end: node.window_end, window_end_offset_days: node.window_end_offset_days };
}

// DOES this gate run on that weekday — one answer, and it is the server's.
//
// `day_windows` is built by SKIPPING every date qr_judge.applies_on refuses, so
// a weekday missing from it is a day the gate is not judged on. Reading
// `days_of_week` first was the drift (2026-08-16): a gate scheduled by a SOURCE
// keeps whatever that legacy column was created with — usually '0123456' — so a
// Monday-only gate drew its hairline on Engage and the timeline every day of the
// week while the judge only ever judged Monday. Display and the money path may
// not disagree. The column stays as the fallback for a gate with no source yet,
// exactly as it is in resolve_window.
function gateAppliesOnDow(node, dow) {
  if (node.day_windows) return !!nodeSourceWindowForDow(node, dow);
  return node.days_of_week == null || String(node.days_of_week).includes(String(dow));
}

// EXACT DATE. day_windows is keyed by date because the judge resolves a DATE —
// a monthly rule, a schedule source or an end date can give two Tuesdays two
// different windows. Scanning for the first date matching a weekday flattened
// that back into a rule and answered for the wrong day.
function nodeSourceWindowForDate(node, dateStr) {
  const days = node.day_windows;
  if (!days || !dateStr) return null;
  return days[dateStr] || null;
}

// Only for a date OUTSIDE the served range (the map covers the ±3 nav clamp
// and a fortnight ahead). Beyond it the weekday shape is the honest guess, and
// nothing outside the clamp is reachable without a review pass anyway.
function nodeSourceWindowForDow(node, dow) {
  const days = node.day_windows;
  if (!days) return null;
  for (const date of Object.keys(days).sort()) {
    // Mon=0..Sun=6, matching qr_judge._dow_of and weekly_windows' keys.
    if (jsDateToDayOfWeek(new Date(date + 'T12:00:00')) === Number(dow)) return days[date];
  }
  return null;
}

// The pair every render should use: ask about the DATE, fall back to its
// weekday only when the date is past the end of the served map.
function nodeWindowForDate(node, dateStr) {
  const days = node.day_windows;
  if (days && dateStr && Object.keys(days).length) {
    const exact = days[dateStr];
    if (exact) return exact;
    // In range but absent = the gate does not run that day; out of range = we
    // simply were not told, so fall back rather than inventing a window.
    const known = Object.keys(days).sort();
    if (dateStr >= known[0] && dateStr <= known[known.length - 1]) {
      return nodeWindowForDow(node, jsDateToDayOfWeek(new Date(dateStr + 'T12:00:00')));
    }
  }
  return nodeWindowForDow(node, jsDateToDayOfWeek(new Date(dateStr + 'T12:00:00')));
}

function gateAppliesOnDate(node, dateStr) {
  const days = node.day_windows;
  if (days && dateStr && Object.keys(days).length) {
    const known = Object.keys(days).sort();
    if (dateStr >= known[0] && dateStr <= known[known.length - 1]) return !!days[dateStr];
  }
  return gateAppliesOnDow(node, String(jsDateToDayOfWeek(new Date(dateStr + 'T12:00:00'))));
}

function localDatePlusDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return formatDateYMD(d);
}


// ── Settings → Gates and Locations ───────────────────────────
//
// Two sections in the 11a grammar: a row states what the gate currently is
// (window, days, geofence) plus a badge for anything non-default (inactive,
// per-day windows, a pending loosening, a today-only override), and its › is
// the only control — every decision is taken in the gate sheet.

async function renderQrManager() {
  const panel = document.getElementById('be-qr-section');
  const locPanel = document.getElementById('be-loc-section');
  if (!panel || !locPanel) return;
  panel.innerHTML = emptyHtml('Loading…');

  let nodes = null;
  let locations = null;
  try {
    [nodes, locations] = await Promise.all([
      fetch('/api/accountability/nodes').then(r => r.json()),
      fetch('/api/locations').then(r => r.json()),
    ]);
  } catch (e) {
    nodes = null;
  }
  // A Worker error body still parses as JSON, so a failed load arrives here as
  // an object, not a throw. It has to be caught before it reaches state: a
  // non-array there breaks every later nodes.map/find — renderTimeline's
  // included, which took the whole to-do side of the app down with it.
  if (!Array.isArray(nodes)) {
    panel.innerHTML = emptyHtml('Failed to load gates.', 'se-error');
    locPanel.innerHTML = '';
    return;
  }
  state.accountabilityNodes = nodes;
  state.locations = Array.isArray(locations) ? locations : [];
  beCounts.qr = nodes.filter(n => n.active).length;
  beCounts.locations = state.locations.filter(l => l.active !== 0).length;

  // Everything about a gate is on the dashboard. What stays is the day's
  // BOUNDARY — which gates clip this window's calendar — a view setting of
  // this app, not a commitment.
  // The dashboard itself is the frame under this (#gates-frame), mounted
  // once; this repaints only the boundary above it.
  panel.innerHTML = gatesBoundary(nodes);
  const edit = document.getElementById('gb-boundary-edit');
  if (edit) edit.addEventListener('click', () => { gatesView.boundary = true; renderQrManager(); });
  [['ac-wake-node', 'qr_wake_node_id'], ['ac-sleep-node', 'qr_sleep_node_id']].forEach(([selId, key]) => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    sel.addEventListener('change', async e => {
      const value = e.target.value || null;
      state.settings = await apiSend('/api/settings', 'PATCH', { [key]: value }).then(r => r.json());
      renderTimeline();
    });
  });

  locPanel.innerHTML = `
    <div class="be-list" id="be-location-list">
      ${state.locations.map(l => beRow({
        id: l.id, name: l.name, dim: l.active === 0,
        meta: `${l.lat}, ${l.lng} · ${l.radius_m}m`,
        badge: l.active === 0 ? 'paused' : '',
      })).join('')}${beAddRow('Add location')}
    </div>`;
  wireBeList(document.getElementById('be-location-list'), 'location', state.locations);
}

// The judge's vocabulary, said in words — the read-out and the rows use it.
const GATE_REASONS = {
  absent: 'no scan',
  no_scan: 'no scan',
  geofence: 'scanned somewhere else',
  geofence_fail: 'scanned somewhere else',
  routine_incomplete: 'routine not done',
  // Nothing writes routine_late any more — a routine gate has no deadline
  // (2026-09-02). Kept because the rows that carry it are frozen.
  routine_late: 'routine done late',
  hours_short: 'short of the hours',
  social_floor: 'social floor not met',
};
const GATE_STATUSES = {
  succeeded: 'charged',
  charging: 'charging…',
  failed: 'not charged (rejected)',
  unknown: 'unknown — may have charged',
  capped: 'skipped — weekly cap',
  dryrun: 'dry run — no money moved',
  would_fire: 'would have charged',
};
const gateReason = r => GATE_REASONS[r] || (r || 'failed').replace(/_/g, ' ');
const gateStatus = st => GATE_STATUSES[st] || (st || '').replace(/_/g, ' ');

// ── Settings → Gates, panel 22b ───────────────────────────────
//
// TWO TABS, because the two jobs are different: editing gates is authoring,
// checking the pipe is diagnosis. The panel used to give a gate, a boundary
// dropdown, a billing field and a log row the same weight on one scroll — so
// the question you actually open it with ("is this running, and is it going to
// charge me?") had to be reassembled from six places.
//
// Gates tab   = the gates, plus one sentence for the day's boundary.
// System tab  = every check that can fail, IN THE ORDER IT FAILS IN, then the
//               failure log as the evidence.
const gatesView = { boundary: false };

// The day's boundary is ONE SENTENCE, not two dropdowns: it is a fact about the
// day you read, and only rarely a decision you take. The selects appear when
// you say so.
function gatesBoundary(nodes) {
  const name = id => (nodes.find(n => String(n.id) === String(id)) || {}).label;
  const wake = name(state.settings.qr_wake_node_id);
  const sleep = name(state.settings.qr_sleep_node_id);
  const opts = sel => '<option value="">— none —</option>' + nodes.filter(n => n.active).map(n =>
    `<option value="${n.id}"${String(n.id) === String(sel) ? ' selected' : ''}>${escHtml(n.label)}</option>`).join('');
  if (gatesView.boundary) {
    return `<div class="be-list">
      <div class="be-set-row">
        <span class="be-set-name">Day starts at</span>
        <select id="ac-wake-node" class="be-set-ctl">${opts(state.settings.qr_wake_node_id)}</select>
      </div>
      <div class="be-set-row">
        <span class="be-set-name">Day ends at</span>
        <select id="ac-sleep-node" class="be-set-ctl">${opts(state.settings.qr_sleep_node_id)}</select>
      </div>
    </div>
    <div class="be-hint">The calendar is clipped to these two gates' deadlines, so it shows your
      waking day rather than a full 24h. Leave either unset for all 24.</div>`;
  }
  return `<div class="gb-boundary">
    <span>${wake && sleep
      ? `The day runs from <b>${escHtml(wake)}</b> to <b>${escHtml(sleep)}</b>. The calendar is clipped to those deadlines.`
      : 'The calendar shows all 24 hours. Pick a gate for each end to clip it to your waking day.'}</span>
    <button id="gb-boundary-edit">Change</button>
  </div>`;
}

// -- TRACKING: what you monitor about yourself, and what it has said ------
//
// The app collected self-monitoring answers every night and rendered NONE of
// them: metric / metric_entry / metric_step were written by the runner,
// metric_history() existed, and no surface ever called it. Settings only
// DEFINES the questions. This page is the other half - the answers.
//
// The journal came in here (2026-08-17) rather than keeping a tab of its own:
// a 1-7 rating IS a scale metric and a nightly prompt IS a text metric, so it
// was a second self-monitoring system with its own table and its own page.
// Habits and experiments sit here too - the same question asked over weeks
// instead of nights.
const trackingView = { metrics: [], habits: null, open: null, days: 60, day: null };

async function openTracking() {
  trackingView.open = null;
  await refreshTracking();
}
window.openTracking = openTracking;

async function refreshTracking() {
  // TODAY IS PINNED HERE, at the read: every answer the Today section files
  // goes under the day it was showing, so a page left open across midnight
  // cannot file last night's answer under the new day.
  trackingView.day = wallDay();
  const day = trackingView.day;
  const [ov, habits, daily] = await Promise.all([
    apiGet(`/api/metrics/overview?days=${trackingView.days}&end=${day}`, { metrics: trackingView.metrics }),
    apiGet('/api/habits', trackingView.habits),
    apiGet(`/api/tag-daily?date=${day}`, state.tagDaily),
  ]);
  trackingView.metrics = (ov && ov.metrics) || [];
  trackingView.habits = habits;
  if (daily && Array.isArray(daily.tags)) state.tagDaily = daily;
  renderTracking();
  renderToday();
  if (settingsView.section == null) renderSettingsIndex();
}

// ── SETTINGS → TODAY (2026-10-05) ─────────────────────────────
//
// The routines are lists now, so nothing runs a metrics step or the nightly
// journal page: this is where a day's metrics (the journal's three among them)
// and the context questions are answered. WHAT is asked today is the server's
// answer (`due`, through step_due_on) — never days_of_week re-read here. An
// answer keeps the step that first asked it; a new one files under step 0,
// the slot the journal page always used, so morning and night history stays
// what it was. Tapping the answer you gave clears it, the rule every answer
// in this app follows.
function todayEntry(m) {
  const es = (m.entries || []).filter(e => e.date === trackingView.day);
  return es.find(e => e.step_id === 0) || es[0] || null;
}

function todayControl(m, e) {
  const btn = (val, label, on) => `<button class="chip chip-sm mx-set${on ? ' on' : ''}"`
    + ` data-metric="${m.id}" data-val="${val}">${escHtml(label)}</button>`;
  if (m.kind === 'yesno') {
    return `<span class="mx-yn">${btn('1', 'yes', e && e.value_num === 1)}${
      btn('0', 'no', e && e.value_num === 0)}</span>`;
  }
  if (m.kind === 'scale') {
    const vals = [];
    for (let v = m.scale_min; v <= m.scale_max; v++) vals.push(v);
    return `<span class="mx-yn">${vals.map(v =>
      btn(String(v), String(v), e && e.value_num === v)).join('')}</span>`;
  }
  if (m.kind === 'count') {
    return `<input class="mx-edit mx-num mx-today-in" type="number" data-metric="${m.id}"`
      + ` value="${e && e.value_num != null ? e.value_num : ''}" placeholder="${escHtml(m.unit || '')}">`;
  }
  return `<textarea class="mx-edit mx-today-in" rows="2" data-metric="${m.id}">${
    escHtml((e && e.value_text) || '')}</textarea>`;
}

function renderToday() {
  const body = document.getElementById('today-body');
  if (!body) return;
  // A focused answer is half-typed text: a repaint would destroy it.
  if (body.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
  const due = (trackingView.metrics || []).filter(m => m.due);
  const daily = state.tagDaily || {};
  const asked = daily.live || daily.tags || [];
  const ans = daily.answers || {};
  body.innerHTML = `
    <div class="mx-list">${due.map(m => `
      <div class="mx-today">
        <span class="mx-name">${escHtml(m.name)}</span>
        ${m.prompt ? `<span class="mx-meta">${escHtml(m.prompt)}</span>` : ''}
        ${todayControl(m, todayEntry(m))}
      </div>`).join('')
      || emptyHtml('Nothing is asked today. The questions are written in Settings → Metrics.')}
    </div>
    ${asked.length ? `<div class="mx-sec">Today's contexts</div>
      <div class="mx-list">${asked.map(t => `
        <div class="mx-today">
          <span class="mx-name">${escHtml(t)}</span>
          <span class="mx-yn">${[[true, 'today'], [false, 'not today']].map(([v, label]) =>
            `<button class="chip chip-sm mx-set${ans[t] === v ? ' on' : ''}" data-tag="${escHtml(t)}"`
            + ` data-val="${v ? 1 : 0}">${label}</button>`).join('')}</span>
        </div>`).join('')}</div>` : ''}`;

  const save = async (id, value) => {
    const m = trackingView.metrics.find(x => x.id === id);
    const e = m && todayEntry(m);
    const res = await apiSend('/api/metrics/entry', 'PUT',
      { date: trackingView.day, metric_id: id, step_id: e ? e.step_id : 0, value });
    if (!res.ok) { toast('Could not save that answer'); return; }
    await refreshTracking();
  };
  body.querySelectorAll('.mx-set[data-metric]').forEach(b => b.addEventListener('click', () =>
    save(parseInt(b.dataset.metric), b.classList.contains('on') ? null : b.dataset.val)));
  body.querySelectorAll('.mx-today-in').forEach(el => el.addEventListener('change', () => {
    el.blur();
    save(parseInt(el.dataset.metric), el.value);
  }));
  body.querySelectorAll('.mx-set[data-tag]').forEach(b => b.addEventListener('click', async () => {
    const applies = b.classList.contains('on') ? null : b.dataset.val === '1';
    const res = await apiSend('/api/tag-daily/answer', 'POST',
      { tag: b.dataset.tag, date: trackingView.day, applies });
    if (!res.ok) { toast('Could not save that answer'); return; }
    await refreshTracking();
  }));
}

// One answer, said the way its own kind says it. A yes/no is not "1".
function metricValueText(m, e) {
  if (!e) return '';
  if (m.kind === 'text') return e.value_text || '';
  if (m.kind === 'yesno') return e.value_num ? 'yes' : 'no';
  const n = e.value_num;
  const shown = Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
  return m.kind === 'scale' ? `${shown}/${m.scale_max}` : `${shown}${m.unit ? ' ' + m.unit : ''}`;
}

// A SPARKLINE, not a chart: the question a glance asks is "which way has this
// been going", which a shape answers and axes only clutter. A scale is drawn
// against its OWN range, so a 4/7 sits mid-height rather than wherever the
// fortnight's spread happens to put it. Text metrics have no line and show
// their last answers instead.
function metricSpark(m) {
  const pts = m.entries.filter(e => e.value_num != null);
  if (pts.length < 2) return '';
  const vals = pts.map(e => e.value_num);
  const lo = m.kind === 'scale' ? m.scale_min : Math.min(...vals);
  const hi = m.kind === 'scale' ? m.scale_max : Math.max(...vals);
  const span = (hi - lo) || 1;
  const W = 72, H = 20;
  const d = pts.map((e, i) => {
    const x = (i / (pts.length - 1)) * W;
    const y = H - ((e.value_num - lo) / span) * H;
    return `${x.toFixed(1)},${Math.max(1, Math.min(H - 1, y)).toFixed(1)}`;
  }).join(' ');
  return `<svg class="mx-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"`
    + ` fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">`
    + `<polyline points="${d}" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function renderTracking() {
  const body = document.getElementById('tracking-body');
  if (!body) return;
  if (trackingView.open) { renderMetricDetail(body); return; }

  const rows = trackingView.metrics.map(m => {
    const last = m.last;
    const recentText = m.kind === 'text'
      ? m.entries.slice(-2).reverse().map(e =>
          `<span class="mx-quote">${escHtml((e.value_text || '').slice(0, 90))}</span>`).join('')
      : '';
    return `<button class="mx-row" data-metric="${m.id}" data-obj="metric:${m.id}">
      <span class="mx-top">
        <span class="mx-name">${escHtml(m.name)}</span>
        <span class="mx-right">${metricSpark(m)}${
          // A text metric's last answer is quoted in full below, so printing
          // it here as well says the same thing twice on one row.
          m.kind === 'text' ? '' : `<span class="mx-last">${
            last ? escHtml(metricValueText(m, last)) : '—'}</span>`}</span>
      </span>
      <span class="mx-meta">${escHtml(m.kind)}${m.answered
        ? ` · ${m.answered} day${m.answered === 1 ? '' : 's'}${
            last ? ` · last ${escHtml(last.date)}` : ''}`
        : ' · not answered yet'}</span>
      ${recentText}
    </button>`;
  }).join('');

  body.innerHTML = `
    <div class="mx-list">${rows || `<div class="empty">No metrics yet — Settings → `
      + `Metrics is where the questions are written.</div>`}</div>
    <div class="mx-sec">Habits and experiments</div>
    <div id="tracking-habit"></div>`;
  renderHabitPanel(trackingView.habits);
  body.querySelectorAll('[data-metric]').forEach(el => el.addEventListener('click', () => {
    trackingView.open = parseInt(el.dataset.metric);
    renderTracking();
  }));
}

// One metric, day by day, and every answer still correctable - the Journal tab
// was the only place a past night could be fixed, so the page replacing it owes
// that. An entry keeps the STEP that asked it: morning and night are two
// askings of one question, and an edit may not merge them.
//
// Only days that were ANSWERED are listed. Adding an answer to a day nothing
// asked about would have to invent an asker, and the routine is what asks.
function renderMetricDetail(body) {
  const m = trackingView.metrics.find(x => x.id === trackingView.open);
  if (!m) { trackingView.open = null; renderTracking(); return; }
  const entries = m.entries.slice().reverse();
  const stepName = id => {
    const s = (m.steps || []).find(x => x.step_id === id);
    if (s) return s.flow_name;
    return id === 0 ? 'nightly journal' : '';
  };
  const control = e => {
    if (m.kind === 'text') {
      return `<textarea class="mx-edit" rows="2" data-date="${e.date}"`
        + ` data-step="${e.step_id}">${escHtml(e.value_text || '')}</textarea>`;
    }
    if (m.kind === 'yesno') {
      return `<span class="mx-yn">${['1', '0'].map(v =>
        `<button class="chip chip-sm mx-set${String(e.value_num) === v ? ' on' : ''}"`
        + ` data-date="${e.date}" data-step="${e.step_id}" data-val="${v}">`
        + `${v === '1' ? 'yes' : 'no'}</button>`).join('')}</span>`;
    }
    return `<input class="mx-edit mx-num" type="number" data-date="${e.date}"`
      + ` data-step="${e.step_id}" value="${e.value_num == null ? '' : e.value_num}"`
      + `${m.kind === 'scale' ? ` min="${m.scale_min}" max="${m.scale_max}"` : ''}>`;
  };
  body.innerHTML = `
    <div class="mx-detail-bar">
      <button class="log-back-btn" id="mx-back">‹ All metrics</button>
      <span class="mx-name">${escHtml(m.name)}</span>
      <span class="mx-meta">${escHtml(m.prompt || '')}</span>
    </div>
    ${entries.map(e => `
      <div class="mx-day">
        <span class="mx-day-date">${escHtml(e.date)}</span>
        ${control(e)}
        <span class="mx-day-step">${escHtml(stepName(e.step_id))}</span>
      </div>`).join('')
      || emptyHtml('Nothing answered in this window yet.')}`;

  document.getElementById('mx-back').addEventListener('click', () => {
    trackingView.open = null;
    renderTracking();
  });
  const save = async (date, stepId, value) => {
    const res = await apiSend('/api/metrics/entry', 'PUT',
      { date, metric_id: m.id, step_id: stepId, value });
    if (!res.ok) { toast('Could not save that answer'); return; }
    await refreshTracking();
  };
  body.querySelectorAll('.mx-edit').forEach(el => el.addEventListener('change', () =>
    save(el.dataset.date, parseInt(el.dataset.step), el.value)));
  body.querySelectorAll('.mx-set').forEach(el => el.addEventListener('click', () =>
    save(el.dataset.date, parseInt(el.dataset.step), el.dataset.val)));
}

function renderHabitPanel(hb) {
  const el = document.getElementById('tracking-habit');
  if (!el) return;
  if (!hb) { el.innerHTML = emptyHtml('Habits unavailable.'); return; }
  trackingView.habits = hb;
  const ex = hb.experiments || {};
  const rows = [];
  // START and RESOLVE live here (2026-08-11): an experiment is a thing you
  // notice while writing the day, not a decision you take once a week. The
  // review only judges what is already resolved.
  if (ex.running) {
    rows.push(`<div class="jh-row"><span class="jh-label">experiment</span>
      ${escHtml(ex.running.content)} <span class="jh-since">since ${escHtml(ex.running.started_on)}</span>
      <button class="cl-pill" id="jh-resolve">end it</button></div>`);
  } else {
    rows.push(`<div class="jh-row"><span class="jh-label">experiment</span>
      <input type="text" id="jh-exp-new" class="gr-ht-input"
        placeholder="start one — change a single cue, response cost, or reward">
      <button class="cl-pill" id="jh-exp-start">start</button></div>`);
  }
  (ex.awaiting || []).forEach(e => rows.push(
    `<div class="jh-row"><span class="jh-label">resolved</span>
      ${escHtml(e.content)} <span class="jh-since">awaits the weekly review</span></div>`));
  (hb.forming || []).forEach(h => rows.push(
    `<div class="jh-row">${habitHealthDot(h.tally)} ${escHtml(h.content)}
      <span class="jh-since">forming since ${escHtml(h.started_on)}${
        h.suggest ? ' · mostly automatic — review will offer graduation' : ''}</span></div>`));
  (hb.ledger || []).forEach(h => rows.push(
    `<div class="jh-row jh-done"><span class="jh-label">${h.status === 'graduated' ? '✓' : '✗'}</span>
      ${escHtml(h.content)}${h.verdict ? ` <span class="jh-since">— ${escHtml(h.verdict)}</span>` : ''}</div>`));
  (hb.legacy || []).forEach(w => rows.push(
    `<div class="jh-row jh-legacy">${escHtml(w.habit)}
      <span class="jh-since">week of ${escHtml(w.week_start_date)} (pre-ledger)</span></div>`));
  el.innerHTML = rows.join('');

  const start = el.querySelector('#jh-exp-start');
  if (start) start.addEventListener('click', async () => {
    const content = el.querySelector('#jh-exp-new').value.trim();
    if (!content) return;
    const res = await apiSend('/api/habit-experiments', 'POST', { content });
    if (!res.ok) { toast((await res.json()).error || 'could not start'); return; }
    renderHabitPanel(await fetch('/api/habits').then(r => r.json()));
  });
  const resolve = el.querySelector('#jh-resolve');
  // The same sheet the routine uses — one ending, wherever you are standing,
  // and the same offer of tomorrow's experiment with it.
  if (resolve) resolve.addEventListener('click', () => endExperimentSheet(ex.running, wallDay(),
    async () => renderHabitPanel(await fetch('/api/habits').then(r => r.json()))));
}

// ── MAP — the inventory lens ─────────────────────────────────
// The whole triaged inventory as a tree: domain → area → projects → actions,
// every state included and nothing filtered by availability. This is the lens
// that answers "what is the state of everything?", so it owns STRUCTURE (area,
// nesting, filing, delete) and it is also where parked work gets reconsidered.
// The rule that keeps the two lenses from re-merging is the inverse one: NOW
// may never write position.
// Controls are allowed to be dense here. MAP is visited once a week and NOW is
// glanced at ~30x a day, so a decision costs about two orders of magnitude less
// on this surface than on that one — friction belongs at the boundary.
let mapWired = false;

// MAP's one piece of view state: the search query. Session-local and NOT
// undoable — it is a lens, not data.
// FOUR QUESTIONS ON ONE INVENTORY, asked from one menu (23a).
//
// MAP is the read-everything surface, so the narrowing lives in the header's
// filter menu rather than a permanent band of chrome: one place that narrows
// the list, and a pill that always names what you are looking at.
//
// The predicates live HERE and nowhere else — each is the client-side reading
// of a state the server already models, and writing them once is what keeps
// "Next actions" on MAP meaning the same thing it means in the pool.
// Deliberately NOT the pool's full availability rule: MAP shows blocked
// (`after_id`) actions too, because seeing the chain is the point of a map.
const MAP_LENSES = [
  { key: 'all', name: 'All', keep: () => true },
  { key: 'waiting', name: 'Waiting & deferred',
    keep: (i, today) => i.status === 'waiting'
      || (i.status === 'active' && i.defer_until && i.defer_until > today) },
  { key: 'projects', name: 'Projects', keep: i => i.kind === 'project' },
  { key: 'someday', name: 'Someday / maybe', keep: i => i.status === 'on_hold' },
];

// `sel` is the keyboard's row (by id) and `tMode` the armed `t` — see MAP BY
// KEYBOARD below.
// `delArm` is a project waiting for its second ⌫.
const mapView = { q: '', lens: 'all', tags: new Set(), menuOpen: false,
                  sel: null, tMode: false, delArm: null, todo: new Set(),
                  horizon: 'projects' };

function mapLens() {
  return MAP_LENSES.find(l => l.key === mapView.lens) || MAP_LENSES[0];
}

// How many terms are narrowing the list beyond the lens — what the pill counts.
function mapFilterExtras() {
  return mapView.tags.size;
}

// THE ONE PLACE the inventory is narrowed. Search runs over the result of this,
// not beside it: a search inside "Waiting & deferred" must not turn up an
// action you are not asking about.
//
// What is on the TO-DO LIST is not here at all (2026-10-01): the list is
// what you will do, Projects what you might — asked of the same served set
// the list reads, through the list's own rule (onTodoList).
function mapVisibleItems(items, today) {
  const lens = mapLens();
  return items.filter(i =>
    !(mapView.todo.has(i.id) && onTodoList(i))
    && lens.keep(i, today)
    && [...mapView.tags].every(t => itemTags(i).includes(t)));
}

// "In" is not a next action, a project or a someday — it is what has not been
// decided yet. It belongs to the whole inventory and to no lens, so any lens
// at all puts it away rather than showing it under a heading it contradicts.
function mapInboxItems() {
  return (mapView.lens === 'all' && !mapView.tags.size)
    ? (state.inbox || []) : [];
}

async function openMap(horizon) {
  mapView.horizon = HORIZONS.some(h => h.key === horizon) ? horizon : 'projects';
  hzView.slots = 0;
  if (!mapWired) {
    const overlay = document.getElementById('map-overlay');
    const shut = () => {
      flushOpenNotes();
      overlay.classList.add('hidden');
    };
    document.getElementById('map-close').addEventListener('click', shut);
    // Wired once, outside renderMap: re-rendering the body on every keystroke
    // must not take the field you are typing in with it.
    // A tap or click on a row selects it too, so the keys act where you are.
    document.getElementById('map-body').addEventListener('pointerdown', e => {
      const row = e.target.closest('.map-row[data-id]');
      if (!row) return;
      mapView.sel = parseInt(row.dataset.id);
      mapSelSync();
    });
    // The index follows the scroll, the way Settings' does.
    const mapBody = document.getElementById('map-body');
    let spy = 0;
    mapBody.addEventListener('scroll', () => {
      cancelAnimationFrame(spy);
      spy = requestAnimationFrame(() => mapIndexSpy(mapBody));
    });
    const q = document.getElementById('map-q');
    q.addEventListener('input', e => { mapView.q = e.target.value; renderMap(); });
    q.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      // Peel: the query first, the overlay only once the search is clear.
      if (!mapView.q) return;
      e.stopPropagation();
      mapView.q = '';
      q.value = '';
      renderMap();
    });
    mapWired = true;
  }
  // Opening MAP selects its FIRST row (mapSelSync falls back to it).
  mapView.sel = null;
  mapView.tMode = false;
  mapView.delArm = null;
  // The page is up at once, drawn from what is already loaded, and the
  // fresh read repaints it — waiting on five fetches first read as lag.
  document.getElementById('map-overlay').classList.remove('hidden');
  renderMap();
  await refreshMap();
}

// The pill NAMES the lens, and counts the domain/tag terms rather than listing
// them — unlike Engage's context button, which is the receipt for items the
// POOL is hiding and must name every term. MAP hides nothing permanently: the
// menu is one tap away and shows exactly what is on. The menu stays open
// across a pick on purpose: narrowing is usually several taps (a lens, then a
// tag).
const mapFilter = stripMenu({
  pill: 'map-filter',
  menu: 'map-filter-menu',
  title: 'What the list is showing — lens and tags',
  isOpen: () => mapView.menuOpen,
  setOpen: on => { mapView.menuOpen = on; },
  pillText: () => {
    const extras = mapFilterExtras();
    return { text: `${mapLens().name}${extras ? ` · ${extras}` : ''}`,
             narrowed: mapView.lens !== 'all' || !!extras };
  },
  // Tags offered are the ones the inventory actually carries, plus any already
  // required — narrowing to a tag must never make its own chip disappear.
  sections: () => [
    { title: 'List — showing',
      chips: pickChipsHtml(MAP_LENSES.map(l => ({ value: l.key, label: l.name })),
                           mapView.lens, 'data-lens') },
    { title: 'Tags — every selected one required',
      chips: tagChipsHtml([...new Set([...(state.mapItems || []).flatMap(itemTags), ...mapView.tags])].sort(),
                          mapView.tags, 'data-maptag', 'no tags in the inventory yet') },
    { title: 'Order',
      chips: pickChipsHtml([
        { value: 'on', label: 'due first', title: 'Due dates first, then deferred by how soon they return' },
        { value: 'off', label: 'tree order' }], mapSortOn() ? 'on' : 'off', 'data-mapsort') },
  ],
  foot: () => '<button class="chip" id="map-export" title="Downloads it and copies it">⤓ Download Markdown</button>',
  clear: () => { mapView.lens = 'all'; mapView.tags.clear(); },
  onChange: () => renderMap(),
  wire: (menu, stay) => {
    menu.querySelectorAll('[data-lens]').forEach(b =>
      stay(b, () => { mapView.lens = b.dataset.lens; }));
    menu.querySelectorAll('[data-maptag]').forEach(b =>
      stay(b, () => toggleInSet(mapView.tags, b.dataset.maptag)));
    menu.querySelectorAll('[data-mapsort]').forEach(b => stay(b, () => {
      if (b.dataset.mapsort === 'off') localStorage.setItem('mapSort', 'off');
      else localStorage.removeItem('mapSort');   // absent = on, one default
    }));
    menu.querySelector('#map-export').addEventListener('click', e => {
      e.stopPropagation();
      exportMap();
    });
  },
});

// ── HORIZONS (2026-10-07, Quentin's design "Horizons Page") ──────────────
//
// The Projects page became GTD's five horizons, one at a time behind one pill
// in the strip: Projects is the page it always was (lens, search, keys), and
// the four above it are what the projects are FOR. Areas and Goals are short
// documents in the Now column, Purpose one sentence in the middle of the page,
// Vision photographs edge to edge. The documents are settings rows (one each,
// HZ_DOC_KEYS), the photos files in the data dir (storage.VISION_DIR). The
// horizon is in the address (`/horizons/goals`), so a reload lands on it.
const HORIZONS = [
  { key: 'projects', name: 'Projects' },
  { key: 'areas', name: 'Areas of accountability' },
  { key: 'goals', name: 'Goals' },
  { key: 'vision', name: 'Vision' },
  { key: 'purpose', name: 'Purpose' },
];
const HZ_DOC_KEYS = { areas: 'horizon_areas', goals: 'horizon_goals', purpose: 'horizon_purpose' };
const HZ_PLACEHOLDER = {
  areas: 'The areas you keep up, and the standard each is held to. Start a line with ### for a heading, - for a list.',
  goals: 'What you mean to have done in a year or two. Start a line with ### for a heading, - for a list.',
  purpose: 'Write your purpose in one sentence.',
};
// `slots` is the empty photo frames "+ Add photo" asked for; with no photos
// there is always one, so the page is never blank.
const hzView = { menuOpen: false, slots: 0 };

function horizonName(key) {
  return (HORIZONS.find(h => h.key === key) || HORIZONS[0]).name;
}

const hzMenu = stripMenu({
  pill: 'hz-pill',
  menu: 'hz-menu',
  title: 'Which horizon — 1–5, or ← →',
  isOpen: () => hzView.menuOpen,
  setOpen: on => { hzView.menuOpen = on; if (on) mapFilter.close(); },
  pillText: () => ({ text: horizonName(mapView.horizon), narrowed: false }),
  sections: () => [{ title: 'Horizon',
    chips: pickChipsHtml(HORIZONS.map(h => ({ value: h.key, label: h.name })),
                         mapView.horizon, 'data-hz-pick') }],
  onChange: () => {},
  wire: (menu, stay) => menu.querySelectorAll('[data-hz-pick]').forEach(b =>
    stay(b, () => setHorizon(b.dataset.hzPick))),
});

function setHorizon(key) {
  if (!HORIZONS.some(h => h.key === key)) return;
  flushOpenNotes();
  hzView.menuOpen = false;
  hzView.slots = 0;
  mapView.horizon = key;
  renderMap();
  document.getElementById('map-body').scrollTop = 0;
  syncRoute();
}

// ← → step through the horizons from anywhere on the page; 1–5 pick one,
// except on Projects, where 1–3 were already its rows' priorities.
document.addEventListener('keydown', e => {
  const ov = document.getElementById('map-overlay');
  if (!ov || ov.classList.contains('hidden') || e.defaultPrevented) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
            || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const settings = document.getElementById('modal-overlay');
  if ((settings && !settings.classList.contains('hidden')) || clarifyView.open
      || entrySheet.open || seSheet.kind || objMenu.open || mapView.tMode) return;
  const i = HORIZONS.findIndex(h => h.key === mapView.horizon);
  let to = -1;
  if (e.key === 'ArrowRight') to = i + 1;
  else if (e.key === 'ArrowLeft') to = i - 1;
  else if (/^[1-5]$/.test(e.key) && mapView.horizon !== 'projects') to = +e.key - 1;
  if (to < 0 || to >= HORIZONS.length || to === i) return;
  e.preventDefault();
  setHorizon(HORIZONS[to].key);
});

async function saveHorizonDoc(key, value) {
  state.settings = state.settings || {};
  state.settings[key] = value;
  const res = await apiSendData('/api/settings', 'PATCH', { [key]: value || null });
  if (!res.ok) toast(res.data.error || 'Could not save that');
}

// A HORIZON DOCUMENT IS A NOTES FIELD in everything but its shape: it saves
// on the notes debounce, joins openNotes so every close flushes it, pushes ONE
// undo per editing session, and pastes as text. Half-typed text is data, so a
// repaint leaves a focused document alone (renderHorizon).
function wireHorizonDoc(el, h) {
  const key = HZ_DOC_KEYS[h];
  const plain = h === 'purpose';
  const read = () => {
    const text = el.textContent.trim();
    return plain ? text : (text ? el.innerHTML : '');
  };
  let timer = null, pending = false, undoPushed = false;
  const flush = async () => {
    clearTimeout(timer);
    timer = null;
    if (!pending) return;
    pending = false;
    const value = read();
    const prev = (state.settings || {})[key] || '';
    if (value === prev) return;
    if (!undoPushed) {
      undoPushed = true;
      pushUndo(`edited ${horizonName(h)}`, async () => {
        await saveHorizonDoc(key, prev);
        renderMap();
      });
    }
    await saveHorizonDoc(key, value);
  };
  el.addEventListener('input', () => {
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(flush, NOTES_SAVE_MS);
  });
  el.addEventListener('blur', () => {
    if (!plain && !el.textContent.trim() && !el.querySelector('li')) el.innerHTML = '';
    flush();
  });
  // Every line is a block, so a line's shape can change (below); the first one
  // is made on focus, and an empty document is emptied again on blur so its
  // placeholder comes back.
  el.addEventListener('focus', () => {
    document.execCommand('defaultParagraphSeparator', false, 'p');
    if (plain || el.firstChild) return;
    el.innerHTML = '<p><br></p>';
    const r = document.createRange();
    r.setStart(el.firstChild, 0);
    r.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  el.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, plain ? text.replace(/\s*\n\s*/g, ' ') : text);
  });
  el.addEventListener('keydown', e => {
    // Escape means done, never revert, and it stops here: the page stays up.
    if (e.key === 'Escape') { e.stopPropagation(); el.blur(); return; }
    if (plain) {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      return;
    }
    // `### ` makes a heading and `- ` a list, typed at the start of a line —
    // the markdown the notes fields already speak, turned into the shape.
    // Done on the DOM: execCommand's formatBlock/delete pair merged lines.
    if (e.key !== ' ') return;
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3 || node.previousSibling) return;
    const before = node.textContent.slice(0, sel.anchorOffset);
    const heading = /^#{1,3}$/.test(before), list = /^[-*]$/.test(before);
    if (!heading && !list) return;
    let line = node.parentNode;
    if (line === el) {
      line = document.createElement('p');
      el.insertBefore(line, node);
      line.appendChild(node);
    }
    if (line.parentNode !== el || !/^(P|DIV|H3)$/.test(line.tagName)) return;
    e.preventDefault();
    node.textContent = node.textContent.slice(before.length);
    let into = document.createElement(heading ? 'h3' : 'li');
    while (line.firstChild) into.appendChild(line.firstChild);
    if (!into.textContent) into.innerHTML = '<br>';
    if (heading) line.replaceWith(into);
    else {
      const prev = line.previousElementSibling;
      if (prev && prev.tagName === 'UL') { prev.appendChild(into); line.remove(); }
      else { const ul = document.createElement('ul'); ul.appendChild(into); line.replaceWith(ul); }
    }
    const r = document.createRange();
    r.setStart(into.firstChild, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    el.dispatchEvent(new Event('input'));
  });
  el.__flushNotes = flush;
  openNotes.push(el);
}

function readDataUrl(blob) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => res(null);
    r.readAsDataURL(blob);
  });
}

async function addVisionPhoto(file) {
  if (!file || !/^image\//.test(file.type)) { toast('That is not an image'); return; }
  const res = await apiSendData('/api/vision', 'POST', { data: await readDataUrl(file) });
  if (!res.ok) { toast(res.data.error || 'Could not add that photo'); return; }
  const name = res.data.name;
  pushUndo('added a photo', async () => {
    await apiSend(`/api/vision/${encodeURIComponent(name)}`, 'DELETE');
    await refreshMap();
  });
  if (hzView.slots) hzView.slots--;
  await refreshMap();
}

// The undo puts the same bytes back under the same name, so the photo returns
// to where it was in the order.
async function removeVisionPhoto(name) {
  const url = encodeURIComponent(name);
  const blob = await fetch(`/vision/${url}`).then(r => (r.ok ? r.blob() : null)).catch(() => null);
  const res = await apiSendData(`/api/vision/${url}`, 'DELETE');
  if (!res.ok) { toast(res.data.error || 'Could not remove that photo'); return; }
  const data = blob && await readDataUrl(blob);
  if (data) {
    pushUndo('removed a photo', async () => {
      await apiSend('/api/vision', 'POST', { data, name });
      await refreshMap();
    });
  }
  await refreshMap();
}

function renderHorizon(body) {
  const h = mapView.horizon;
  // A document being written in is not repainted under the cursor.
  const live = body.querySelector(`.hz-doc[data-hz="${h}"]`);
  if (live && live === document.activeElement) return;
  if (HZ_DOC_KEYS[h]) {
    const editor = `<div class="hz-doc${h === 'purpose' ? ' hz-doc-purpose' : ''}" contenteditable="true"
      data-hz="${h}" data-ph="${escHtml(HZ_PLACEHOLDER[h])}" spellcheck="true"></div>`;
    body.innerHTML = h === 'purpose'
      ? `<div class="hz-purpose">${editor}</div>`
      : `<div class="mp-page"><nav class="mp-index"></nav><div class="mp-main hz-main">${editor}</div></div>`;
    const el = body.querySelector('.hz-doc');
    const saved = (state.settings || {})[HZ_DOC_KEYS[h]] || '';
    if (h === 'purpose') el.textContent = saved; else el.innerHTML = saved;
    wireHorizonDoc(el, h);
    return;
  }
  // Vision: the photos edge to edge, then the empty frames, then + Add photo.
  const photos = state.vision || [];
  const slots = photos.length ? hzView.slots : Math.max(1, hzView.slots);
  body.innerHTML = `<div class="hz-vision">${photos.map(n => `<div class="hz-photo" data-photo="${escHtml(n)}"
      title="Right-click or hold to remove"><img src="/vision/${encodeURIComponent(n)}" alt=""></div>`).join('')}${
    Array.from({ length: slots }, () => `<button class="hz-photo hz-slot">Drop a 1920 × 1200 photo</button>`).join('')}
    <button class="hz-add">+ Add photo</button>
    <input type="file" accept="image/*" class="hidden" id="hz-file">
  </div>`;
  const file = body.querySelector('#hz-file');
  file.addEventListener('change', () => { if (file.files[0]) addVisionPhoto(file.files[0]); file.value = ''; });
  body.querySelectorAll('.hz-slot').forEach(slot => {
    slot.addEventListener('click', () => file.click());
    slot.addEventListener('dragover', e => { e.preventDefault(); slot.classList.add('hz-slot-over'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('hz-slot-over'));
    slot.addEventListener('drop', e => {
      e.preventDefault();
      slot.classList.remove('hz-slot-over');
      const f = e.dataTransfer.files[0];
      if (f) addVisionPhoto(f);
    });
  });
  body.querySelector('.hz-add').addEventListener('click', () => {
    hzView.slots = (photos.length ? hzView.slots : Math.max(1, hzView.slots)) + 1;
    renderMap();
  });
  body.querySelectorAll('.hz-photo[data-photo]').forEach(ph => {
    const menu = (x, y) => openObjectMenu(x, y, 'vision', ph.dataset.photo, [
      { label: 'Remove photo', danger: true, run: () => removeVisionPhoto(ph.dataset.photo) }]);
    ph.addEventListener('contextmenu', e => { e.preventDefault(); menu(e.clientX, e.clientY); });
    onLongPress(ph, () => {
      const r = ph.getBoundingClientRect();
      menu(r.left + r.width / 2, r.top + r.height / 2);
    });
  });
}

// MAP PAGE, 9a (2026-10-01, Quentin's design): the Now page's shell — the
// area's name in the left column where the date sits on Now, pinned while its
// projects scroll past in the middle one, the right column empty. One section
// per area; the In pile, a search's hits and the roster wear the same shape.
// Below 900px the three columns are one, the label a heading over its rows.
function mpSection(label, sub, rows) {
  return `<section class="mp-area">
    <div class="mp-label"><div class="mp-label-in">${label ? `<span class="mp-name">${escHtml(label)}</span>` : ''}${
      sub ? `<span class="mp-sub">${escHtml(sub)}</span>` : ''}</div></div>
    <div class="mp-col">${rows}</div>
    <div class="mp-right"></div>
  </section>`;
}

// THE PROJECTS PAGE'S SECTIONS (2026-10-01, Quentin's instruction): one per
// AREA — every standard area while nothing narrows the list, so an empty one
// can still be found and filled; only the ones with rows under a filter —
// then what is filed under none, then the inbox. The page and its Markdown
// both read this, so the file you save is the page you were looking at.
function mapSections(items, inboxItems) {
  const narrowed = mapLens().key !== 'all' || !!mapFilterExtras();
  const byArea = {};
  items.forEach(i => { (byArea[i.area_id || 0] = byArea[i.area_id || 0] || []).push(i); });
  const areas = (state.areas || []).filter(a => a.type === 'standard'
      && (byArea[a.id] || (!narrowed && a.active)))
    .sort((x, y) => x.name.localeCompare(y.name));
  const secs = areas.map(a => ({ key: `a${a.id}`, name: a.name, obj: `area:${a.id}`,
                                 paused: !a.active, items: byArea[a.id] || [] }));
  const known = new Set(areas.map(a => a.id));
  const loose = items.filter(i => !known.has(i.area_id));
  if (loose.length) secs.push({ key: 'none', name: 'No area', items: loose });
  if (inboxItems.length) secs.push({ key: 'in', name: 'In', sub: 'not yet clarified',
                                    inbox: true, items: inboxItems });
  return secs;
}

// The index lights the section the scroll is in — the last whose title has
// reached the top.
function mapIndexSpy(body) {
  const top = body.getBoundingClientRect().top;
  let cur = null;
  body.querySelectorAll('.mp-sec[data-sec]').forEach(sec => {
    if (sec.getBoundingClientRect().top - top - 40 <= 0) cur = sec.dataset.sec;
  });
  if (!cur) { const first = body.querySelector('.mp-sec[data-sec]'); cur = first && first.dataset.sec; }
  body.querySelectorAll('.mp-idx[data-go]').forEach(b => b.classList.toggle('on', b.dataset.go === cur));
}

function wireMapIndex(body) {
  body.querySelectorAll('.mp-idx[data-go]').forEach(btn => btn.addEventListener('click', () => {
    const sec = body.querySelector(`.mp-sec[data-sec="${btn.dataset.go}"]`);
    if (sec) body.scrollTop += sec.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
  }));
  // An area is made where the areas are listed — the same sheet Settings
  // opens, so it is one thing with one editor.
  body.querySelectorAll('.mp-add-area').forEach(btn => btn.addEventListener('click', () => {
    openSeSheet('area', null, async () => { closeSeSheet(); await refreshMap(); });
  }));
  mapIndexSpy(body);
}


async function refreshMap() {
  // Areas and domains come along because MAP now RENDERS them (the roster at
  // its foot). A surface reads what it draws: leaving them to whoever happened
  // to load state.areas last is how an area added here fails to appear until
  // something unrelated refreshes. Every fetch falls back to CURRENT state, not
  // [] — Promise.all rejects as a unit, and one dead endpoint used to blank it.
  const [items, projects, inbox, areas, todo, vision, settings] = await Promise.all([
    apiGet('/api/map', state.mapItems || []),
    apiGet('/api/projects', state.projects || []),
    apiGet('/api/inbox', state.inbox || []),
    apiGet('/api/areas', state.areas || []),
    // The to-do list's own read, so Projects leaves out exactly what it shows.
    apiGet('/api/inbox/active', null),
    // The horizons above Projects: their photos and their documents.
    apiGet('/api/vision', state.vision || []),
    apiGet('/api/settings', null),
  ]);
  state.vision = vision;
  if (settings) state.settings = settings;
  state.mapItems = items;
  state.projects = projects;
  state.inbox = inbox;
  state.areas = areas;
  if (Array.isArray(todo)) mapView.todo = new Set(todo.map(i => i.id));
  renderMap();
}

// HTML5 drag never auto-scrolls an inner overflow container, so dragging to a
// target above the fold used to be impossible. While a drag is over the
// container, nudge it whenever the pointer nears an edge — dragover keeps
// firing (even stationary), so this self-sustains without a timer.
function dragEdgeScroll(el) {
  if (el.__dragScroll) return;
  el.__dragScroll = true;
  el.addEventListener('dragover', e => {
    const r = el.getBoundingClientRect();
    const EDGE = 56;
    if (e.clientY < r.top + EDGE) el.scrollTop -= 16;
    else if (e.clientY > r.bottom - EDGE) el.scrollTop += 16;
  });
}

// MAP's sort: DATED work first, in order of how soon it bites.
//
//   1. anything with a due date        — soonest first
//   2. anything deferred to a future   — soonest first, i.e. closest to
//      date                              coming back
//   3. everything else                 — the tree's own order
//
// The two tiers are separate rather than one merged date column because they
// are different claims: a deadline is when it must be DONE, a defer date is
// when it may be STARTED. Interleaving them would put "can't touch this for
// three weeks" above "due Friday".
//
// Applied to SIBLINGS at every level of the tree, so a project's actions sort
// the same way its projects do. Not applied to search results — those are
// ranked by relevance, which is the entire point of a search.
function mapSortOn() {
  return localStorage.getItem('mapSort') !== 'off';
}

function mapSortRank(i, todayStr) {
  // Due, then PLAIN, then deferred (Quentin, 2026-08-11 — deferred used to
  // sit second): a deferred row is one you told to leave you alone, so it
  // reads below the work that is actually on the table, closest-returning
  // first.
  const due = dueOf(i);
  if (due) return [0, due];
  if (i.defer_until && i.defer_until > todayStr) return [2, i.defer_until];
  return [1, ''];
}

function mapSortSiblings(list, todayStr) {
  if (!mapSortOn()) return list;
  // Decorate with the original index so the third tier stays STABLE — the
  // tree's own order is meaningful (it is area/id order from storage).
  return list.map((i, n) => [mapSortRank(i, todayStr), n, i])
    .sort((a, b) => a[0][0] - b[0][0]
      || a[0][1].localeCompare(b[0][1])
      || a[1] - b[1])
    .map(x => x[2]);
}

// SOMEDAY IS SPLIT OUT (2026-08-10). It used to be interleaved with live
// work, and since MAP deliberately badges no 'someday' marker, a parked item
// was indistinguishable from an active one — so reading the tree meant
// re-deciding the state of every row. Two piles, two levels of rigour.
//
// The split is at the ROOT: a subtree goes wherever its root goes. An
// on_hold PROJECT takes its children with it (they are parked with it), and
// a parked action under a live project stays inside that project's
// structure, where its absence from the pool is the project's problem.
function mapAreaForest(areaItems, wantSomeday, todayStr) {
  const inView = new Set(areaItems.map(i => i.id));
  const kidsOf = {};
  const roots = [];
  areaItems.forEach(item => {
    const pid = item.project_id && inView.has(item.project_id) ? item.project_id : null;
    if (pid) (kidsOf[pid] = kidsOf[pid] || []).push(item);
    else roots.push(item);
  });
  const parked = r => r.status === 'on_hold';
  return {
    roots: mapSortSiblings(roots.filter(r => (wantSomeday ? parked(r) : !parked(r))), todayStr),
    kids: item => mapSortSiblings(kidsOf[item.id] || [], todayStr),
  };
}

// The row's tint, from its OWN priority tag — MAP shows a row's own tags, so
// the colour sits where the priority was set, not on everything beneath it.
function mapPriorityClass(item) {
  const p = PRIORITY_TAGS.find(t => ownTags(item).includes(t));
  return p ? ` map-row-${p}` : '';
}

// The gestures every MAP row carries, wherever it is rendered — the tree and
// the flat search results share them, so a hit behaves exactly like the row it
// stands for. Drag is NOT here: it is the tree's alone (see renderMap).
function wireMapRows(body, byId, afterFn) {
  const after = afterFn
    || (async () => { await refreshMap(); await refreshActiveItems(); });
  // Single click opens the clarify sheet, double click still renames. A
  // dblclick always fires a click first, so the single-click action waits out
  // the double-click window before committing.
  body.querySelectorAll('.map-text').forEach(span => {
    onTapOrDouble(span, () => {
      const item = byId[parseInt(span.closest('.map-row').dataset.id)];
      if (item) openClarifyForItem(item, after);
    }, () => {
      const row = span.closest('.map-row');
      const id = parseInt(row.dataset.id);
      const item = byId[id];
      if (!item) return;
      inlineEdit(span, {
        value: item.content,
        row,
        onCancel: after,
        onCommit: async content => {
          undoablePatch(item, ['content'], `renamed "${item.content}"`);
          await apiSend(`/api/inbox/${id}`, 'PATCH', { content });
          await after();
        },
      });
    });
  });

  // The one control on a row. State, area, due, notes and the trash all live
  // behind it now — the sheet decides them in one place, in one grammar.
  body.querySelectorAll('.map-open').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = byId[parseInt(btn.dataset.id)];
      if (item) openClarifyForItem(item, after);
    });
  });
}

// MAP holds one piece of view state now — the search query (mapView.q). Every
// WRITE a row used to own inline (state, area, un-nest, notes, delete) is a
// CLARIFY decision, and the sheet is where it is made. What is left here is
// reading the tree, searching it, and re-positioning it by drag.
function renderMap() {
  const body = document.getElementById('map-body');
  if (!body) return;
  const todayStr = wallDay();
  hzMenu.render();
  // Projects keeps its lens and search; the horizons above it have neither.
  const onProjects = mapView.horizon === 'projects';
  ['map-filter', 'map-search', 'map-q-count'].forEach(id =>
    document.getElementById(id).classList.toggle('hidden', !onProjects));
  if (!onProjects) { renderHorizon(body); return; }
  mapFilter.render();
  // Everything below reads the NARROWED set, search included — a search inside
  // "Waiting & deferred" must not turn up an action you are not asking about.
  const items = mapVisibleItems(state.mapItems || [], todayStr);
  const inboxItems = mapInboxItems();
  const byId = {};
  items.forEach(i => { byId[i.id] = i; });
  // "In" rows join the lookup so the shared .map-text click/rename handlers
  // reach them too; they are not part of the tree and never enter kidsOf.
  inboxItems.forEach(i => { byId[i.id] = i; });
  // A project with no live action is GTD's stall signal and the review's
  // load-bearing check, so it is marked here rather than only counted there.
  const stalled = new Set((state.projects || []).filter(p => !p.action_count).map(p => p.id));

  // (The per-row area select is gone: moving a project to another domain is
  // the clarify sheet's "Filing to" row now, which says domain-then-area in
  // the same words the rest of the app uses.)

  // Only states worth SCANNING for get a badge. 'waiting' does — it is the one
  // that needs chasing — and a defer date does, because the select can't show
  // it. 'someday' doesn't: the state dropdown already says so on every row, and
  // 23 identical badges is noise on the surface meant for reading the whole
  // inventory at once.
  // ONE QUIET MONO STRING (Map Page 9a, 2026-10-01): what a row's state
  // says, joined by ' · ' — waiting, due, a defer date, its own priority, a
  // push count worth noticing. The tag chips went: they are what the filter
  // menu narrows by, and on the read-everything surface they were the noise.
  const badge = item => {
    const parts = [];
    if (item.status === 'waiting') parts.push('<span class="mp-wait">waiting</span>');
    const due = dueChip(item, 'mp-due');
    if (due) parts.push(due);
    if (item.defer_until && item.defer_until > todayStr) parts.push(`→ ${escHtml(item.defer_until)}`);
    const prio = PRIORITY_TAGS.find(t => ownTags(item).includes(t));
    if (prio) parts.push(prio);
    if (item.pushed >= 3) {
      parts.push(`<span title="Not-today'd ${item.pushed} times — too big, not real, or being avoided">pushed ${item.pushed}x</span>`);
    }
    return parts.join(' · ');
  };

  // Chain positions ([1] [2] …) per project — MAP shows the whole chain even
  // though the pool hides everything past the head.
  const chainN = {};
  {
    const byProj = {};
    items.forEach(i => {
      if (i.project_id && i.kind !== 'project') {
        (byProj[i.project_id] = byProj[i.project_id] || []).push(i);
      }
    });
    Object.values(byProj).forEach(acts => Object.assign(chainN, chainNumbers(acts)));
  }

  // A row is its TEXT, which is the control: a tap opens the clarify sheet,
  // a double-click renames, a drag files it.
  const rowHtml = item => {
    const isProject = item.kind === 'project';
    const isStalled = isProject && stalled.has(item.id);
    const meta = badge(item);
    return `<div class="map-row${isProject ? ' map-row-project' : ''}${
        isStalled ? ' map-row-stalled' : ''}" data-id="${item.id}" draggable="true">
      ${chainN[item.id] ? `<span class="cl-chain-n" title="Position in this project's dependency chain">[${chainN[item.id]}]</span>` : ''}
      <span class="map-text" title="Tap to clarify · double-click to rename">${escHtml(item.content)}</span>
      ${meta ? `<span class="mp-meta">${meta}</span>` : ''}
    </div>`;
  };

  // No add affordance here any more: MAP is a reading surface, and "give
  // this project a next action" already has a home on GTD's Projects list
  // (the same + that puts the global bar in the project's mode).
  const areaTreeHtml = (areaItems, wantSomeday) => {
    const forest = mapAreaForest(areaItems, wantSomeday, todayStr);
    const subtree = item => {
      const kids = forest.kids(item);
      return rowHtml(item) + (kids.length
        ? `<div class="map-kids">${kids.map(subtree).join('')}</div>` : '');
    };
    return forest.roots.map(subtree).join('');
  };


  // "In" is not part of the inventory — it is what hasn't been decided yet, so
  // get_map_items excludes it. But MAP is the read-EVERYTHING surface, and an
  // undecided pile you can only reach through the day's Clarify count is a
  // pile you forget you have. It sits at the bottom, below the tree, because
  // the tree is what you came to read.
  const inboxRows = list => list.map(i => `<div class="map-row map-row-in" data-id="${i.id}">
        <span class="map-text" title="Tap to clarify · double-click to reword">${escHtml(i.content)}</span>
      </div>`).join('');

  // ── Search ────────────────────────────────────────────────
  //
  // The clarify project search's matcher (relScore — word overlap plus a
  // character-bigram Dice score; at this corpus size that IS semantic search,
  // no embeddings, no network) run over the WHOLE inventory instead of just
  // projects. A substring hit always counts; a fuzzy one has to clear the same
  // 0.5 relScore bar clarify uses for its "closest matches".
  //
  // Results are FLAT and ranked, not a pruned tree: the ranking is the point,
  // and it can't survive nesting. Each row keeps its breadcrumb, so position —
  // the thing the tree was telling you — is still on screen. Drag is off here
  // for the same reason: there is nothing coherent to drop into in a ranked
  // list, and filing stays a tree gesture.
  const q = mapView.q.trim();
  const qLower = q.toLowerCase();
  const countEl = document.getElementById('map-q-count');
  if (q) {
    const parentOf = {};
    items.forEach(i => { parentOf[i.id] = i.project_id; });
    const crumb = i => {
      const parts = [];
      if (i.domain_name) parts.push(i.domain_name);
      if (i.area_name) parts.push(i.area_name);
      const p = i.project_id && byId[i.project_id];
      if (p) parts.push(p.content);
      return parts.join(' › ');
    };
    const hits = [...items, ...inboxItems]
      .map(i => {
        const sub = (i.content || '').toLowerCase().includes(qLower);
        const score = relScore(q, i.content || '');
        return { i, sub, score };
      })
      .filter(h => h.sub || h.score >= 0.5)
      // Substring hits first (you typed it, it is there), then by relevance.
      .sort((a, b) => (b.sub - a.sub) || (b.score - a.score)
        || (a.i.content || '').localeCompare(b.i.content || ''));

    if (countEl) countEl.textContent = `${hits.length} of ${items.length + inboxItems.length}`;
    body.innerHTML = `<div class="mp-page mp-searching"><div class="mp-main"><section class="mp-sec">
      <h2 class="mp-sec-title">Search<span class="mp-sub">${hits.length} found</span></h2>${hits.length ? hits.map(({ i }) => {
      const isIn = !i.status || i.status === 'in';
      const isProject = i.kind === 'project';
      return `<div class="map-row map-row-hit${isProject ? ' map-row-project' : ''}${
          isProject && stalled.has(i.id) ? ' map-row-stalled' : ''}${
          isIn && !i.area_id ? ' map-row-in' : ''}${mapPriorityClass(i)}" data-id="${i.id}">
        <span class="map-text" title="Tap to clarify · double-click to rename">${escHtml(i.content)}</span>
        <span class="mp-meta">${[badge(i), `<span class="map-crumb">${escHtml(crumb(i)) || 'in'}</span>`]
          .filter(Boolean).join(' · ')}</span>
      </div>`;
    }).join('') : `<div class="empty">Nothing matches "${escHtml(q)}".</div>`}</section></div></div>`;
    wireMapRows(body, byId);
    mapSelSync();
    return;
  }
  if (countEl) countEl.textContent = '';

  // THE PROJECTS PAGE (2026-10-01): the areas are an INDEX in the left column
  // — the way Settings' sections are — lit for the one the scroll is in, with
  // + Add area at its foot; each area is a titled section down the middle.
  const secs = mapSections(items, inboxItems);
  const secHtml = sec => {
    let rows;
    if (sec.inbox) rows = inboxRows(sec.items);
    else {
      const live = areaTreeHtml(sec.items, false);
      const later = areaTreeHtml(sec.items, true);
      const nLater = sec.items.filter(i => i.status === 'on_hold').length;
      rows = live + (later ? `<div class="map-someday-head">Someday / maybe<span class="count">${nLater}</span></div>${later}` : '');
    }
    return `<section class="mp-sec" data-sec="${sec.key}">
      <h2 class="mp-sec-title"${sec.obj ? ` data-obj="${sec.obj}"` : ''}>${escHtml(sec.name)}${
        sec.paused ? '<span class="mp-sub">paused</span>' : ''}${
        sec.sub ? `<span class="mp-sub">${escHtml(sec.sub)}</span>` : ''}</h2>
      ${rows || emptyHtml('Nothing filed here.')}
    </section>`;
  };
  const empty = `<div class="empty mp-none">${
    mapLens().key !== 'all' || mapFilterExtras()
      // An empty list under a filter is a fact about the QUESTION, not about
      // the inventory — say which, or it reads as "you have nothing".
      ? `Nothing answers “${escHtml(mapLens().name)}”${mapFilterExtras() ? ' with those filters' : ''}.`
      : 'Nothing here yet — the to-do list holds what you will do; this holds the rest.'
  }</div>`;
  body.innerHTML = `<div class="mp-page">
    <nav class="mp-index">${secs.map(sec => `<button class="mp-idx" data-go="${sec.key}"${
      sec.obj ? ` data-obj="${sec.obj}"` : ''}>${escHtml(sec.name)}</button>`).join('')}
      <button class="mp-add-area mp-idx-add">+ Add area</button></nav>
    <div class="mp-main">${secs.map(secHtml).join('') || empty}
      <button class="mp-add-area mp-add-foot">+ Add area</button></div>
  </div>`;

  const patchItem = (id, patch) => apiSend(`/api/inbox/${id}`, 'PATCH', patch);
  const after = async () => { await refreshMap(); await refreshActiveItems(); };

  wireMapRows(body, byId);
  wireMapIndex(body);

  // Drag one row onto another to file it there — the same act as the filing
  // target, so the destination becomes a project by the usual invariant. The
  // only refusals are no-ops and cycles.
  let dragId = null;
  const canDrop = (srcId, dstId) => {
    if (!srcId || srcId === dstId) return false;
    const src = byId[srcId];
    const dst = byId[dstId];
    if (!src || !dst) return false;
    if (src.project_id === dst.id) return false;
    let cur = dst;
    const seen = new Set();
    while (cur && cur.project_id && !seen.has(cur.id)) {
      if (cur.project_id === srcId) return false;
      seen.add(cur.id);
      cur = byId[cur.project_id];
    }
    return true;
  };

  // Untriaged rows are excluded: filing something UNDER an item that is still
  // "in" would make an undecided row a project, which is the one thing the
  // clarify step exists to prevent.
  body.querySelectorAll('.map-row:not(.map-row-in)').forEach(row => {
    const id = parseInt(row.dataset.id);
    row.addEventListener('dragstart', e => {
      const t = e.target.tagName;
      if (t === 'INPUT' || t === 'SELECT' || t === 'BUTTON') { e.preventDefault(); return; }
      dragId = id;
      row.classList.add('s2-item-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(id));
    });
    row.addEventListener('dragend', () => {
      dragId = null;
      body.querySelectorAll('.s2-drop-target').forEach(x => x.classList.remove('s2-drop-target'));
      row.classList.remove('s2-item-dragging');
    });
    row.addEventListener('dragover', e => {
      if (!canDrop(dragId, id)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('s2-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('s2-drop-target'));
    row.addEventListener('drop', async e => {
      e.preventDefault();
      row.classList.remove('s2-drop-target');
      const srcId = dragId || parseInt(e.dataTransfer.getData('text/plain'));
      if (!canDrop(srcId, id)) return;
      dragId = null;
      if (byId[srcId]) undoablePatch(byId[srcId], ['project_id', 'area_id', 'domain_id'],
                                     `filed "${byId[srcId].content}"`);
      await patchItem(srcId, { project_id: id });
      await after();
    });
  });

  dragEdgeScroll(body);
  mapSelSync();
}

// ── MAP BY KEYBOARD (2026-09-23, Quentin's instruction) ───────
//
// One row is always SELECTED — the first when MAP opens — and single keys act
// on it: ↑↓ move, 1/2/3 priority, d due, s show-on, t then an arrow for the
// estimate, m multitask, l a location, r renames, p parks it in someday /
// maybe or brings it back, Enter clarifies, ⌫ deletes. The selection is view
// state held by ID, so the re-render after a write keeps the row you were on.
// Every write registers its inverse first, like any other button.
//
// Only while MAP is the top layer: a sheet, menu or Settings over it owns the
// keys, and a focused field keeps its typing.

function mapRows() {
  return [...document.querySelectorAll('#map-body .map-row[data-id]')];
}

// Marks the selected row, falling back to the first when the one held is not
// on screen (MAP just opened, or a filter took it away).
function mapSelSync() {
  const rows = mapRows();
  let row = rows.find(r => r.dataset.id === String(mapView.sel));
  if (!row) {
    row = rows[0];
    mapView.sel = row ? parseInt(row.dataset.id) : null;
  }
  rows.forEach(r => {
    r.classList.toggle('map-row-sel', r === row);
    r.classList.toggle('map-row-tmode', r === row && mapView.tMode);
    r.classList.toggle('map-row-delarm', r === row && mapView.delArm === mapView.sel);
  });
  return row;
}

function mapSelItem() {
  const id = mapView.sel;
  return (state.mapItems || []).find(i => i.id === id)
    || (state.inbox || []).find(i => i.id === id) || null;
}

function mapMoveSel(step) {
  const rows = mapRows();
  if (!rows.length) return;
  const at = rows.findIndex(r => r.dataset.id === String(mapView.sel));
  const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
  mapView.sel = parseInt(next.dataset.id);
  mapSelSync();
  next.scrollIntoView({ block: 'nearest' });
}

function mapKeysLive() {
  const ov = document.getElementById('map-overlay');
  const settings = document.getElementById('modal-overlay');
  return !!ov && !ov.classList.contains('hidden')
    && !(settings && !settings.classList.contains('hidden'))
    && !clarifyView.open && !entrySheet.open && !seSheet.kind && !objMenu.open
    && !mapView.menuOpen && !occasionView.open && !ctxSheet.tag
    && mapView.horizon === 'projects' && !hzView.menuOpen;
}

async function mapAfterWrite() {
  await refreshMap();
  await refreshActiveItems();
}

async function mapSetTags(item, tags, label) {
  undoablePatch(item, ['tags'], label);
  await patchInboxItem(item.id, { tags: tags.join(' ') });
  await mapAfterWrite();
}

// A tag out of a set that is exclusive here (priority, estimate): the same key
// again takes it off, another key swaps it. `drop` says which tags the set
// holds, so the estimate can also clear the retired 30m/90m.
function mapToggleIn(item, tag, drop, what) {
  const own = ownTags(item);
  const had = own.includes(tag);
  const rest = own.filter(t => !drop(t));
  return mapSetTags(item, had ? rest : [...rest, tag],
    `${had ? 'cleared' : 'set'} ${what} ${tag} on "${item.content}"`);
}

const MAP_EST_KEYS = { ArrowLeft: '5m', ArrowUp: '15m', ArrowRight: '45m', ArrowDown: '2h' };

function mapPromptDue(item) {
  openEntrySheet({
    title: `Due — ${item.content}`,
    when: { date: item.deadline || '' },
    save: async ({ date }) => {
      if ((date || null) === (item.deadline || null)) return;
      undoablePatch(item, ['deadline'], `due date on "${item.content}"`);
      await patchInboxItem(item.id, { deadline: date || null });
      await mapAfterWrite();
    },
  });
}

// The show-on date is the clarify sheet's Defer, asked alone: a date defers, a
// time ALSO schedules it into that day (the placement replaces any earlier
// one, as clarify's does). A date alone leaves placements alone — deferring is
// about the pool, a placement about a day already planned.
async function mapPromptShow(item) {
  const snap = await snapshotItem(item.id);
  const prevPlaces = (snap && snap.placements) || [];
  const onDay = prevPlaces.find(p => p.date === item.defer_until);
  openEntrySheet({
    title: `Show on — ${item.content}`,
    when: { date: item.defer_until || '', minute: onDay ? onDay.minute : null, withTime: true },
    save: async ({ date, minute }) => {
      const prevDefer = item.defer_until || null;
      const placing = !!date && minute != null;
      pushUndo(`show-on date for "${item.content}"`, async () => {
        await patchInboxItem(item.id, { defer_until: prevDefer });
        if (placing) {
          await apiSend(`/api/engage/placements/${item.id}?date=${date}`, 'DELETE');
          for (const p of prevPlaces) {
            await apiSend('/api/engage/placements', 'POST',
                          { item_id: item.id, date: p.date, minute: p.minute });
          }
        }
        await refreshAfterUndo();
      });
      await patchInboxItem(item.id, { defer_until: date || null });
      stickyRemember('showDate', date || '');
      if (placing) {
        for (const p of prevPlaces) {
          await apiSend(`/api/engage/placements/${item.id}?date=${p.date}`, 'DELETE');
        }
        await apiSend('/api/engage/placements', 'POST', { item_id: item.id, date, minute });
      }
      await mapAfterWrite();
    },
  });
}

// ⌫ deletes the selected row — the clarify sheet's Trash, undoable, and the
// selection steps to the row below (or above, at the end). A PROJECT takes a
// second press, as its Trash does in clarify: deleting one moves its actions
// up a level, which is more than one keystroke should do on its own.
async function mapDeleteSel(item) {
  if (item.kind === 'project' && mapView.delArm !== item.id) {
    mapView.delArm = item.id;
    mapSelSync();
    return;
  }
  mapView.delArm = null;
  const rows = mapRows();
  const at = rows.findIndex(r => r.dataset.id === String(item.id));
  const next = rows[at + 1] || rows[at - 1];
  if (!await undoableDelete(item.id, `deleted "${item.content}"`)) { mapSelSync(); return; }
  mapView.sel = next ? parseInt(next.dataset.id) : null;
  await mapAfterWrite();
}

// A location is a TAG — the thing a place gates by once it is bound to one in
// the context sheet — so the prompt offers the tags already bound to a place
// and mints whatever else you type.
function mapPromptLocation(item) {
  const bound = [...new Set((state.tagLocations || []).map(b => b.tag))].sort();
  openEntrySheet({
    title: `Location — ${item.content}`,
    placeholder: 'Where? e.g. home, office, errands',
    suggest: bound,
    button: 'Add',
    closeOnAdd: true,
    add: async raw => {
      const tag = raw.trim().toLowerCase().replace(/^[#@]/, '')
        .replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
      if (!tag) { toast('A location is letters, numbers and dashes'); return; }
      const own = ownTags(item);
      if (own.includes(tag)) return;
      await mapSetTags(item, [...own, tag], `location ${tag} on "${item.content}"`);
    },
  });
}

document.addEventListener('keydown', e => {
  if (!mapKeysLive()) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
            || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.key === 'Shift') return;
  const item = mapSelItem();
  // A project armed for deletion is disarmed by any key but the second ⌫.
  if (mapView.delArm != null && !(e.key === 'Backspace' || e.key === 'Delete')) {
    mapView.delArm = null;
    mapSelSync();
  }
  // `t` arms the next arrow. Anything else disarms it — Esc only that, so it
  // does not also close MAP (this listener runs before initHub's ladder).
  if (mapView.tMode) {
    mapView.tMode = false;
    mapSelSync();
    const est = MAP_EST_KEYS[e.key];
    if (est && item) {
      e.preventDefault();
      mapToggleIn(item, est, x => EST_TAGS.includes(x) || /^\d+[mh]$/.test(x), 'estimate');
      return;
    }
    if (e.key === 'Escape') { e.stopImmediatePropagation(); return; }
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    mapMoveSel(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (!item) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'Enter') { e.preventDefault(); openClarifyForItem(item, mapAfterWrite); }
  else if (k === '1' || k === '2' || k === '3') {
    mapToggleIn(item, `p${k}`, x => PRIORITY_TAGS.includes(x), 'priority');
  }
  else if (k === 'd') { e.preventDefault(); mapPromptDue(item); }
  else if (k === 's') { e.preventDefault(); mapPromptShow(item); }
  else if (k === 't') { mapView.tMode = true; mapSelSync(); }
  else if (k === 'm') {
    const own = ownTags(item);
    const on = own.includes('multitask');
    mapSetTags(item, on ? own.filter(x => x !== 'multitask') : [...own, 'multitask'],
      `${on ? 'cleared' : 'set'} multitask on "${item.content}"`);
  }
  else if (k === 'l') { e.preventDefault(); mapPromptLocation(item); }
  else if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); mapDeleteSel(item); }
  else if (k === 'p') {
    // Clarify's Someday exit, one key, and its way back: someday → active,
    // anything else (active, waiting, still in the inbox) → someday.
    const parked = item.status === 'on_hold';
    undoablePatch(item, ['status'], `${parked ? 'un-parked' : 'parked'} "${item.content}"`);
    patchInboxItem(item.id, { status: parked ? 'active' : 'on_hold' }).then(mapAfterWrite);
  }
  else if (k === 'r') {
    // The row's own rename (its double-click), not a second editor. The
    // preventDefault is load-bearing: the field takes focus inside this
    // keydown, and the r would otherwise be typed into it.
    e.preventDefault();
    const text = document.querySelector('#map-body .map-row-sel .map-text');
    if (text) text.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }
});

// ── Export — the list as Markdown ────────────────────────────
//
// What MAP is showing under its lens and filters (search is a ranked view,
// not a list, so it is not what gets saved), in the tree's own grouping and
// order via mapSections / mapAreaForest. Saved through saveDownload (the
// Downloads folder) and copied too, since pasting it is often the point.
function mapMarkdown() {
  const todayStr = wallDay();
  const items = mapVisibleItems(state.mapItems || [], todayStr);
  const inbox = mapInboxItems();
  const fmtDay = ymd => new Date(ymd + 'T12:00:00')
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const line = (i, depth) => {
    const bits = [];
    if (i.status === 'waiting') bits.push(`waiting${i.waiting_on ? ` on ${i.waiting_on}` : ''}`);
    const due = dueOf(i);
    if (due) bits.push(`due ${fmtDay(due)}`);
    if (i.defer_until && i.defer_until > todayStr) bits.push(`shows ${fmtDay(i.defer_until)}`);
    const tags = ownTags(i).map(x => `#${x}`).join(' ');
    return `${'  '.repeat(depth)}- ${i.kind === 'project' ? `**${i.content}**` : i.content}${
      bits.length ? ` — ${bits.join(' · ')}` : ''}${tags ? `  ${tags}` : ''}`;
  };
  const forestLines = (areaItems, someday) => {
    const f = mapAreaForest(areaItems, someday, todayStr);
    const out = [];
    const walk = (i, depth) => { out.push(line(i, depth)); f.kids(i).forEach(k => walk(k, depth + 1)); };
    f.roots.forEach(r => walk(r, 0));
    return out;
  };
  const extras = mapFilterExtras();
  const out = [`# MAP — ${fmtDay(todayStr)}`, '',
    `_${mapLens().name}${extras ? ` · ${plural(extras, 'filter')}` : ''} · ${
      plural(items.length + inbox.length, 'item')}_`, ''];
  mapSections(items, inbox).forEach(sec => {
    out.push(`## ${sec.name}${sec.sub ? ` — ${sec.sub}` : ''}`, '');
    if (sec.inbox) { out.push(...sec.items.map(i => line(i, 0)), ''); return; }
    const live = forestLines(sec.items, false);
    const later = forestLines(sec.items, true);
    if (live.length) out.push(...live, '');
    if (later.length) out.push('### Someday / maybe', '', ...later, '');
  });
  return out.join('\n');
}

async function exportMap() {
  const text = mapMarkdown();
  const name = `map-${wallDay()}.md`;
  const copied = await copyText(text);
  const path = await saveDownload(name, text, 'text/markdown');
  toast(`Saved ${path || name} to Downloads${copied ? ' — and copied' : ''}`);
}

// Historical name: the NOW list (section 2) is gone — the engage pool is the
// next-actions lens, so "refresh the active items" means re-render the day.
async function refreshActiveItems() {
  await refreshEngage();
}
// ── Settings → Times, and the Schedule Picker ────────────────
//
// Ported from Claude Design (project 82343144-9c74-405a-8a03-5d1a2c5b82c7,
// files `Times Setting.dc.html` and `Schedule Picker.dc.html`; the model they
// store is `Schedule Model.dc.html`, implemented in schedule.py).
//
// Times is TWO LISTS and no editor: schedules first, because they are what
// people name and reuse, then the rules those schedules are built from. A
// derived schedule is not a third group — it is a schedule marked with what it
// follows. Every row opens the PICKER, so there is no second editor to keep
// consistent with the first.
//
// The picker's own rule: the type is a consequence, never a question. It opens
// as a single rule; the Follows row at the top and Add a variation at the
// bottom are the only two controls that change what gets stored, and nobody is
// ever asked to choose between a rule, a schedule and a derived source.

async function renderSchedules() {
  const el = document.getElementById('be-times-section');
  if (!el) return;
  state.schedules = await fetch(`/api/schedules?date=${egDateStr()}`)
    .then(r => r.json()).catch(() => state.schedules || []);
  const all = state.schedules || [];
  const schedules = all.filter(s => s.kind !== 'rule');
  const rules = all.filter(s => s.kind === 'rule');
  beCounts.times = all.length;

  el.innerHTML = `
    <div class="be-sub-head">Schedules</div>
    <div class="be-list" id="be-sched-list">
      ${schedules.map(s => beRow({
        id: s.uid, name: s.title,
        meta: scheduleReachLine(s),
        badge: s.due ? 'today' : '',
      })).join('')}${beAddRow('New schedule')}
    </div>
    <div class="be-sub-head">Rules</div>
    <div class="be-list" id="be-rule-list">
      ${rules.map(s => beRow({
        id: s.uid, name: s.title,
        meta: scheduleReachLine(s),
        badge: s.due ? 'today' : '',
      })).join('')}${beAddRow('New rule')}
    </div>`;

  wireScheduleList(document.getElementById('be-sched-list'), all, 'schedule');
  wireScheduleList(document.getElementById('be-rule-list'), all, 'rule');
}

// Each row states its REACH — every holder counted, including the gates that
// follow it. An unused entry says so plainly rather than hiding, which is how
// the list stays cleanable.
function scheduleReachLine(s) {
  const bits = [];
  if (s.kind === 'derived') {
    // After un-sharing, a derived source follows an UNNAMED copy of the hours
    // it used to share. Say that, rather than "something": nothing is missing,
    // the name is.
    const target = (state.schedules || []).find(x => x.uid === (s.follows || {}).source);
    bits.push(`Follows ${(target || {}).title || 'its own unnamed hours'}`);
  } else if (s.kind === 'schedule') {
    bits.push(plural((s.entries || []).length, 'rule'));
  } else {
    bits.push(s.label || '');
  }
  const reach = s.reach || { total: 0, in_schedules: [], followed_by: [], holders: [] };
  const held = [];
  if (s.kind === 'rule' && reach.in_schedules.length) {
    held.push('In ' + reach.in_schedules.map(x => x.title).join(', '));
  }
  if (reach.followed_by.length) {
    held.push(`${plural(reach.followed_by.length, 'schedule')} follow${
      reach.followed_by.length === 1 ? 's' : ''} it`);
  }
  reach.holders.forEach(h => held.push(`#${h.name}`));
  bits.push(held.length ? held.join(' · ') : 'unused');
  return bits.filter(Boolean).join(' · ');
}

function wireScheduleList(el, all, kind) {
  if (!el) return;
  el.querySelectorAll('[data-row]').forEach(btn => {
    const src = all.find(s => s.uid === btn.dataset.row);
    if (src) btn.addEventListener('click', () => openPicker({ source: src }));
  });
  const add = el.querySelector('[data-add]');
  // wantName, for BOTH lists. Settings → Times shows NAMED sources only — the
  // unnamed ones are the private windows gates and routines hold, and listing
  // those would fill this screen with a row per gate. So a rule saved from here
  // without a title was created and then invisible, which read as "I can't add
  // times". It cannot be blank now, and it cannot dead-end either: savePicker
  // fills an empty name in from the sentence.
  if (add) add.addEventListener('click', () => openPicker({
    wantSchedule: kind === 'schedule', wantName: true }));
}

// ── The picker ───────────────────────────────────────────────
//
// One draft holds all three shapes at once, which is what makes both branches
// reversible: choosing a target leaves the pattern rows' values alone, and
// removing the second variation returns the draft to a single rule.

const DURATIONS = [
  ['PT5M', '5 min'], ['PT10M', '10 min'], ['PT15M', '15 min'], ['PT20M', '20 min'],
  ['PT30M', '30 min'], ['PT45M', '45 min'],
  ['PT1H', '1 hr'], ['PT1H30M', '1 hr 30'], ['PT2H', '2 hr'], ['PT2H30M', '2 hr 30'],
  ['PT3H', '3 hr'], ['PT3H30M', '3 hr 30'], ['PT4H', '4 hr'], ['PT5H', '5 hr'],
  ['PT6H', '6 hr'], ['PT8H', '8 hr'], ['PT10H', '10 hr'], ['PT12H', '12 hr'],
  ['P1D', 'all day'], ['', 'no duration'],
];
const FREQS = [['daily', 'day'], ['weekly', 'week'], ['monthly', 'month'], ['yearly', 'year']];
const MONTH_MODES = [['date', 'a day of the month'], ['nth', 'an nth weekday']];
const NTHS = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [-1, 'last']];
// relativeTo + offset as ONE control, the way the design states it.
// Both lists were too short to describe things the app already stores — a
// gate's 10-hour window could be READ but never PICKED, so opening the picker
// on one and pressing Done silently shortened it (see spOptionsWith).
const OPENS = [
  ['-PT8H|start', '8 hr before it starts'], ['-PT6H|start', '6 hr before it starts'],
  ['-PT4H|start', '4 hr before it starts'], ['-PT3H|start', '3 hr before it starts'],
  ['-PT2H|start', '2 hr before it starts'], ['-PT1H30M|start', '1 hr 30 before it starts'],
  ['-PT1H|start', '1 hr before it starts'], ['-PT45M|start', '45 min before it starts'],
  ['-PT30M|start', '30 min before it starts'], ['-PT15M|start', '15 min before it starts'],
  ['PT0S|start', 'when it starts'],
  ['PT0S|end', 'when it ends'], ['PT15M|end', '15 min after it ends'],
  ['PT30M|end', '30 min after it ends'], ['PT45M|end', '45 min after it ends'],
  ['PT1H|end', '1 hr after it ends'], ['PT1H30M|end', '1 hr 30 after it ends'],
  ['PT2H|end', '2 hr after it ends'], ['PT3H|end', '3 hr after it ends'],
  ['PT4H|end', '4 hr after it ends'], ['PT6H|end', '6 hr after it ends'],
];
const EXTENTS = [
  ['until-source-start', 'until it starts'], ['until-source-end', 'until it ends'],
  ['same-as-source', 'as long as it runs'],
  ['PT15M', 'for 15 min'], ['PT30M', 'for 30 min'], ['PT45M', 'for 45 min'],
  ['PT1H', 'for 1 hr'], ['PT1H30M', 'for 1 hr 30'], ['PT2H', 'for 2 hr'],
  ['PT3H', 'for 3 hr'], ['PT4H', 'for 4 hr'], ['PT5H', 'for 5 hr'],
  ['PT6H', 'for 6 hr'], ['PT8H', 'for 8 hr'], ['PT10H', 'for 10 hr'],
  ['PT12H', 'for 12 hr'], ['PT16H', 'for 16 hr'], ['P1D', 'for 24 hr'],
];
const ONLY_ON = [
  ['', 'every day it runs'], ['mo,tu,we,th,fr', 'weekdays only'], ['sa,su', 'weekends only'],
];
// An ISO duration in words, for any value — not just the presets. A source that
// arrived from somewhere else (a gate's 10-hour window, a hand-written rule) has
// to be shown as it is and, more importantly, has to survive being saved
// unchanged: an unlisted value must appear in its own dropdown or Done would
// quietly replace it with the first option.
function isoHuman(iso) {
  if (!iso) return 'no duration';
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return iso;
  const [, d, h, min] = m.map(x => (x ? Number(x) : 0));
  if (d && !h && !min) return `${d} day${d === 1 ? '' : 's'}`;
  const bits = [];
  if (d) bits.push(`${d}d`);
  if (h) bits.push(`${h} hr`);
  if (min) bits.push(h ? String(min) : `${min} min`);
  return bits.join(' ') || '0 min';
}

function durationOptions(current) {
  const opts = DURATIONS.map(([v, l]) => [v, v ? `for ${l}` : l]);
  if (current && !DURATIONS.some(([v]) => v === current)) {
    opts.unshift([current, `for ${isoHuman(current)}`]);
  }
  return opts;
}

// The same protection every OTHER spSelect needs and did not have. A <select>
// whose value is not among its options selects NOTHING, so the browser shows
// the first one — and Done then writes that back. Opening the picker on a
// source built elsewhere (a gate's window, a hand-written rule) and pressing
// Done silently rewrote it. Widening the lists shrinks the odds; this removes
// them. The stored value always appears, named as itself.
function spOptionsWith(options, value, label) {
  if (value == null || value === '') return options;
  if (options.some(([v]) => String(v) === String(value))) return options;
  return [[value, label(value)], ...options];
}

// `offset|relativeTo`, e.g. '-PT90M|start' -> '1 hr 30 before it starts'.
function opensLabel(value) {
  const [offset, rel] = String(value).split('|');
  const anchor = rel === 'end' ? 'it ends' : 'it starts';
  if (!offset || offset === 'PT0S') return `when ${anchor}`;
  const neg = offset.startsWith('-');
  return `${isoHuman(offset.replace(/^-/, ''))} ${neg ? 'before' : 'after'} ${anchor}`;
}

function extentLabel(value) {
  return /^P/.test(String(value)) ? `for ${isoHuman(value)}` : String(value);
}

// A schedule source names its days as JSCalendar NDay tokens ('mo'…'su'):
// WEEKDAYS' `nday`, read back to its row's order and name here.
const SP_DAYS = WEEKDAYS.map(w => w.nday);
const spDayName = d => (WEEKDAYS[SP_DAYS.indexOf(d)] || {}).name;
const DAY_PRESETS = [
  ['mo,tu,we,th,fr', 'Mon – Fri'], ['sa,su', 'Weekends'],
  ['mo,tu,we,th,fr,sa,su', 'Every day'],
];

const pickerView = { open: false, uid: null, draft: null, error: null, dayMenu: null };

function blankRule() {
  return {
    uid: null, frequency: 'weekly', interval: 1,
    days: [weekdayOf(new Date()).nday],
    monthMode: 'date', monthDay: new Date().getDate(), nth: 1, nthDay: 'mo',
    skip: 'omit', firstDayOfWeek: 'mo',
    at: '09:00', duration: 'PT1H',
    anchor: wallDay(),
  };
}

// An existing source read back into the draft. A schedule's members are read
// too, because the picker edits the whole set on one surface.
function draftFromSource(src) {
  const byUid = uid => (state.schedules || []).find(s => s.uid === uid)
    || (state.allSources || []).find(s => s.uid === uid);
  const readRule = s => {
    const r = (s.recurrenceRules || [])[0] || {};
    const at = (s.start || '').slice(11, 16) || '09:00';
    const days = (r.byDay || []).filter(d => !d.nthOfPeriod).map(d => d.day);
    const nthEntry = (r.byDay || []).find(d => d.nthOfPeriod);
    return {
      uid: s.uid,
      frequency: r.frequency || 'weekly',
      interval: r.interval || 1,
      days: days.length ? days : [SP_DAYS[0]],
      monthMode: nthEntry ? 'nth' : 'date',
      monthDay: (r.byMonthDay || [])[0] || 1,
      nth: nthEntry ? nthEntry.nthOfPeriod : 1,
      nthDay: nthEntry ? nthEntry.day : 'mo',
      skip: r.skip || 'omit',
      firstDayOfWeek: r.firstDayOfWeek || 'mo',
      at,
      duration: s.duration || '',
      anchor: (s.start || '').slice(0, 10) || wallDay(),
    };
  };
  const members = src.kind === 'schedule'
    ? (src.entries || []).map(byUid).filter(Boolean).map(readRule)
    : [];
  return {
    title: src.title || '',
    follows: src.kind === 'derived' ? { ...(src.follows || {}) } : null,
    lastFollows: null,
    rules: src.kind === 'schedule'
      ? (members.length ? members : [blankRule()])
      : [readRule(src)],
    removed: [],
    ends: src.ends || null,
    reach: src.reach || null,
  };
}

async function openPicker(opts) {
  // A consumer (a gate, and later a block or a task) opens this with the uid it
  // holds and a callback, rather than from a Times row. `noFollows` withholds
  // the derived branch: a commitment must not inherit its hours from something
  // editable without the 24h delay, and a skip propagating from upstream would
  // silently stop a gate opening (see CLAUDE.md, "Gates hold a schedule").
  // The picker's own menus need every source, unnamed ones included: a
  // schedule's members are unnamed once they were created by a variation.
  state.allSources = await fetch('/api/schedules?unnamed=1')
    .then(r => r.json()).catch(() => []);
  const src = opts.source
    || (opts.sourceUid ? (state.allSources || []).find(x => x.uid === opts.sourceUid) : null);
  pickerView.open = true;
  pickerView.noFollows = !!opts.noFollows;
  pickerView.onSaved = opts.onSaved || null;
  pickerView.uid = src ? src.uid : null;
  pickerView.error = null;
  pickerView.dayMenu = null;
  pickerView.draft = src ? draftFromSource(src) : {
    title: '', follows: null, lastFollows: null,
    rules: [blankRule()], removed: [], ends: null, reach: null,
  };
  // "+ New schedule" opens with the name field already showing, because the
  // thing being made is the named set rather than one pattern.
  pickerView.wantName = !opts.onSaved
    && (!!opts.wantName || !!opts.wantSchedule
        || !!(src && (src.kind !== 'rule' || src.title)));
  showSheet('sp-sheet');
  renderPicker();
}

function closePicker() {
  pickerView.open = false;
  pickerView.draft = null;
  hideSheet('sp-sheet');
}

// THE INNERMOST RUNG. The picker opens OVER the sheet that asked for a
// schedule, and it had no rung and no tap-off until it was defined here: Esc
// reached past it and closed the settings sheet it was standing on, leaving
// the picker floating over nothing.
defineSheet('sp-sheet', { rank: -10, isOpen: () => pickerView.open, close: closePicker });

function pickerKind() {
  const d = pickerView.draft;
  if (d.follows) return 'derived';
  return d.rules.length > 1 ? 'schedule' : 'rule';
}

function spSelect(key, options, value, extra) {
  return `<select class="sp-input" data-sp="${key}"${extra || ''}>${options.map(([v, label]) =>
    `<option value="${escHtml(String(v))}"${String(v) === String(value) ? ' selected' : ''}>${
      escHtml(label)}</option>`).join('')}</select>`;
}

function dayLabel(days) {
  const preset = DAY_PRESETS.find(([v]) => v === days.slice().sort(
    (a, b) => SP_DAYS.indexOf(a) - SP_DAYS.indexOf(b)).join(','));
  if (preset) return preset[1];
  if (!days.length) return 'no days chosen';
  return days.slice().sort((a, b) => SP_DAYS.indexOf(a) - SP_DAYS.indexOf(b))
    .map(spDayName).join(', ');
}

// The days control is a dropdown like every other input here, not a key grid:
// one question at a time, and the sentence at the foot is the feedback.
function dayControl(idx, days) {
  const open = pickerView.dayMenu === idx;
  return `<button type="button" class="sp-input sp-drop${days.length ? '' : ' sp-bad'}"
      data-sp="daymenu" data-idx="${idx}">
      <span>${escHtml(dayLabel(days))}</span><span class="sp-caret">▾</span></button>
    ${open ? `<div class="sp-menu" data-idx="${idx}">
      ${/* The Mon–Fri / Weekends / Every day shortcuts were removed 2026-08-12:
            seven toggles already say all three, and a preset that silently
            replaced a selection was the only control here that discarded work.
            DAY_PRESETS still NAMES those sets for the collapsed button. */''}
      ${SP_DAYS.map(d => `<button type="button" class="sp-menu-row${
        days.includes(d) ? ' sp-on' : ''}" data-day="${d}">
        <span>${spDayName(d)}</span>${days.includes(d) ? '<span>✓</span>' : ''}</button>`).join('')}
    </div>` : ''}`;
}

function patternRows(rule, idx, compact) {
  const rows = [];
  const label = text => `<span class="sp-label">${text}</span>`;
  if (!compact) {
    rows.push(`<div class="sp-row">${label('Every')}
      <input class="sp-input sp-num" type="number" min="1" data-sp="interval" data-idx="${idx}"
        value="${rule.interval}">
      ${spSelect('frequency', FREQS, rule.frequency, ` data-idx="${idx}"`)}</div>`);
  }
  if (rule.frequency === 'weekly' || rule.frequency === 'daily' && false) {
    rows.push(`<div class="sp-row">${label('On')}${dayControl(idx, rule.days)}</div>`);
  }
  if (rule.frequency === 'monthly' || rule.frequency === 'yearly') {
    rows.push(`<div class="sp-row">${label('On')}${
      spSelect('monthMode', MONTH_MODES, rule.monthMode, ` data-idx="${idx}"`)}</div>`);
    if (rule.monthMode === 'date') {
      rows.push(`<div class="sp-row">${label('Day')}
        <input class="sp-input sp-num" type="number" min="1" max="31" data-sp="monthDay"
          data-idx="${idx}" value="${rule.monthDay}"></div>`);
      // Shown only for a date some months lack — a row that cannot apply is
      // absent, never greyed out.
      if (Number(rule.monthDay) > 28) {
        rows.push(`<div class="sp-row">${label('Short months')}${spSelect('skip', [
          ['backward', 'use the last day'], ['omit', 'skip the month'],
        ], rule.skip, ` data-idx="${idx}"`)}</div>`);
      }
    } else {
      rows.push(`<div class="sp-row">${label('The')}
        ${spSelect('nth', NTHS, rule.nth, ` data-idx="${idx}"`)}
        ${spSelect('nthDay', WEEKDAYS.map(w => [w.nday, w.name]), rule.nthDay, ` data-idx="${idx}"`)}
      </div>`);
    }
  }
  // Week start only matters above interval 1, which is the only time it shows.
  if (!compact && rule.frequency === 'weekly' && Number(rule.interval) > 1) {
    rows.push(`<div class="sp-row">${label('Week starts')}${
      spSelect('firstDayOfWeek', WEEKDAYS.map(w => [w.nday, w.name]),
        rule.firstDayOfWeek, ` data-idx="${idx}"`)}</div>`);
  }
  rows.push(`<div class="sp-row">${label('At')}
    <input class="sp-input sp-time" type="time" data-sp="at" data-idx="${idx}" value="${rule.at}">
    ${spSelect('duration', durationOptions(rule.duration),
      rule.duration, ` data-idx="${idx}"`)}</div>`);
  return rows.join('');
}

function renderPicker() {
  const d = pickerView.draft;
  const kind = pickerKind();
  const el = document.getElementById('sp-sheet');
  let body = '';

  // The Follows row is the first of the two branch controls, and it stays at the
  // top whatever the draft currently is — unless the caller withheld it.
  if (!pickerView.noFollows) {
    body += `<div class="sp-row"><span class="sp-label">Follows</span>${
      spSelect('follows', followOptions(), (d.follows || {}).source || '')}</div>`;
  }
  if (pickerView.wantName || d.rules.length > 1) {
    body += `<div class="sp-row"><span class="sp-label">Name</span>
      <input class="sp-input" data-sp="title" value="${escHtml(d.title)}"
        placeholder="e.g. Weekday mornings" autocomplete="off"></div>`;
  }
  body += '<div class="sp-rule"></div>';

  if (kind === 'derived') {
    const f = d.follows;
    const target = (state.allSources || []).find(s => s.uid === f.source);
    const opensVal = `${f.offset || 'PT0S'}|${f.relativeTo || 'start'}`;
    const extentVal = f.extent || 'until-source-start';
    body += `<div class="sp-row"><span class="sp-label">Opens</span>${
      spSelect('opens', spOptionsWith(OPENS, opensVal, opensLabel), opensVal)}</div>`;
    body += `<div class="sp-row"><span class="sp-label">Stays open</span>${
      spSelect('extent', spOptionsWith(EXTENTS, extentVal, extentLabel), extentVal)}</div>`;
    body += `<div class="sp-row"><span class="sp-label">Only on</span>${
      spSelect('only', ONLY_ON, ((f.only || {}).byDay || []).join(','))}</div>`;
    body += '<div class="sp-rule"></div>';
    // Ends is inherited, so it is STATED rather than asked.
    body += `<div class="sp-stated"><span class="sp-label">Ends</span>
      <span>When ${escHtml((target || {}).title || 'it')} ends. Skipped days are skipped
      here too.</span></div>`;
  } else {
    if (d.rules.length === 1) {
      body += patternRows(d.rules[0], 0, false);
      body += `<button type="button" class="sp-add" data-sp="variation">+ Add a variation</button>`;
      body += '<div class="sp-rule"></div>';
      body += endsRadios(d.ends);
    } else {
      // The rows group into numbered rules, each owning its time and duration —
      // which is the whole reason a set of rules exists.
      d.rules.forEach((rule, i) => {
        body += `<div class="sp-card">
          <div class="sp-card-head"><span class="sp-card-title">Rule ${i + 1}</span>
            <button type="button" class="sp-x" data-sp="drop" data-idx="${i}">✕</button></div>
          ${patternRows(rule, i, true)}
          ${rule.note ? `<span class="sp-note">${escHtml(rule.note)}</span>` : ''}
        </div>`;
      });
      body += `<button type="button" class="sp-add" data-sp="variation">+ Add a variation</button>`;
      body += '<div class="sp-rule"></div>';
      body += `<div class="sp-row"><span class="sp-label">Ends</span>${spSelect('endsKind', [
        ['never', 'never'], ['date', 'on a date'], ['count', 'after N times'],
      ], d.ends ? (d.ends.date ? 'date' : 'count') : 'never')}
        <span class="sp-aside">whole set</span></div>`;
      body += endsDetail(d.ends);
    }
  }

  const shared = d.reach && d.reach.total
    ? `<div class="sp-shared">${escHtml(sharedLine(d.reach))}</div>` : '';

  el.innerHTML = `
    <div class="se-grab"><span></span></div>
    <div class="se-head"><span class="se-title">Repeats</span>
      <button class="sp-cancel">Cancel</button></div>
    <div class="sp-body">${body}</div>
    <div class="sp-foot">
      <div class="sp-sentence">${escHtml(describeDraft())}</div>
      ${shared}
      ${pickerView.error ? `<div class="se-error">${escHtml(pickerView.error)}</div>` : ''}
      <div class="sp-actions">
        ${pickerView.uid ? `<button class="sp-del">Delete</button>` : '<span class="sp-grow"></span>'}
        <span class="sp-grow"></span>
        <button class="sp-cancel2">Cancel</button>
        <button class="sp-done">Done</button>
      </div>
    </div>`;
  wirePicker();
}

function sharedLine(reach) {
  const names = []
    .concat(reach.in_schedules.map(s => `${s.title} (schedule)`))
    .concat(reach.followed_by.map(s => `${s.title} (follows it)`))
    .concat(reach.holders.map(h => `#${h.name} (${h.kind})`));
  if (!names.length) return '';
  return `${plural(names.length, 'thing')} use${names.length === 1 ? 's' : ''} this: `
    + names.join(', ') + '. Saving changes it for all of them.';
}

function endsRadios(ends) {
  const which = !ends ? 'never' : (ends.date ? 'date' : 'count');
  const radio = on => `<span class="sp-radio${on ? ' sp-on' : ''}"></span>`;
  return `<div class="sp-ends"><span class="sp-label">Ends</span>
    <button type="button" class="sp-ends-row" data-sp="ends" data-value="never">
      ${radio(which === 'never')}<span>Never</span></button>
    <button type="button" class="sp-ends-row" data-sp="ends" data-value="date">
      ${radio(which === 'date')}<span class="sp-ends-word">On</span>
      <input class="sp-input sp-date" type="date" data-sp="endsDate"
        value="${escHtml((ends || {}).date || '')}"></button>
    <button type="button" class="sp-ends-row" data-sp="ends" data-value="count">
      ${radio(which === 'count')}<span class="sp-ends-word">After</span>
      <input class="sp-input sp-num" type="number" min="1" data-sp="endsCount"
        value="${escHtml(String((ends || {}).count || ''))}" placeholder="13">
      <span class="sp-aside">times</span></button>
  </div>`;
}

function endsDetail(ends) {
  if (!ends) return '';
  if (ends.date !== undefined && ends.date !== null) {
    return `<div class="sp-row"><span class="sp-label">On</span>
      <input class="sp-input sp-date" type="date" data-sp="endsDate"
        value="${escHtml(ends.date || '')}"></div>`;
  }
  return `<div class="sp-row"><span class="sp-label">After</span>
    <input class="sp-input sp-num" type="number" min="1" data-sp="endsCount"
      value="${escHtml(String(ends.count || ''))}"><span class="sp-aside">times</span></div>`;
}

// Follows lists anything with occurrences. Blocks and gates join it when they
// hold a source rather than their own fields — see CLAUDE.md's migration list.
function followOptions() {
  const opts = [['', 'nothing — set a pattern']];
  // A GATE's hours are followable (2026-08-12) even though its source is
  // unnamed: "due 30 min before the work scan closes" is the thing you actually
  // want to say, and the alternative — naming every gate's window in Settings →
  // Times just to reference it — would fill that list with one row per gate.
  // Offered under the gate's own name. The reverse direction stays refused:
  // openPicker's `noFollows` is what keeps a gate from inheriting hours that
  // could move without the 24h delay.
  (state.accountabilityNodes || []).forEach(n => {
    if (n.active && n.source_uid && n.source_uid !== pickerView.uid) {
      opts.push([n.source_uid, `${n.label} (gate)`]);
    }
  });
  const named = (state.allSources || []).filter(s => s.title && s.uid !== pickerView.uid);
  const groups = [['schedule', 'Schedules'], ['derived', 'Schedules'], ['rule', 'Rules']];
  const seen = new Set();
  groups.forEach(([kind]) => {
    named.filter(s => s.kind === kind).forEach(s => {
      if (seen.has(s.uid)) return;
      seen.add(s.uid);
      opts.push([s.uid, s.title]);
    });
  });
  return opts;
}

// The sentence at the foot. Deliberately a CLIENT mirror of schedule.describe:
// it has to answer on every keystroke, and a round trip per change is worse
// than two implementations of one sentence. The stored label always comes from
// the server, so the row in Times cannot disagree with what was saved.
function describeDraft() {
  const d = pickerView.draft;
  if (d.follows) {
    const target = (state.allSources || []).find(s => s.uid === d.follows.source);
    const name = (target || {}).title || 'it';
    const opens = (OPENS.find(([v]) =>
      v === `${d.follows.offset || 'PT0S'}|${d.follows.relativeTo || 'start'}`) || [])[1] || '';
    const extent = (EXTENTS.find(([v]) => v === d.follows.extent) || [])[1] || '';
    return `${name}: ${opens}, ${extent}.`;
  }
  const one = r => {
    const bits = [];
    if (Number(r.interval) > 1) bits.push(`every ${r.interval} ${
      (FREQS.find(([v]) => v === r.frequency) || [])[1]}s`);
    if (r.frequency === 'weekly') bits.push(dayLabel(r.days));
    else if (r.frequency === 'daily' && Number(r.interval) <= 1) bits.push('Every day');
    else if (r.frequency === 'monthly' || r.frequency === 'yearly') {
      bits.push(r.monthMode === 'date' ? `the ${r.monthDay}th`
        : `the ${(NTHS.find(([v]) => String(v) === String(r.nth)) || [])[1]} ${spDayName(r.nthDay)}`);
    }
    bits.push(`at ${r.at}` + (r.duration ? ` for ${isoHuman(r.duration)}` : ''));
    return bits.join(' ');
  };
  let text = one(d.rules[0]);
  if (d.rules.length > 1) text += ', except ' + d.rules.slice(1).map(one).join(', ');
  if (d.ends && d.ends.date) text += `, until ${d.ends.date}`;
  if (d.ends && d.ends.count) text += `, ${d.ends.count} times`;
  return text + '.';
}

function wirePicker() {
  const el = document.getElementById('sp-sheet');
  const d = pickerView.draft;
  const rerender = () => renderPicker();

  el.querySelectorAll('.sp-cancel, .sp-cancel2').forEach(b =>
    b.addEventListener('click', closePicker));
  el.querySelector('.sp-done').addEventListener('click', savePicker);
  const del = el.querySelector('.sp-del');
  if (del) del.addEventListener('click', deleteFromPicker);

  const at = (sel, fn) => el.querySelectorAll(sel).forEach(fn);

  at('[data-sp="follows"]', s => s.addEventListener('change', () => {
    if (s.value) {
      // Keep the pattern rows' values so setting Follows back to nothing
      // restores them — both branches are reversible.
      d.follows = d.lastFollows && d.lastFollows.source === s.value
        ? d.lastFollows
        : { source: s.value, relativeTo: 'start', offset: '-PT1H',
            extent: 'until-source-start' };
    } else {
      d.lastFollows = d.follows;
      d.follows = null;
    }
    rerender();
  }));

  at('[data-sp="opens"]', s => s.addEventListener('change', () => {
    const [offset, relativeTo] = s.value.split('|');
    d.follows.offset = offset;
    d.follows.relativeTo = relativeTo;
    rerender();
  }));
  at('[data-sp="extent"]', s => s.addEventListener('change', () => {
    d.follows.extent = s.value;
    rerender();
  }));
  at('[data-sp="only"]', s => s.addEventListener('change', () => {
    d.follows.only = s.value ? { byDay: s.value.split(',') } : null;
    rerender();
  }));

  at('[data-sp="title"]', i => i.addEventListener('input', () => { d.title = i.value; }));

  // Pattern fields, per rule index.
  ['interval', 'frequency', 'monthMode', 'monthDay', 'nth', 'nthDay', 'skip',
   'firstDayOfWeek', 'at', 'duration'].forEach(key => {
    at(`[data-sp="${key}"]`, input => {
      const evt = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(evt, () => {
        const rule = d.rules[Number(input.dataset.idx) || 0];
        rule[key] = input.value;
        // A field that changes which OTHER rows apply has to repaint; one that
        // only changes the sentence must not, or it would steal focus mid-type.
        if (['frequency', 'monthMode', 'nth', 'nthDay', 'skip', 'duration'].includes(key)
            || (key === 'interval' && rule.frequency === 'weekly')
            || (key === 'monthDay' && (Number(input.value) > 28 || Number(input.value) === 28))) {
          rerender();
        } else {
          paintSentence();
        }
      });
    });
  });

  at('[data-sp="daymenu"]', b => b.addEventListener('click', () => {
    const idx = Number(b.dataset.idx);
    pickerView.dayMenu = pickerView.dayMenu === idx ? null : idx;
    rerender();
  }));
  at('.sp-menu', menu => {
    const idx = Number(menu.dataset.idx);
    menu.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
      const days = d.rules[idx].days;
      const day = b.dataset.day;
      const at2 = days.indexOf(day);
      if (at2 === -1) days.push(day); else days.splice(at2, 1);
      rerender();
    }));
    menu.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
      d.rules[idx].days = b.dataset.preset.split(',');
      pickerView.dayMenu = null;
      rerender();
    }));
  });

  at('[data-sp="variation"]', b => b.addEventListener('click', () => {
    // A variation inherits the first rule's shape and MOVES a day onto it,
    // because "Wednesday is shorter" is the whole reason a set of rules exists.
    // Taking the day off rule 1 is what keeps the two disjoint — but only when
    // rule 1 has a day to spare. A single-day rule gets a free weekday instead,
    // and then nothing was removed from anything, so nothing claims it was.
    const base = d.rules[0];
    const taken = new Set(d.rules.flatMap(r => r.days));
    const moved = base.days.length > 1 ? base.days[base.days.length - 1] : null;
    const day = moved || SP_DAYS.find(x => !taken.has(x)) || 'we';
    if (moved) base.days = base.days.filter(x => x !== moved);
    d.rules.push({ ...blankRule(), ...base, uid: null, days: [day],
      movedDay: moved,
      note: moved ? `${spDayName(day)} was removed from rule 1.` : null });
    pickerView.wantName = true;
    rerender();
  }));

  at('[data-sp="drop"]', b => b.addEventListener('click', () => {
    const idx = Number(b.dataset.idx);
    const [gone] = d.rules.splice(idx, 1);
    if (gone && gone.uid) d.removed.push(gone.uid);
    // Removing the second rule returns a schedule to a rule — and gives back
    // the day the variation took off rule 1, or changing your mind would cost
    // you a Friday you never chose to drop.
    if (gone && gone.movedDay && d.rules[0] && !d.rules[0].days.includes(gone.movedDay)) {
      d.rules[0].days.push(gone.movedDay);
    }
    if (d.rules.length === 1) d.rules[0].note = null;
    rerender();
  }));

  at('[data-sp="ends"]', b => b.addEventListener('click', e => {
    if (e.target.matches('input')) return;      // typing in the row, not choosing it
    const value = b.dataset.value;
    d.ends = value === 'never' ? null
      : value === 'date' ? { date: (d.ends || {}).date || '' }
      : { count: (d.ends || {}).count || 13 };
    rerender();
  }));
  at('[data-sp="endsKind"]', s => s.addEventListener('change', () => {
    d.ends = s.value === 'never' ? null
      : s.value === 'date' ? { date: (d.ends || {}).date || '' } : { count: 13 };
    rerender();
  }));
  at('[data-sp="endsDate"]', i => i.addEventListener('change', () => {
    d.ends = { date: i.value };
    paintSentence();
  }));
  at('[data-sp="endsCount"]', i => i.addEventListener('input', () => {
    d.ends = { count: Number(i.value) || 1 };
    paintSentence();
  }));
}

function paintSentence() {
  const el = document.querySelector('#sp-sheet .sp-sentence');
  if (el) el.textContent = describeDraft();
}

// ── Saving ───────────────────────────────────────────────────
//
// The draft decides the KIND, and the request is whatever that kind needs. A
// rule that gained a variation is PATCHed into a schedule on the same uid, so
// everything already pointing at it keeps pointing at it.

function ruleBody(r) {
  const rule = { '@type': 'RecurrenceRule', frequency: r.frequency };
  if (Number(r.interval) > 1) rule.interval = Number(r.interval);
  if (r.frequency === 'weekly') {
    rule.byDay = r.days.map(day => ({ '@type': 'NDay', day }));
    if (Number(r.interval) > 1) rule.firstDayOfWeek = r.firstDayOfWeek;
  } else if (r.frequency === 'monthly' || r.frequency === 'yearly') {
    if (r.monthMode === 'date') {
      rule.byMonthDay = [Number(r.monthDay)];
      if (Number(r.monthDay) > 28) rule.skip = r.skip;
    } else {
      rule.byDay = [{ '@type': 'NDay', day: r.nthDay, nthOfPeriod: Number(r.nth) }];
    }
  }
  return {
    start: `${r.anchor}T${r.at}:00`,
    duration: r.duration || null,
    recurrenceRules: [rule],
  };
}

async function saveSource(uid, body) {
  const res = uid
    ? await apiSend(`/api/schedules/${uid}`, 'PATCH', body)
    : await apiSend('/api/schedules', 'POST', body);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not save.');
  return data;
}

async function savePicker() {
  const d = pickerView.draft;
  const kind = pickerKind();
  pickerView.error = null;
  // Errors sit on the field and Done waits; nothing is announced elsewhere.
  const bad = d.rules.find(r => r.frequency === 'weekly' && !r.days.length);
  if (!d.follows && bad) {
    pickerView.error = 'Choose at least one day.';
    toast(pickerView.error);   // the sheet's foot may be behind a keyboard
    renderPicker();
    return;
  }
  // A blank name is FILLED IN, never refused (2026-08-12). Requiring one was
  // the only thing that could dead-end Done, and the message sits at the foot of
  // the sheet where a phone keyboard covers it — so Done looked broken rather
  // than declined. The picker can always describe itself, so it names itself.
  const named = (pickerView.wantName || d.rules.length > 1) && !pickerView.onSaved;
  if (named && !d.title.trim()) d.title = describeDraft() || 'Untitled';
  const btn = document.querySelector('#sp-sheet .sp-done');
  if (btn) btn.disabled = true;

  // Opened by a CONSUMER, the picker never edits the source in place: it creates
  // a new one and hands back the uid, so the holder can compare old against new.
  // For a gate that comparison IS the 24h delay — editing its source in place
  // would change its hours immediately and silently skip the loosening test.
  const target = pickerView.onSaved ? null : pickerView.uid;
  let saved = null;
  try {
    if (kind === 'derived') {
      saved = await saveSource(target, {
        kind: 'derived', title: d.title || null, follows: d.follows,
        entries: null, recurrenceRules: null, start: null, duration: null,
        ends: null,
      });
    } else if (kind === 'rule') {
      saved = await saveSource(target, {
        kind: 'rule', title: d.title || null, ...ruleBody(d.rules[0]),
        entries: null, follows: null, ends: d.ends,
      });
    } else {
      // Members first: each keeps its own duration, and an existing member is
      // updated in place so anything pointing at it survives the edit.
      const entries = [];
      for (const r of d.rules) {
        const body = { kind: 'rule', ...ruleBody(r) };
        const keep = pickerView.onSaved ? null : r.uid;
        const member = await saveSource(keep, keep ? body : { ...body, title: null });
        entries.push(member.uid);
      }
      saved = await saveSource(target, {
        kind: 'schedule', title: d.title.trim(), entries, ends: d.ends,
        recurrenceRules: null, start: null, duration: null, follows: null,
      });
    }
    // A member dropped from the set is unnamed and now unreferenced, so it goes
    // with the edit rather than lingering in the Rules list.
    for (const uid of d.removed) {
      if (pickerView.onSaved) break;   // the old set is still what the holder has
      const src = (state.allSources || []).find(s => s.uid === uid);
      if (src && !src.title) await apiSend(`/api/schedules/${uid}`, 'DELETE');
    }
  } catch (e) {
    pickerView.error = e.message;
    toast(e.message);
    renderPicker();
    return;
  }
  // Opened by a consumer: hand it the source and let it decide what to write.
  // Times is not repainted, because this was never a Times row.
  if (pickerView.onSaved) {
    const done = pickerView.onSaved;
    closePicker();
    await done(saved.uid, saved);
    return;
  }
  closePicker();
  await renderSchedules();
  renderSettingsIndex();
}

async function deleteFromPicker() {
  const d = pickerView.draft;
  const reach = d.reach || { total: 0 };
  // Deleting is ALWAYS allowed: nothing loses its hours, because each holder
  // keeps an unnamed copy of what it had. Deleting a name is only un-sharing.
  const detail = reach.total
    ? `\n\n${sharedLine(reach)}\nEach keeps these hours as its own, unnamed — they simply`
      + ' stop changing together.'
    : '';
  if (!confirm(`Delete "${d.title || 'this schedule'}"?${detail}`)) return;
  await apiSend(`/api/schedules/${pickerView.uid}`, 'DELETE');
  closePicker();
  await renderSchedules();
  renderSettingsIndex();
}

// ── Context tag configuration ────────────────────────────────
//
// Right-click / long-press a TAG chip in the ctx picker and this sheet opens:
// the three axes a tag can be gated by, in one place. It replaced a popover
// that could only bind a location, which meant the other two axes had no home
// at all (device was hardcoded to the literal tags `pc`/`phone`).
//
// All three GATE THE POOL and nothing else — the day's fixed points are
// commitments. Each is evaluated client-side, because "am I there / on that /
// in that window now" is a question only this device can answer; the server
// stores the binding and, for time, answers the DAY half with recurrence.py.
const ctxSheet = { tag: null };

function openCtxSheet(tag) {
  ctxSheet.tag = tag;
  renderCtxSheet();
}

function closeCtxSheet() {
  ctxSheet.tag = null;
  hideSheet('ctx-sheet');
}

defineSheet('ctx-sheet', { rank: 50, isOpen: () => !!ctxSheet.tag, close: closeCtxSheet });

async function ctxSheetRefresh() {
  const [devs, times, sources, daily] = await Promise.all([
    apiGet('/api/tag-devices', state.tagDevices),
    apiGet('/api/tag-times', state.tagTimes),
    apiGet(`/api/schedules?date=${egDateStr()}&unnamed=1`, state.schedules),
    apiGet('/api/tag-daily', state.tagDaily),
  ]);
  state.tagDevices = devs;
  state.tagTimes = times;
  state.schedules = sources;
  if (daily && Array.isArray(daily.tags)) state.tagDaily = daily;
  renderCtxSheet();
  renderEngage();
}

function renderCtxSheet() {
  const sheet = document.getElementById('ctx-sheet');
  if (!sheet) return;
  const tag = ctxSheet.tag;
  if (!tag) { closeCtxSheet(); return; }
  showSheet('ctx-sheet');

  const boundDev = (state.tagDevices || []).find(b => b.tag === tag);
  const dev = boundDev ? boundDev.device : (DEVICE_TAGS.includes(tag) ? tag : null);
  const implicit = !boundDev && DEVICE_TAGS.includes(tag);
  const boundLoc = (state.tagLocations || []).find(b => b.tag === tag);
  const boundTime = (state.tagTimes || []).find(b => b.tag === tag);
  const dailyOn = ((state.tagDaily || {}).tags || []).includes(tag);
  const todayAns = ((state.tagDaily || {}).answers || {})[tag];

  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">context</span>
      <span class="ctx-sheet-tag">${escHtml(tag)}</span>
      <span class="cl-spacer"></span>
      <button class="modal-close-btn" id="ctx-sheet-close">✕</button>
    </div>
    <div class="cl-item">
      <div class="cl-captured">Items carrying this tag are only available when every
        binding below is satisfied. Unbound axes never hide anything.</div>
    </div>

    <div class="cl-sec"><span class="cl-label">▭ Device</span>
      ${implicit ? '<span class="cl-hint">implied by the tag name</span>' : ''}</div>
    <div class="cl-chips">
      ${['pc', 'phone'].map(d => `<button class="chip chip-sm${dev === d ? ' on' : ''}"
        data-dev="${d}">${d}</button>`).join('')}
      ${boundDev ? '<button class="chip chip-sm" data-dev="none">✕ any device</button>' : ''}
    </div>

    <div class="cl-sec"><span class="cl-label">⌖ Location</span>
      <span class="cl-hint">${state.geo.ok ? 'located' : 'no fix — nothing is hidden'}</span></div>
    <div class="cl-chips">
      ${(state.locations || []).filter(l => l.active !== 0
        || (boundLoc && boundLoc.location_id === l.id)).map(l => `<button class="chip chip-sm${
        boundLoc && boundLoc.location_id === l.id ? ' on' : ''}"
        data-loc="${l.id}">${escHtml(l.name)}</button>`).join('')
        || '<span class="cl-hint">no presets — add one in Settings → Locations</span>'}
      ${boundLoc ? '<button class="chip chip-sm" data-loc="none">✕ anywhere</button>' : ''}
    </div>

    <div class="cl-sec"><span class="cl-label">◷ Time</span></div>
    <div class="cl-chips">
      ${(state.schedules || [])
        .filter(p => p.title || (boundTime && boundTime.source_uid === p.uid))
        .map(p => `<button class="chip chip-sm${
        boundTime && boundTime.source_uid === p.uid ? ' on' : ''}"
        data-time="${p.uid}" title="${escHtml(p.label || '')}">${
        escHtml(p.title || 'its own hours')}</button>`).join('')
        || '<span class="cl-hint">no schedules — add one in Settings → Times</span>'}
      ${boundTime ? '<button class="chip chip-sm" data-time="none">✕ any time</button>' : ''}
    </div>
    ${boundTime ? (() => {
      const p = (state.schedules || []).find(x => x.uid === boundTime.source_uid);
      if (!p) return '';
      return `<div class="cl-row"><span class="cl-hint ${p.due ? 'ctx-live' : 'ctx-dead'}">${
        escHtml(p.label || '')} — ${p.due ? 'runs today' : 'not today'}</span></div>`;
    })() : ''}

    ${/* The fourth axis, and the only one answered by HAND each day: whether a
          context applies at all today. It is here because binding a tag belongs
          on one surface, not four. */''}
    <div class="cl-sec"><span class="cl-label">👤 Ask each day</span>
      <span class="cl-hint">${dailyOn ? (todayAns === false ? 'not today'
        : todayAns === true ? 'applies today' : 'unanswered — nothing hidden') : 'never asked'}</span></div>
    <div class="cl-chips">
      <button class="chip chip-sm${dailyOn ? ' on' : ''}" data-daily="on"
        title="The morning routine's contexts step will ask about this tag">ask</button>
      ${dailyOn ? '<button class="chip chip-sm" data-daily="off">✕ stop asking</button>' : ''}
    </div>

    <div class="cl-row">
      <button class="cl-pill cl-pill-on" id="ctx-sheet-done">Done</button>
    </div>`;

  sheet.querySelectorAll('[data-daily]').forEach(b => b.addEventListener('click', async () => {
    await apiSend('/api/tag-daily', 'POST', { tag, on: b.dataset.daily === 'on' });
    await ctxSheetRefresh();
  }));
  sheet.querySelector('#ctx-sheet-close').addEventListener('click', closeCtxSheet);
  sheet.querySelector('#ctx-sheet-done').addEventListener('click', closeCtxSheet);

  sheet.querySelectorAll('[data-dev]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.dev === 'none') {
      await apiSend(`/api/tag-devices/${encodeURIComponent(tag)}`, 'DELETE');
    } else {
      await apiSend('/api/tag-devices', 'POST', { tag, device: b.dataset.dev });
    }
    await ctxSheetRefresh();
  }));
  sheet.querySelectorAll('[data-loc]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.loc === 'none') {
      await apiSend(`/api/tag-locations/${encodeURIComponent(tag)}`, 'DELETE');
      state.tagLocations = state.tagLocations.filter(x => x.tag !== tag);
    } else {
      state.tagLocations = await apiSend('/api/tag-locations', 'POST', { tag, location_id: parseInt(b.dataset.loc) }).then(r => r.json());
    }
    await ctxSheetRefresh();
  }));
  sheet.querySelectorAll('[data-time]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.time === 'none') {
      await apiSend(`/api/tag-times/${encodeURIComponent(tag)}`, 'DELETE');
    } else {
      await apiSend('/api/tag-times', 'POST', { tag, source_uid: b.dataset.time });
    }
    await ctxSheetRefresh();
  }));
}


// ── Engage — the day panel (GTD Panel Layouts 6c) ─────────────
// The day as GTD's hard landscape in one column: Gate bookends as hairline
// rules, blocks and gcal events at their times, and next actions DRAGGED
// between those fixed points. A placement is a sort key in engage_placement,
// never a property of the item — the item stays an ordinary next action, and
// unplaced actions sit in the "Not scheduled" pool at the bottom.
const engageView = { placements: [], pool: [], allItems: [], overrides: [],
                     // The viewed day (YMD). null = today, and the header's ‹ ›
                     // move it. Session-local, like every other view state —
                     // the label always says which day you are looking at.
                     date: null,
                     // Placements on/after the viewed day, for the pool's
                     // "already scheduled" exclusion (date >= viewed).
                     futurePlaced: [],
                     routineItems: [], flows: [], deferred: [],
                     dragId: null,
                     // Which routine's details card is open (area id). Session
                     // state; survives the re-render a checkoff triggers.
                     routinePop: null };

function initUndo() {
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.key !== 'z' && e.key !== 'Z') return;
    // Inside a text field the browser's own undo is the right behaviour.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    runUndo();
  });
}

// Ctrl+Alt+P, and it fires from ANYWHERE — inside a text field too, unlike
// Ctrl+Z above. This is not an editing verb whose meaning changes with what
// has focus; it is the one keystroke you want to work while you are typing,
// because typing is when somebody walks up behind you.
function initPrivacyHotkey() {
  document.addEventListener('keydown', e => {
    if (!isPrivacyChord(e)) return;
    e.preventDefault();
    togglePrivacy();
  });
}

function initEngage() {
  // Engage IS the home screen now (9c) — nothing to open or close. Esc peels
  // one layer at a time: project search → clarify sheet → routine card.
  const peelClarify = () => {
    // The composer peels to the NEXT CAPTURE, not back to the search: its
    // project exists and its first action is filed, so there is nothing to
    // cancel — leaving it is finishing it.
    if (clarifyView.compose) {
      closeCompose();
    } else if (clarifyView.projSearch != null) {
      clarifyView.projSearch = null;
      renderClarify();
    } else {
      closeClarify();
    }
  };
  // The clarify sheet is the innermost layer wherever it was opened from (only
  // the picker it can raise sits over it), and tapping off it is the touch Esc
  // — the same peel, innermost first.
  // While a flow is picking its place, the first Esc gives the pick up (back
  // where clarify was opened); the next one puts the sheet down.
  escRung(0, () => { if (!clarifyView.picking) return false; endClarifyPick(); return true; });
  defineSheet('clarify-sheet', { rank: 1, isOpen: () => clarifyView.open, close: peelClarify });
  // The routine card is the LAST rung: it is drawn on the day itself, under
  // every overlay. (It used to close on its own listener, in the same keypress
  // as whatever layer the ladder peeled above it.)
  escRung(90, () => {
    if (engageView.routinePop == null) return false;
    engageView.routinePop = null;
    renderEngage();
    return true;
  });
}

async function openEngage() {
  await refreshEngage();
  // No header clock (2026-08-08) and so no tick to drive it. The day is
  // already positioned against now by .eg-past dimming; the device shows the
  // time everywhere else.
}

// The viewed day as YMD; parse at noon so DST shifts can't slide the date.
function egDateStr() { return engageView.date || wallDay(); }
function egViewDate() { return new Date(egDateStr() + 'T12:00:00'); }

// Engage writes still in flight; the day re-reads once the last one lands.
let egWrites = 0;

async function refreshEngage() {
  const dateStr = egDateStr();
  // /api/map resolves placed items from ANY domain; the pool fetch is only the
  // chip's domain (and runs the recurring-task seeding, same as NOW).
  // Catches fall back to the current values, not [] — this is the home screen,
  // and a network drop must not blank the day that is already rendered. See the
  // note on loadAll.
  const [placements, futurePlaced, pool, all, overrides, daySegments, routineItems, flows,
         schedules, deferred] = await Promise.all([
    apiGet(`/api/engage/placements?date=${dateStr}`, engageView.placements),
    // Scheduled on/after the viewed day → out of "Not scheduled" (the pool
    // shows what still NEEDS a day, and these have one).
    apiGet(`/api/engage/placements?from=${dateStr}`, engageView.futurePlaced),
    // Everything available, every domain: the context picker narrows it
    // client-side, so switching contexts is instant.
    apiGet('/api/inbox/active', engageView.pool),
    apiGet('/api/map', engageView.allItems),
    apiGet(`/api/overrides?date=${dateStr}`, []),
    // Same served day the timeline draws — Engage lists the blocks it
    // resolves, so both surfaces get the answer from one place.
    apiGet(`/api/blocks/day?date=${dateStr}&all=1`, viewSegmentsFor(dateStr)),
    apiGet('/api/routine-items', []),
    apiGet(`/api/schedules?date=${dateStr}&unnamed=1`, state.schedules),
    // Everything parked on a future date, unfiltered — walking the calendar
    // then costs no round trip, same as the pool.
    apiGet('/api/inbox/deferred', engageView.deferred),
  ]);
  engageView.placements = placements;
  engageView.futurePlaced = futurePlaced;
  engageView.pool = pool;
  engageView.allItems = all;
  engageView.overrides = overrides;
  state.viewSegments = { date: dateStr, segments: Array.isArray(daySegments) ? daySegments : [] };
  engageView.routineItems = routineItems;
  state.schedules = Array.isArray(schedules) ? schedules : [];
  engageView.deferred = Array.isArray(deferred) ? deferred : [];
  renderEngage();
}

// WHAT THE TO-DO LIST HOLDS: an available row (the server's /api/inbox/active,
// _AVAILABLE) that is an action, not a project. ONE rule, asked by the pool
// and by Projects — which shows what is NOT on the list (2026-10-01, Quentin:
// "these are entirely separate"). Placements, the routine areas and the
// context gates only decide where on the day a listed row is drawn.
function onTodoList(i) {
  return (i.kind || 'item') === 'item';
}

// THE FOUR POOL GATES, in one place.
//
// Location, device, time and day: each decides whether an available item is
// shown in the POOL (never the day's commitments — that boundary is the whole
// point), and each is FAIL-OPEN by construction. They were 80 lines in the
// middle of renderEngage, which is where a 900-line function comes from and
// also where four rules with one shared shape go to drift apart.
//
// Every count on the pool header comes from these same predicates, so a gate
// can never hide an item without the header being able to say so.
function engagePoolGates(nowMin, isToday) {
  // Location gate: any bound tag on the item must be satisfied by the current
  // fix; without a fix nothing is gated (fail-open, see initGeo).
  //
  // PAIRED WITH storage.items_at_location, which answers the same membership
  // question for a place the device is not at (an arrival). The DISTANCE test
  // lives here because the fix does; the "every bound tag must be satisfied"
  // rule below is the half both share, and changing it here means changing it
  // there. No tripwire ties them — resolution_test covers day-projecting
  // columns and this is not one — so the pairing rests on this comment.
  const tagLoc = {};
  (state.tagLocations || []).forEach(b => {
    const loc = (state.locations || []).find(l => l.id === b.location_id);
    if (loc) tagLoc[b.tag] = loc;
  });
  const locOk = i => !state.geo.ok || itemTags(i).every(t => {
    const loc = tagLoc[t];
    return !loc || geoDistM(state.geo.lat, state.geo.lng, loc.lat, loc.lng)
      <= (loc.radius_m || 150);
  });

  // Device gate: on the pc you get the pc-tagged work plus everything carrying
  // no device tag at all; the phone-only rows drop out (see DEVICE_TAGS). The
  // day's fixed points are commitments and are never filtered — this is the
  // pool, same boundary the location gate keeps.
  const device = currentDevice();
  const tagDev = deviceTagMap();
  const deviceOk = i => itemOnDevice(i, device, tagDev);

  // TIME gate: a tag bound to a SCHEDULE SOURCE only counts while you are
  // inside one of that source's occurrences. The server sends the intervals it
  // covers the viewed date (schedule.py — the one occurrence source); the
  // minute comparison is here because the wall clock is the half only the
  // client knows.
  //
  // The intervals are already clipped to the day at both edges, so a window
  // that runs past midnight arrives as a tail on one day and a head on the
  // next — which is why this no longer has wrap-around arithmetic of its own.
  //
  // FAIL-OPEN off today, like the geo gate is fail-open with no fix: "in that
  // window right now" is a statement about now, and applying it to a day you
  // are only planning would hide work for no reason you could see.
  const tagTime = {};
  (state.tagTimes || []).forEach(b => {
    const p = (state.schedules || []).find(x => x.uid === b.source_uid);
    if (p) tagTime[b.tag] = p;
  });
  const inPeriod = p => (p.intervals || []).some(iv => {
    const from = timeToMinutes(iv.start);
    const to = iv.end === '24:00' ? DAY_MIN : timeToMinutes(iv.end);
    return nowMin >= from && nowMin < to;
  });
  const gateOn = timeGateOn();
  const timeOk = i => !isToday || !gateOn || itemTags(i).every(t => {
    const p = tagTime[t];
    return !p || inPeriod(p);
  });

  // Hidden-by-location is COUNTED on the header, never silent — trust in the
  // pool is multiplicative across 210 glances a week. Hidden-by-device is
  // counted the same way, and among the locOk rows only, so the two exclusions
  // can't both claim the same item.
  // DAY gate: a tag can be asked about each morning (tag_daily) and answered for
  // the date (tag_day). Only an explicit "not today" hides anything — an
  // UNANSWERED day excludes nothing (Quentin), so skipping the routine leaves
  // the pool exactly as it was. Only on TODAY: an answer is a statement about
  // today, so applying it to a day you are merely planning would hide work for
  // a reason that isn't true yet — the same rule the time gate follows.
  const dayAns = (state.tagDaily || {}).answers || {};
  const onToday = !engageView.date || engageView.date === wallDay();
  const dayOk = i => !onToday || itemTags(i).every(t => dayAns[t] !== false);

  return { locOk, deviceOk, timeOk, dayOk, device,
           // The context menu marks each tag with the gate that binds it.
           tagLoc, tagDev, tagTime, gateOn };
}

// THE DAY'S FIXED POINTS — everything that already has a time on it, in one
// list of semantic minutes: gates and the routines they gate, blocks, routine
// areas, calendar events, and the actions placed between them.
//
// Assembling it was the first 110 lines of renderEngage. It is a pure
// computation over state and the viewed day, and naming it makes the render
// read as what it is: build the day, gate the pool, draw, wire.
// No `dow` any more: which blocks a day has is the SERVER's answer now
// (viewSegmentsFor), and the weekday was only ever the client's way of
// working it out.
function engageDayRows(now, dateStr, viewDate, isToday, isoMin) {
  // The day's fixed points, all in semantic minutes.
  const rows = [];

  const qrMinutes = {};
  (state.accountabilityNodes || []).filter(n => n.active)
    .filter(n => gateAppliesOnDate(n, dateStr))
    .forEach(n => {
      // today_override is the Worker's resolution FOR TODAY — on any other
      // viewed day fall back to weekly window > defaults. (Date overrides for
      // other days stay the timeline's business; Engage shows the default
      // shape of a day it can't yet know overrides for.)
      const ov = isToday ? n.today_override : null;
      const def = nodeWindowForDate(n, dateStr);
      const end = ov ? ov.window_end : def.window_end;
      const off = ov ? (ov.window_end_offset_days || 0) : (def.window_end_offset_days || 0);
      const outcome = state.qrOutcomes[`${n.id}:${dateStr}`];
      const minute = windowEndMin(end, off);
      qrMinutes[n.id] = minute;
      rows.push({ kind: 'qr', minute, nodeId: n.id, label: n.label, outcome });
    });

  // Routine areas collapse to ONE row per area spanning their blocks; the
  // blocks themselves become the routine's steps inside the details card.
  // The checklist is the routine_item datatype on the AREA — done_date makes
  // a check daily (checked iff done_date == today).
  const routineAreaIds = new Set(state.areas.filter(a => a.type === 'routine').map(a => a.id));
  const routineGroups = {};

  // The same served answer the timeline draws (viewSegmentsFor), so the two
  // cannot disagree about which blocks a day has. Yesterday's overnight tail
  // (a negative start) is skipped here: Engage lists the day's own commitments.
  viewSegmentsFor(dateStr).filter(s => s.start >= 0).forEach(s => {
    const seg = { minute: s.start, endMin: s.end, id: s.block_id, dayBlockId: s.day_block_id,
                  label: s.label, cancelled: !!s.cancelled, color: s.color };
    if (routineAreaIds.has(s.area_id)) {
      (routineGroups[s.area_id] = routineGroups[s.area_id] || []).push(seg);
      return;
    }
    rows.push({ kind: 'block', ...seg });
  });

  // ONE ROW PER BLOCK (2026-08-08). A routine area used to collapse into a
  // single row spanning min start -> max end, with its blocks visible only
  // inside the details card — so a three-part morning read as one opaque
  // 06:00-08:00 bar and you could not see what was next without opening it.
  // Each block is its own row now, at its own time. Every row keeps the FULL
  // block list so the ☰ card still shows the whole routine.
  Object.entries(routineGroups).forEach(([areaId, blocks]) => {
    blocks.sort((a, b) => a.minute - b.minute);
    blocks.forEach(b => {
      rows.push({ kind: 'routine', areaId: parseInt(areaId),
                  label: b.label, minute: b.minute, endMin: b.endMin,
                  cancelled: b.cancelled, color: b.color, blocks });
    });
  });

  // A gate-anchored routine with no block today nests directly under its gate's
  // hairline (Morning routine under Wake gate, per the design). Blocks win as
  // the anchor when both exist. SAME minute as the gate, not +1: a placement's
  // fractional midpoint used to slip between the hairline and its riding
  // label. The sort is stable (gates are pushed first) and actions tie-break
  // last, so the pair stays adjacent whatever lands at that minute.
  state.areas
    .filter(a => a.type === 'routine' && a.active && a.qr_node_id
                 && !routineGroups[a.id] && qrMinutes[a.qr_node_id] != null)
    .forEach(a => {
      const qm = qrMinutes[a.qr_node_id];
      rows.push({ kind: 'routine', areaId: a.id, label: a.name,
                  minute: qm, endMin: qm, blocks: [] });
    });

  // Same dismissal set as the timeline: a right-clicked-away (or ⌘-clicked,
  // below) event is gone from the DAY, whichever surface shows it.
  dayTimedEvents(viewDate).forEach(e => {
    rows.push({ kind: 'event', minute: isoMin(e.start), endMin: isoMin(e.end),
                label: e.summary || 'Event', ekey: eventKey(e),
                moved: !!e.moved, color: e.color });
  });

  const itemById = {};
  engageView.allItems.forEach(i => { itemById[i.id] = i; });
  const placedIds = new Set();
  engageView.placements.forEach(p => {
    const item = itemById[p.item_id];
    // A placement whose item was completed or parked elsewhere just falls out.
    if (!item || item.status !== 'active') return;
    placedIds.add(item.id);
    rows.push({ kind: 'action', minute: p.minute, id: item.id, label: item.content,
                started: !!item.started_at });
  });

  rows.sort((a, b) => a.minute - b.minute || (a.kind === 'action') - (b.kind === 'action'));

  return { rows, qrMinutes, routineAreaIds, routineGroups, itemById, placedIds };
}

// The row's control, for the two Engage row shapes. One place, so the pool and
// the day cannot offer different verbs for the same item.
function egRowControl(i, started, title) {
  return `<span class="eg-check${started ? ' eg-check-started' : ''}" data-id="${i.id}"
    title="${title}">${started ? '<span class="eg-check-dot"></span>' : ''}</span>`;
}

function egAgendaOpen() {
  try { return localStorage.getItem('egAgenda') === '1'; } catch (e) { return false; }
}

function setEgAgendaOpen(on) {
  try { localStorage.setItem('egAgenda', on ? '1' : '0'); } catch (e) { /* a convenience */ }
}

// CLICK BELOW THE LIST TO ADD A TO-DO (Now Page Minimal v2). A to-do is an
// ordinary next action — ACTIVE, unfiled, so it is in every domain's pool —
// written straight to the list the way the design draws it; the capture bar
// underneath is still the inbox. Enter adds and keeps the row open, an empty
// Enter or Esc closes it, and leaving it with text in it adds that text. A
// failed write keeps the text. Wired ONCE: the row lives outside #eg-main,
// which is what every repaint replaces.
function wireEgAdd(body) {
  const row = body.querySelector('.eg-add-row');
  const input = body.querySelector('#eg-add-input');
  const close = () => { input.value = ''; row.classList.add('hidden'); };
  body.querySelector('#eg-add-fill').addEventListener('click', () => {
    row.classList.remove('hidden');
    input.focus();
  });
  const add = async keepOpen => {
    const content = input.value.trim();
    if (!content) { close(); return; }
    input.value = '';
    if (!keepOpen) row.classList.add('hidden');
    if (!(await addEngageTodo(content))) {
      input.value = content;
      row.classList.remove('hidden');
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      input.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!input.value.trim()) { close(); input.blur(); } else add(true);
    }
  });
  input.addEventListener('blur', () => { if (input.value.trim()) add(false); else close(); });
}

async function addEngageTodo(content) {
  const res = await apiSend('/api/inbox', 'POST', { content, status: 'active' }).catch(() => null);
  if (!res || !res.ok) { toast('Could not add that — it is still in the box'); return null; }
  const item = await res.json();
  // A create inverts to a delete of the new id.
  pushUndo(`added "${content}"`, async () => {
    await apiSend(`/api/inbox/${item.id}`, 'DELETE');
    await refreshAfterUndo();
  });
  await refreshEngage();
  return item;
}

function renderEngage() {
  const header = document.getElementById('engage-header');
  const body = document.getElementById('engage-body');
  if (!header || !body) return;
  // A rename half-typed on a to-do row is data (the renderBar rule): the
  // repaints from timers and focus would destroy the field. Its own finish
  // drops the mark before it repaints.
  if (document.activeElement && document.activeElement.classList.contains('eg-renaming')) return;

  const now = new Date();
  const dateStr = egDateStr();
  const viewDate = egViewDate();
  const isToday = dateStr === formatDateYMD(now);
  // "Past" dimming is a statement about the wall clock, so it only exists on
  // today's view: a future day has no past yet, and a past day is all past.
  const nowMin = isToday ? now.getHours() * 60 + now.getMinutes()
    : dateStr < formatDateYMD(now) ? 5760 : -1;
  // What is happening RIGHT NOW. nowMin is -1 on a future day and 5760 on a
  // past one, so containment can only ever be true on today — the same trick
  // the past-dimming relies on. Every row whose span contains now is marked:
  // a block and an event really can both be running, and unlike the NOW panel
  // (which has room for one and picks by priority) the timeline can say so.
  const isNow = r => r.endMin > r.minute && r.minute <= nowMin && nowMin < r.endMin;
  const nowAttrs = r => ` data-s="${r.minute}" data-e="${r.endMin}"`;

  const { rows, qrMinutes, routineAreaIds, routineGroups, itemById, placedIds } =
    engageDayRows(now, dateStr, viewDate, isToday, isoMin);

  // NO DOMAIN FILTER (2026-09-30, Quentin's instruction: "remove the domain
  // button selection"). The to-do list used to narrow to the domain in force —
  // the block calendar's, or one picked from the header's context menu, plus
  // any tags required there. The button and its menu are gone, and so is the
  // narrowing: a filter with no control on screen would hide work silently.
  // Every domain's to-dos show. The location / device / time / day gates below
  // still apply, fail-open as ever.
  const { locOk, deviceOk, timeOk, dayOk } = engagePoolGates(nowMin, isToday);

  // Scheduled on/after the viewed day = it HAS a day, so it isn't "Not
  // scheduled" on this one. A placement whose day has passed is not in this
  // set (the server query is date >= viewed), so an unfinished item quietly
  // returns to the pool instead of being scheduled-in-the-past forever.
  const scheduledIds = new Set(engageView.futurePlaced.map(p => p.item_id));
  const poolBase = engageView.pool
    .filter(i => onTodoList(i) && !placedIds.has(i.id)
                 && !scheduledIds.has(i.id)
                 && !routineAreaIds.has(i.area_id));
  // The four HIDDEN-BY-CONTEXT tallies used to be counted here and printed
  // above the list ("4 out of window", "6 not today"). Removed 2026-08-17 at
  // Quentin's request: it was a band of chrome over the one list read dozens
  // of times a day, saying what is NOT there. The gates themselves are
  // unchanged — the pool still hides those rows, and the context pills in the
  // header are still where you see and change what is gating.
  const pool = poolBase
    .filter(i => locOk(i) && deviceOk(i) && timeOk(i) && dayOk(i))
    // OLDEST FIRST, AND NOTHING ELSE. A DOT DOES NOT MOVE A ROW (2026-09-30,
    // Quentin's instruction): in Forster's Final Version the order IS the
    // method — you dot down the list and work back up it — so a dotted row
    // floating to the top scrambled the chain it was dotted into. NOR DOES A
    // DUE DATE (2026-10-05, Quentin's instruction, reversing "deadlines sort
    // the pool" of 2026-08-07): a dated row, a recurring one included, jumped
    // above everything already on the list. Every row lands at the bottom when
    // it is added; the due chip still says when it is due.
    .sort((a, b) => (a.captured_at || '').localeCompare(b.captured_at || '') || a.id - b.id);

  // WHAT COMES BACK ON THIS DAY. A deferred item vanishes from every surface
  // until its date, which is the point — but it also means walking forward to
  // plan a day showed you nothing of what you had already sent there. Only on
  // a FUTURE day: on today these are already in the pool (defer_until <=
  // today is what "available" means), so a section here would be a duplicate.
  const returning = isToday ? []
    : (engageView.deferred || []).filter(i => i.defer_until === dateStr);
  const deferHtml = returning.length ? `
    <div class="eg-pool-head">Returning this day<span class="count">${returning.length}</span></div>
    <div class="eg-pool">
      ${returning.map(i => `
        <div class="eg-row eg-pool-item eg-defer-row" data-id="${i.id}">
          <span class="eg-text">${escHtml(i.content)}</span>
          <span class="eg-tags">${itemTags(i).map(t => `<span class="eg-tag">${escHtml(t)}</span>`).join('')}${
            dueChip(i, 'eg-tag')}<span class="eg-tag">${escHtml(i.project_name || i.area_name || '')}</span></span>
        </div>`).join('')}
    </div>` : '';

  const hhmm = clockHHMM;

  const rowHtml = r => {
    if (r.kind === 'qr') {
      // THE HEADER IS THE OBJECT (2026-08-30, Quentin's instruction). Engage
      // is where these are read thirty times a day, so the name of a gate is
      // the most-seen instance of it anywhere in the app — and it was the one
      // place with no way to reach what it names. Left click, right click and
      // the long press all open its verbs.
      return `<div class="eg-row eg-qr${r.outcome ? ` eg-qr-${r.outcome}` : ''}"
        data-obj="gate:${r.nodeId}" data-obj-tap="1">
        <span class="eg-time">${hhmm(r.minute)}</span>
        <span class="eg-swatch eg-swatch-gate"></span>
        <span class="eg-text eg-qr-label">${escHtml(r.label)}</span>
        ${r.outcome === 'success' ? '<span class="eg-qr-tick">✓</span>' : ''}
      </div>`;
    }
    if (r.kind === 'block') {
      // A block for one date is not a weekly block: no data-block, so the
      // ⌘-click cancel (an override of the WEEK's block) cannot reach it.
      return `<div class="eg-row eg-block${r.dayBlockId ? ' eg-block-day' : ''}${r.cancelled ? ' eg-cancelled' : ''}${r.endMin <= nowMin ? ' eg-past' : ''}${isNow(r) ? ' eg-now' : ''}"${nowAttrs(r)}
        ${r.dayBlockId ? `data-obj="dayblock:${r.dayBlockId}" data-obj-tap="1" title="This date only"`
          : `data-block="${r.id}" data-obj="block:${r.id}" data-obj-tap="1"
        title="${r.cancelled ? '⌘-click to restore' : '⌘-click to cancel for this day'}"`}>
        <span class="eg-time">${hhmm(r.minute)}</span>
        <span class="eg-swatch eg-swatch-block" style="--block-color:${escHtml(r.color || '#888888')}"></span>
        <span class="eg-text">${escHtml(r.label)}</span>
        <span class="eg-end">${hhmm(r.endMin)}</span>
      </div>`;
    }
    if (r.kind === 'routine') {
      // One row for the whole routine; the ☰ button on the right opens the
      // details card (its blocks as steps + the routine_item checklist). The
      // button always shows — an empty checklist is where you'd START one.
      const open = engageView.routineItems.filter(
        i => i.area_id === r.areaId && i.done_date !== dateStr).length;
      // A gate-anchored routine has no span of its own: it rides under the
      // hairline as a bare label, exactly like the design's routine rows.
      return `<div class="eg-row eg-routine${r.cancelled ? ' eg-cancelled' : ''}${r.endMin <= nowMin ? ' eg-past' : ''}${isNow(r) ? ' eg-now' : ''}"${nowAttrs(r)}>
        <span class="eg-time">${hhmm(r.minute)}</span>
        <span class="eg-swatch eg-swatch-block" style="--block-color:${escHtml(r.color || '#888888')}"></span>
        <span class="eg-text">${escHtml(r.label)}</span>
        <button class="eg-routine-btn${engageView.routinePop === r.areaId ? ' eg-routine-btn-on' : ''}"
          data-area="${r.areaId}" title="Routine details">☰${open ? ` ${open}` : ''}</button>
        ${r.endMin > r.minute ? `<span class="eg-end">${hhmm(r.endMin)}</span>` : ''}
      </div>`;
    }
    if (r.kind === 'event') {
      // The source calendar's pastel rides along as an inset edge (inset
      // box-shadow, so no layout shift) — same identity the timeline shows.
      // A MOVED event carries its mark here too: the day is the surface it is
      // actually read on, so a mark that only existed on the calendar overlay
      // would say nothing where it matters. Moving happens on the timeline —
      // this row only reports it.
      return `<div class="eg-row eg-event${r.endMin <= nowMin ? ' eg-past' : ''}${isNow(r) ? ' eg-now' : ''}${r.moved ? ' eg-event-moved' : ''}"${nowAttrs(r)}
        data-ekey="${escHtml(r.ekey)}" title="${r.moved ? 'Moved here — the calendar has it elsewhere. ' : ''}Right-click / long-press to remove from the day">
        <span class="eg-time">${hhmm(r.minute)}</span>
        <span class="eg-swatch eg-swatch-ev" style="--ev-color:${escHtml(r.color || '#888888')}"></span>
        <span class="eg-text eg-event-text">${escHtml(r.label)}</span>
        <span class="eg-end">${hhmm(r.endMin)}</span>
      </div>`;
    }
    // No time on an action: r.minute is the PLACEMENT SORT KEY (the midpoint of
    // its drop gap), not a commitment. Printing it read as an appointment the
    // day never promised. The empty column keeps actions indented under their
    // block; blocks/events/gates above still show their real times.
    return `<div class="eg-row eg-action${r.started ? ' eg-inprog' : ''}" draggable="true" data-id="${r.id}">
      <span class="eg-time"></span>
      ${egRowControl(r, r.started, r.started
        ? 'Started — tap to complete · hold to clear the dot'
        : 'Tap to start · tap again to complete')}
      <span class="eg-text">${escHtml(r.label)}</span>
      <button class="eg-unplace" data-id="${r.id}" title="Back to Not scheduled">↩︎</button>
    </div>`;
  };

  // A drop gap between every pair of neighbours (and one at each end): its
  // minute is the sort key a dropped action receives. Gaps are SILENT — they
  // only light up while a drag is over them; adding new actions happens in
  // the capture bar / NOW, not mid-day.
  const gapHtml = m => `<div class="eg-gap" data-minute="${m}"></div>`;

  const parts = [];
  if (!rows.length) {
    parts.push(gapHtml(540));
    parts.push(`<div class="empty">Nothing fixed ${isToday ? 'today' : 'this day'} — drag an action up from the pool.</div>`);
  } else {
    parts.push(gapHtml(Math.max(0, rows[0].minute - 30)));
    rows.forEach((r, i) => {
      parts.push(rowHtml(r));
      const next = rows[i + 1];
      // A gate-anchored routine used to suppress the drop slot after the gate
      // hairline, because it rode underneath as a bare label and the two read
      // as one unit. It is an ordinary row now (2026-08-08), so it takes an
      // ordinary gap.
      parts.push(gapHtml(next ? (r.minute + next.minute) / 2 : r.minute + 30));
    });
  }

  // NOW PAGE MINIMAL v2 (2026-09-29, Quentin's design): the day and its
  // arrows on the left. The privacy eye that stood in the right slot moved to
  // the top strip (initTopNav, 2026-10-01), where every surface can reach it.
  // NOW PAGE WIDE, 4b (2026-09-30): on a wide window the day (`.eg-head-day`)
  // and the chip with its agenda (`.eg-side`) stand in a column left of the
  // list. Both wrappers are `display: contents` on a phone.
  // The arrows and Today are the shared stepper (dateNavHtml, 2026-10-05);
  // `.eg-head-day` on its row is what the wide column lays out.
  header.innerHTML = `
    ${dateNavHtml({ cls: 'eg-head-day', prev: 'id="eg-prev"', next: 'id="eg-next"',
      today: isToday ? null : 'id="eg-today"',
      label: `<button class="eg-day-btn${isToday ? '' : ' eg-day-off'}" id="eg-day-btn"
        title="Open this day in calendar view">
        <span class="eg-day-name">${weekdayOf(viewDate).long}</span>
        <span class="eg-day-date">${viewDate.getDate()} ${_MONTHS_SHORT[viewDate.getMonth()]}</span>
      </button>` })}
    <span class="eg-spacer"></span>
  `;

  // The routine details card: the area's blocks as read-only steps (their
  // completion is the clock passing them) + the routine_item checklist,
  // checkable/editable/addable — and adding NEVER creates a block.
  let popHtml = '';
  if (engageView.routinePop != null) {
    const rt = rows.find(r => r.kind === 'routine' && r.areaId === engageView.routinePop);
    const area = state.areas.find(a => a.id === engageView.routinePop) || {};
    const items = engageView.routineItems.filter(i => i.area_id === engageView.routinePop);
    const steps = ((rt && rt.blocks) || []).map(b => `
      <div class="eg-rt-step${b.cancelled ? ' eg-cancelled' : ''}${b.endMin <= nowMin ? ' eg-past' : ''}">
        <span class="eg-time">${hhmm(b.minute)}</span>
        <span class="eg-text">${escHtml(b.label)}</span>
        <span class="eg-end">${hhmm(b.endMin)}</span>
      </div>`).join('');
    popHtml = `<div class="eg-rt-pop">
      <div class="eg-rt-head">
        <span class="eg-rt-title">${escHtml(area.name || 'Routine')}</span>
        <button class="modal-close-btn" id="eg-rt-close">✕</button>
      </div>
      ${steps ? `<div class="eg-rt-steps">${steps}</div>` : ''}
      <div class="eg-rt-items">
        ${items.map(i => {
          const done = i.done_date === dateStr;
          return `<div class="eg-rt-item">
            <span class="eg-check eg-rt-check${done ? ' eg-rt-checked' : ''}" data-rt="${i.id}"
              title="${done ? 'Undo' : 'Done today'}">${done ? '✓' : ''}</span>
            <span class="eg-text eg-rt-text${done ? ' eg-rt-done' : ''}" data-rt="${i.id}"
              title="Double-click to rewrite">${escHtml(i.content)}</span>
            <button class="eg-rt-del" data-rt="${i.id}" title="Remove from the routine">×</button>
          </div>`;
        }).join('') || emptyHtml('No checklist yet — add the first line below.')}
      </div>
      <input type="text" class="eg-rt-add" placeholder="+ add to the routine…" autocomplete="off">
    </div>`;
  }

  // THE DAY FOLDS UNDER ONE CHIP (Now Page Minimal v2): what is running now,
  // and a tap opens the whole agenda — the same rows, gaps and doors as ever.
  // A per-viewer convenience, so it is remembered in localStorage (the
  // private-mode desktop window forgets it, which only means it starts shut).
  const nowRow = rows.find(r => (r.kind === 'block' || r.kind === 'routine')
    && !r.cancelled && isNow(r));
  const chipLabel = nowRow ? nowRow.label : isToday ? 'Free' : 'The day';
  const agendaOpen = egAgendaOpen();
  const chipHtml = `<button class="eg-now-chip${agendaOpen ? ' eg-now-chip-on' : ''}" id="eg-agenda-btn"
      aria-expanded="${agendaOpen}" title="${agendaOpen ? 'Fold the day away' : 'Show the whole day'}">
      <span class="eg-swatch ${nowRow ? 'eg-swatch-block' : 'eg-swatch-free'}"${
        nowRow ? ` style="--block-color:${escHtml(nowRow.color || '#888888')}"` : ''}></span>
      <span class="eg-now-name">${escHtml(chipLabel)}</span>
      <svg class="eg-now-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </button>`;

  // The body's first child is re-rendered; the add row beside it is NOT —
  // half-typed text is data, and a repaint from a timer must not take it.
  let main = body.querySelector('#eg-main');
  if (!main) {
    body.innerHTML = `<div id="eg-main"></div>
      <div id="eg-add-zone">
        <div class="eg-row eg-add-row hidden"><span class="eg-check eg-check-ghost"></span>
          <input type="text" id="eg-add-input" placeholder="New to-do" autocomplete="off"></div>
        <div id="eg-add-fill" title="Click to add a to-do"></div>
      </div>`;
    wireEgAdd(body);
    main = body.querySelector('#eg-main');
  }
  main.innerHTML = `
    <div class="eg-side">
      ${chipHtml}
      <div class="eg-day${agendaOpen ? '' : ' eg-day-closed'}">${parts.join('')}</div>
    </div>
    <div class="eg-list">
    ${deferHtml}
    <div class="eg-todo-head">To-do list</div>
    <div class="eg-pool">
      ${pool.map(i => `
        <div class="eg-row eg-pool-item${i.started_at ? ' eg-inprog' : ''}" draggable="true" data-id="${i.id}">
          ${egRowControl(i, i.started_at, i.started_at
            ? 'Started — tap to complete · hold to clear the dot'
            : 'Tap to start · tap again to complete')}
          <span class="eg-text">${escHtml(i.content)}</span>
          <span class="eg-tags">${dueChip(i, 'eg-tag')}</span>
        </div>`).join('') || emptyHtml('Nothing available — done, parked, or handed off.')}
    </div>
    ${popHtml}
    </div>
  `;
  main.querySelector('#eg-agenda-btn').addEventListener('click', () => {
    setEgAgendaOpen(!egAgendaOpen());
    renderEngage();
  });

  // The bottom bar is global now (renderBar) — repaint it alongside the day
  // so the Clarify count and undo state stay honest.
  renderBar();

  // -- wiring --
  // Day navigation. Not undoable (navigation, not data), and session-local:
  // engageView.date is null for today so a restart always lands on the real
  // day. The label doubles as "back to today" whenever you're elsewhere.
  const shiftDay = delta => {
    const d = egViewDate();
    d.setDate(d.getDate() + delta);
    const s = formatDateYMD(d);
    engageView.date = s === wallDay() ? null : s;
    refreshEngage();
  };
  header.querySelector('#eg-prev').addEventListener('click', () => shiftDay(-1));
  header.querySelector('#eg-next').addEventListener('click', () => shiftDay(1));
  // The day itself is the door to the timeline: open calendar view AT the
  // viewed day. The clamp here is now only the review pass's window (navBounds
  // is otherwise unbounded), so an ordinary day opens where you were standing.
  // "Back to today" is the pill that appears only when you're elsewhere.
  header.querySelector('#eg-day-btn').addEventListener('click', async () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const b = navBounds();
    const clamped = Math.max(b.min, Math.min(b.max, dayOffset(egViewDate())));
    state.currentDate = new Date(today.getTime() + clamped * 86400000);
    await fetchOverridesForDate(state.currentDate);
    openM('cal-overlay');
    renderTimeline();
  });
  const todayBtn = header.querySelector('#eg-today');
  if (todayBtn) todayBtn.addEventListener('click', () => {
    engageView.date = null;
    refreshEngage();
  });

  const after = async () => { await refreshEngage(); };

  // [data-id] scopes this to inventory checkboxes — routine checks carry
  // data-rt and PATCH the routine_item instead of deleting an inbox row.
  // Tap = done (as ever). Press-and-hold ~½s = toggle ◐ in progress — a
  // glance state, not availability: predicates ignore it, it just floats
  // the row and marks what you're on. Cleared by another hold or by done.
  body.querySelectorAll('.eg-defer-row .eg-text').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.closest('.eg-defer-row').dataset.id);
      const item = (engageView.deferred || []).find(i => i.id === id);
      if (item) openClarifyForItem(item, async () => { await refreshEngage(); });
    });
  });

  // ◐ IN PROGRESS is a long-press / right-click on the ROW, not a timed hold on
  // the checkbox (2026-08-11). Holding a 14px target for half a second is a
  // gesture you have to aim, and on a phone the press it competes with is
  // "complete this" — the most destructive thing on the surface. The row is the
  // whole width, and long-press is already this app's touch right-click
  // (onLongPress: timeline dismiss, block cancel, event hide).
  // A TAP REDRAWS FIRST, THEN WRITES (2026-10-05, Quentin's report: lag on
  // mobile). Each tap used to wait on the write — a completion is a snapshot
  // GET then the DELETE — and then on ten reads before the row moved, so on a
  // phone's connection a tap read as ignored. The row changes in local state at
  // once; the reads run when the LAST write in flight lands, because a refresh
  // finishing between two quick taps would put the second row back.
  const localItems = id => [...engageView.pool, ...engageView.allItems].filter(i => i.id === id);
  const startedToggle = async id => {
    const item = localItems(id)[0];
    if (!item) return;
    undoablePatch(item, ['started_at'], item.started_at
      ? `cleared in-progress on "${item.content}"`
      : `marked "${item.content}" in progress`);
    const started_at = item.started_at ? null : new Date().toISOString();
    localItems(id).forEach(i => { i.started_at = started_at; });
    renderEngage();
    egWrites++;
    try { await patchInboxItem(id, { started_at }); }
    finally { if (--egWrites === 0) await after(); }
  };
  body.querySelectorAll('.eg-pool-item[data-id], .eg-action[data-id]').forEach(row => {
    const id = parseInt(row.dataset.id);
    onLongPress(row, () => startedToggle(id));
    row.addEventListener('contextmenu', e => { e.preventDefault(); startedToggle(id); });
  });

  // TWO TAPS TO DONE (Now Page Minimal v2): the first tap STARTS it — the dot,
  // the same started_at the long press has always set — and a tap on a dotted
  // box completes it. Both undoable. The row's long press / right-click still
  // toggles the dot, which is how one is cleared without completing.
  body.querySelectorAll('.eg-check[data-id]').forEach(el => {
    const id = parseInt(el.dataset.id);
    el.addEventListener('click', async () => {
      // HOLDING the box is the row's long press, which this sits inside. The
      // click the browser synthesizes after that hold must not also act.
      if (justLongPressed()) return;
      const item = [...engageView.pool, ...engageView.allItems].find(i => i.id === id);
      if (item && !item.started_at) { await startedToggle(id); return; }
      engageView.pool = engageView.pool.filter(i => i.id !== id);
      engageView.allItems = engageView.allItems.filter(i => i.id !== id);
      renderEngage();
      egWrites++;
      try { await undoableDelete(id, `completed "${(item && item.content) || 'action'}"`); }
      finally { if (--egWrites === 0) await after(); }
    });
  });

  // The pool's per-row exit glyphs are gone (2026-08): a pool row is text and
  // a checkbox now, and push/waiting/someday are taken in the clarify sheet.

  body.querySelectorAll('.eg-routine-btn').forEach(el => {
    el.addEventListener('click', () => {
      const key = parseInt(el.dataset.area);
      engageView.routinePop = engageView.routinePop === key ? null : key;
      renderEngage();
    });
  });
  const pop = body.querySelector('.eg-rt-pop');
  if (pop) {
    pop.querySelector('#eg-rt-close').addEventListener('click', () => {
      engageView.routinePop = null;
      renderEngage();
    });
    pop.querySelectorAll('.eg-rt-check').forEach(el => {
      el.addEventListener('click', async () => {
        const id = parseInt(el.dataset.rt);
        const item = engageView.routineItems.find(i => i.id === id);
        if (!item) return;
        const wasDone = item.done_date === dateStr;
        await apiSend(`/api/routine-items/${id}`, 'PATCH', { done: !wasDone });
        pushUndo(`${wasDone ? 'un-checked' : 'checked'} "${item.content}"`, async () => {
          await apiSend(`/api/routine-items/${id}`, 'PATCH', { done: wasDone });
          await refreshAfterUndo();
        });
        await refreshEngage();
      });
    });
    pop.querySelectorAll('.eg-rt-del').forEach(el => {
      el.addEventListener('click', async () => {
        const id = parseInt(el.dataset.rt);
        const row = engageView.routineItems.find(i => i.id === id);
        await apiSend(`/api/routine-items/${id}`, 'DELETE');
        if (row) {
          pushUndo(`removed "${row.content}" from the routine`, async () => {
            await apiSend('/api/routine-items/restore', 'POST', row);
            await refreshAfterUndo();
          });
        }
        await refreshEngage();
      });
    });
    pop.querySelectorAll('.eg-rt-text').forEach(span => {
      span.addEventListener('dblclick', () => {
        const id = parseInt(span.dataset.rt);
        const item = engageView.routineItems.find(i => i.id === id);
        if (!item) return;
        inlineEdit(span, {
          value: item.content,
          onCancel: () => renderEngage(),
          onCommit: async content => {
            await apiSend(`/api/routine-items/${id}`, 'PATCH', { content });
            await refreshEngage();
          },
        });
      });
    });
    const rtAdd = pop.querySelector('.eg-rt-add');
    rtAdd.addEventListener('keydown', async e => {
      if (e.key === 'Escape') { e.stopPropagation(); rtAdd.value = ''; rtAdd.blur(); return; }
      if (e.key !== 'Enter') return;
      const content = rtAdd.value.trim();
      if (!content) return;
      rtAdd.value = '';
      await apiSend('/api/routine-items', 'POST',
        { area_id: engageView.routinePop, content });
      await refreshEngage();
      body.querySelector('.eg-rt-add')?.focus();
    });
  }

  // ⌘/Ctrl-click disables things from the day, without leaving it: a BLOCK
  // toggles that day's cancel (block_override — the same write the timeline's
  // body click makes, so it strikes through everywhere); an EVENT joins the
  // timeline's dismissal set (gcal is a read-only mirror — "hide from my day"
  // is the only honest verb for it). Plain click stays inert on both.
  const egToggleBlockCancel = blockId =>
    toggleBlockCancelOn(blockId, dateStr, engageView.overrides, refreshEngage);

  // ENGAGE'S OWN DAY-LEVEL VERBS, registered fresh each render because they
  // close over the day ENGAGE is showing — which browses independently of the
  // calendar's, and filing a day-level write under the other surface's date is
  // the exact bug the wallDay/viewDay/runDay split exists to prevent.
  registerObjectVerbs('engage', (kind, id, el) => {
    if (!el.closest('#engage-body')) return [];
    if (kind === 'block') {
      const ov = (engageView.overrides || [])
        .find(o => o.block_id === parseInt(id) && o.date === dateStr);
      const cancelled = ov && ov.cancelled === 1;
      return [{ label: cancelled ? 'Restore for today' : 'Cancel for today',
                danger: !cancelled,
                run: () => egToggleBlockCancel(parseInt(id)) }];
    }
    return [];
  });

  body.querySelectorAll('.eg-block[data-block]').forEach(el => {
    // ⌘-click stays: an explicit modifier is not a BARE click, and the row
    // says so in its own title. The long press is the menu's now — it used to
    // cancel the day with no way to see that coming, which is the same
    // unlabelled gesture the timeline just lost.
    el.addEventListener('click', e => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.stopPropagation();
      egToggleBlockCancel(parseInt(el.dataset.block));
    });
  });
  body.querySelectorAll('.eg-event[data-ekey]').forEach(el => {
    const hide = () => hideTimelineItem('event', el.dataset.ekey,
      el.querySelector('.eg-text')?.textContent);
    el.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey) { hide(); return; }
      // A plain tap opens the event's READ-OUT — what the calendar knows about
      // this one booking. The occasion (the actions this KIND of event brings)
      // is a button in its foot, since that is a fact about the title rather
      // than about today's instance. ⌘-click and the long press still hide, and
      // onLongPress swallows the click a fired hold would otherwise send here.
      openEventPop(el.dataset.ekey, el);
    });
    // RIGHT-CLICK REMOVES IT FROM THE DAY (2026-09-15, Quentin's instruction)
    // — it used to do nothing here but raise the browser's own menu. It goes
    // through the object menu, as a block's does beside it, so the verb is
    // read before it is picked; the long press is the same menu for a finger.
    const menu = (x, y) => openObjectMenu(x, y, 'event', el.dataset.ekey,
      [{ label: 'Remove from the day', danger: true, run: hide }]);
    el.addEventListener('contextmenu', e => { e.preventDefault(); menu(e.clientX, e.clientY); });
    onLongPress(el, () => {
      const r = el.getBoundingClientRect();
      menu(r.left + r.width / 2, r.top + 8);
    });
  });

  body.querySelectorAll('.eg-unplace').forEach(el => {
    el.addEventListener('click', async () => {
      const id = parseInt(el.dataset.id);
      const was = engageView.placements.find(p => p.item_id === id);
      await apiSend(`/api/engage/placements/${id}?date=${dateStr}`, 'DELETE');
      if (was) {
        pushUndo('unscheduled an action', async () => {
          await apiSend('/api/engage/placements', 'POST', { date: dateStr, item_id: id, minute: was.minute });
          await refreshAfterUndo();
        });
      }
      await refreshEngage();
    });
  });

  // Drag an action (pool or already-placed) into a gap.
  const placeAt = async (id, minute) => {
    engageView.dragId = null;
    const was = engageView.placements.find(p => p.item_id === id);
    await apiSend('/api/engage/placements', 'POST', { date: dateStr, item_id: id, minute });
    pushUndo(was ? 'moved an action' : 'scheduled an action', async () => {
      if (was) {
        await apiSend('/api/engage/placements', 'POST', { date: dateStr, item_id: id, minute: was.minute });
      } else {
        await apiSend(`/api/engage/placements/${id}?date=${dateStr}`, 'DELETE');
      }
      await refreshAfterUndo();
    });
    await refreshEngage();
  };

  body.querySelectorAll('.eg-pool-item, .eg-action').forEach(row => {
    row.addEventListener('dragstart', e => {
      engageView.dragId = parseInt(row.dataset.id);
      row.classList.add('eg-dragging');
      // Gaps rest at 3px (whitespace, not targets) — open them all for the
      // duration of the drag, same as the touch arm does.
      body.querySelectorAll('.eg-gap').forEach(g => g.classList.add('eg-gap-armed'));
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.id);
    });
    row.addEventListener('dragend', () => {
      engageView.dragId = null;
      body.querySelectorAll('.eg-gap-over').forEach(g => g.classList.remove('eg-gap-over'));
      body.querySelectorAll('.eg-gap').forEach(g => g.classList.remove('eg-gap-armed'));
      row.classList.remove('eg-dragging');
    });
    // ANY row's text opens the clarify sheet — pool or placed. The
    // tap-to-arm-then-tap-a-gap placement is gone (2026-08-11): it was a
    // two-step gesture with an invisible second target, and the sheet's Show-on
    // date+TIME already places an action on any day. One path, not two.
    // A DOUBLE-CLICK RENAMES (2026-10-02, Quentin's instruction) — MAP's
    // gesture, so the single click waits out the double-click window first.
    // The pool may write wording; it is the one structural thing it may not.
    // (onTapOrDouble turns away the click a long press synthesizes — the same
    // race as the checkbox: the press re-renders, taking its own click guard
    // with it, and clarify would open on top of the ◐ you just set.)
    const poolItem = () => {
      const id = parseInt(row.dataset.id);
      return [...engageView.pool, ...engageView.allItems].find(i => i.id === id);
    };
    onTapOrDouble(row, () => {
      const item = poolItem();
      if (item) openClarifyForItem(item, after);
    }, e => {
      const item = poolItem();
      if (!item) return;
      // eg-renaming is what renderEngage's guard looks for while the field
      // holds focus (inlineEdit lets go before either end repaints).
      inlineEdit(e.target.closest('.eg-text'), {
        value: item.content,
        className: 's2-rename-input eg-renaming',
        row,
        onCancel: () => renderEngage(),
        onCommit: async content => {
          undoablePatch(item, ['content'], `renamed "${item.content}"`);
          await patchInboxItem(item.id, { content });
          await after();
        },
      });
    }, '.eg-text');
  });

  dragEdgeScroll(body);   // a drag can reach gaps above/below the fold
  body.querySelectorAll('.eg-gap').forEach(gap => {
    gap.addEventListener('dragover', e => {
      if (engageView.dragId == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      gap.classList.add('eg-gap-over');
    });
    gap.addEventListener('dragleave', () => gap.classList.remove('eg-gap-over'));
    gap.addEventListener('drop', async e => {
      e.preventDefault();
      const id = engageView.dragId || parseInt(e.dataTransfer.getData('text/plain'));
      if (!id) return;
      await placeAt(id, parseFloat(gap.dataset.minute));
    });
  });

}

// ── Full-screen NOW view (the phone's version of the panel) ───
// Same selection rule as panel.js: latest start wins, ties break
// event > routine > block.
async function renderNowFull() {
  const body = document.getElementById('now-full-body');
  if (!body) return;
  const day = await apiGet('/api/engage/day', null);
  if (!day) { body.innerHTML = emptyHtml('Could not load the day.'); return; }
  const d = new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  const PRIO = { event: 3, routine: 2, block: 1 };
  const active = day.rows
    .filter(r => r.start <= m && m < r.end)
    .sort((a, b) => (b.start - a.start) || (PRIO[b.kind] - PRIO[a.kind]))[0] || null;
  const next = day.rows.filter(r => r.start > m).sort((a, b) => a.start - b.start)[0] || null;
  const hhmm = clockHHMM;

  let checklist = [];
  if (active && active.kind === 'routine') {
    checklist = day.routine_items
      .filter(i => i.area_id === active.area_id && i.done_date !== day.date)
      .map(i => ({ type: 'routine', id: i.id, text: i.content }));
  } else if (active) {
    checklist = day.placed
      .filter(p => p.minute >= active.start && p.minute < active.end)
      .map(p => ({ type: 'action', id: p.id, text: p.content }));
  }

  body.innerHTML = active ? `
    <div class="nf-kind">${escHtml(active.kind.toUpperCase())}</div>
    <div class="nf-label">${escHtml(active.label)}</div>
    <div class="nf-elapsed">NOW · ${Math.max(0, m - active.start)} min in · ${hhmm(active.start)}–${hhmm(active.end)}</div>
    <div class="nf-todos">${checklist.map(t => `
      <button class="nf-todo" data-type="${t.type}" data-id="${t.id}">
        <span class="nf-check">○</span><span class="nf-text">${escHtml(t.text)}</span>
      </button>`).join('')}</div>
    ${next ? `<div class="nf-next">next: ${escHtml(next.label)} at ${hhmm(next.start)}</div>` : ''}
  ` : `
    <div class="nf-label nf-idle">nothing active</div>
    <div class="nf-next">${next ? `next: ${escHtml(next.label)} at ${hhmm(next.start)}`
      : (day.rows.length ? 'day complete' : 'no fixed points today')}</div>
  `;

  body.querySelectorAll('.nf-todo').forEach(b => {
    b.addEventListener('click', async () => {
      const id = parseInt(b.dataset.id);
      const label = b.querySelector('.nf-text')?.textContent || 'item';
      if (b.dataset.type === 'routine') {
        await apiSend(`/api/routine-items/${id}`, 'PATCH', { done: true });
        pushUndo(`checked "${label}"`, async () => {
          await apiSend(`/api/routine-items/${id}`, 'PATCH', { done: false });
          await renderNowFull();
          await refreshAfterUndo();
        });
      } else {
        await undoableDelete(id, `completed "${label}"`);
      }
      await renderNowFull();
      await refreshEngage();
    });
  });
}

// ── Clarify — getting "in" to empty (7b sheet + 8a/8b states) ─
// One item at a time, oldest first, nothing goes back into "in". The three
// verbs are Allen's do/delegate/defer; the only other exits are Trash and
// Someday. Contexts ARE tags. "Show on" is defer_until — adding a TIME also
// drops an engage placement on that date (today lands visibly in the day
// behind the sheet; a future date is scheduled into that day's schedule when
// it arrives). Date alone just defers — no placement. Delegation stamps today
// and takes an optional chase date.
const clarifyView = {
  open: false, queue: [], total: 0, verb: 'defer',
  action: '', tags: new Set(), showDate: '', showTime: '', showDateFrom: '',
  // The five flows (clarifyFlowsHtml): which one, a pick in progress
  // ({ flow, from, hidden }), and what the calendar / a list picked.
  flow: 'todo', picking: null, calPick: '', refPick: null,
  projectId: null, projectName: '', who: '', chase: '',
  notes: '',          // support material, saved with the item on file
  due: '',            // hard deadline (YMD) — real ones only; '' = none
  refOpen: false,     // the Reference exit's browser (R toggles)
  refDir: null,       // the directory it is showing; null is home
  refLists: [],       // loaded with the sheet's other vocab
  projNotesOpen: false, // the chosen PROJECT's notes editor (✎ by the pill)
  areaId: null,       // filed under this area — or …
  domainId: null,     // … under this domain; never both, and neither = nothing
  projSearch: null,   // null = main sheet; a string = the 8b search state
  // Which Do-now you mean: 'done' (the two-minute rule — filing marks it
  // done) or 'progress' (you are STARTING it, not finishing it). The trio of
  // verbs is unchanged; this is a variant revealed under Do now, the way
  // Defer reveals Start-on.
  doVariant: 'done',
  // The BREAKDOWN composer (2026-08-07). Non-null = the search view is showing
  // the new project's action list instead: { id, name, actions, arm }.
  compose: null,
  peopleNames: [], tagVocab: [],
  single: false,      // one item from the pool, not the inbox queue
  external: false,    // the end-of-cycle step: stuff that lives on paper/email
  // Set by `+ next action`: the project every action written in this sitting
  // is filed into. Survives clarifyResetItem, cleared when the sheet closes.
  forProject: null,
  // TEMPLATE MODE. Non-null = this sheet is authoring one of an OCCASION's
  // standing actions rather than deciding a real one. The occasion's actions
  // are clarified like every other action — same sheet, same wording, same
  // contexts and filing — but the EXITS are about today (do it, delegate it,
  // defer it to a date, trash it) and a template has no today. So the verbs,
  // the Or row and the show-on/due row drop out and one Save remains.
  forOccasion: null,
  // A RECURRING PROJECT'S template (2026-08-19). Non-null = the sheet is
  // editing a `recurring_task` row that seeds a PROJECT — the same shape as
  // template mode above, for the same reason: an outcome that comes back every
  // year is decided in the words an outcome is always decided in, and Settings
  // was the only place that could hold the schedule. { id } or { id: null }.
  forRecurring: null,
  // A PROJECT is a different decision from an action, so the sheet is a
  // different sheet: an outcome has no next-physical-action, no context, no
  // parent project and nothing to place in a day. What it does have is a
  // state (active / deferred to a start date / someday / trashed / kept as
  // reference), a real deadline, a domain, and support material.
  project: false,
  after: null,        // re-render for the surface that opened the sheet
  // Filing is several round trips (patch → refetch → refresh day → refresh
  // pool). Without a lock the sheet looks frozen and a second click files the
  // NEXT item by accident — the one thing this surface must never do.
  filing: false,
};

// The sheet's supporting vocab (people chips, tag vocab, project search),
// shared by every way in — the inbox queue, a single pool item, external.
async function clarifyLoadAux() {
  const [people, all, projects, refLists] = await Promise.all([
    apiGet('/api/people', []),
    apiGet('/api/map', []),
    apiGet('/api/projects', []),
    apiGet('/api/ref', []),
  ]);
  clarifyView.refLists = Array.isArray(refLists) ? refLists : [];
  clarifyView.peopleNames = (Array.isArray(people) ? people : [])
    .map(p => p.name).filter(Boolean).slice(0, 8);
  // Estimates ride the tag system (GTD's time-available criterion, same as
  // energy): always offered, duration order, ahead of the observed vocab —
  // so the picker's existing chips/filters do all the work with no new field.
  // Device tags ride the same rail for the same reason (see DEVICE_TAGS) —
  // and being always-offered is what makes them reachable at all, since a tag
  // nothing carries yet can never appear in the observed vocab.
  const observed = [...new Set((Array.isArray(all) ? all : []).flatMap(itemTags))]
    .filter(t => !EST_TAGS.includes(t) && !DEVICE_TAGS.includes(t)).sort();
  clarifyView.tagVocab = [...EST_TAGS, ...DEVICE_TAGS, ...observed];
  state.projects = Array.isArray(projects) ? projects : [];
}

async function openClarify() {
  state.inbox = await fetch('/api/inbox').then(r => r.json());
  renderInbox();
  await clarifyLoadAux();
  // This device's queue only: a capture handed to the other machine waits
  // there, and clarifyBarLabel says how many, so nothing is silently gone.
  const device = currentDevice();
  const tagDev = deviceTagMap();
  clarifyView.queue = [...state.inbox]
    .filter(i => itemOnDevice(i, device, tagDev))
    .sort((a, b) => (a.captured_at || '').localeCompare(b.captured_at || '') || a.id - b.id);
  clarifyView.total = clarifyView.queue.length;
  clarifyView.single = false;
  // An empty "in" doesn't mean an empty head: the cycle still ends (or, here,
  // starts) with the stuff on sticky notes, in email, on paper.
  clarifyView.external = !clarifyView.queue.length;
  clarifyView.open = true;
  clarifyResetItem();
  renderClarify();
}

// Task 14's entry: one pool row re-clarified from the day, then back to it.
// `after` re-renders whichever surface opened the sheet. The sheet writes all
// three column families, so a clarify from GTD or MAP can change what those
// lists should be showing — Engage passes nothing, because closeClarify's
// renderInbox plus the day's own refresh already cover it.
// A NEW action, clarified as it is written, filed straight into a project.
//
// `+ next action` used to arm the capture bar in `◉ <project>` mode, which
// meant the action arrived unclarified: no context, no due date, no show-on —
// and the only way to add them was to find the row again on another lens and
// open this sheet from there. Two passes over one decision. The external step
// already knew how to clarify something that has no row yet, so this is that
// step with the project pre-chosen.
//
// `forProject` SURVIVES a reset, so filing one action leaves you ready to write
// the next into the same project — the "one more, one more, done" rhythm the
// bar had, without giving up the clarification.
async function openClarifyNewAction(project, after) {
  await clarifyLoadAux();
  clarifyView.queue = [];
  clarifyView.total = 0;
  clarifyView.single = false;
  clarifyView.external = true;
  clarifyView.open = true;
  clarifyView.after = after || null;
  clarifyView.forProject = { id: project.id, name: project.content || project.name,
                             areaId: project.area_id || null };
  clarifyResetItem();
  renderClarify();
  setTimeout(() => { const el = document.getElementById('cl-action'); if (el) el.focus(); }, 30);
}


async function openClarifyForItem(item, after) {
  await clarifyLoadAux();
  clarifyView.queue = [item];
  clarifyView.total = 1;
  clarifyView.single = true;
  clarifyView.external = false;
  clarifyView.open = true;
  clarifyView.after = after || null;
  clarifyResetItem();
  renderClarify();
}


// An OCCASION's standing action, written the way every action is written.
// `item` null = a new one; otherwise the template row, edited in place.
async function openClarifyForOccasion(occ, item, after) {
  await clarifyLoadAux();
  clarifyView.queue = item ? [item] : [];
  clarifyView.total = item ? 1 : 0;
  clarifyView.single = !!item;
  clarifyView.external = !item;
  clarifyView.open = true;
  clarifyView.after = after || null;
  clarifyView.forOccasion = { id: occ.id, name: occ.name };
  clarifyResetItem();
  // 'defer' is the branch that renders contexts, project and filing-to — the
  // three things a template actually carries. It is never FILED as a defer;
  // fileClarifyOccasion intercepts before any bucket is honoured.
  clarifyView.verb = 'defer';
  clarifyView.showDate = '';
  clarifyView.showTime = '';
  renderClarify();
  setTimeout(() => { const el = document.getElementById('cl-action'); if (el) el.focus(); }, 30);
}

// A RECURRING PROJECT'S template, written the way every project is written.
// `task` null = a new one. There is no inbox_item here at all — the sheet is
// editing the recurring_task row — so the queue stays empty and renderClarify
// is told to stay open by forRecurring rather than by an item.
async function openClarifyForRecurring(task, after) {
  await clarifyLoadAux();
  clarifyView.queue = [];
  clarifyView.total = 0;
  clarifyView.single = false;
  clarifyView.external = false;
  clarifyView.open = true;
  clarifyView.after = after || null;
  clarifyResetItem();
  clarifyView.forRecurring = {
    id: task ? task.id : null,
    interval: task ? (task.interval || 12) : 12,
    anchor: task ? task.anchor_date : recNextAnchor(),
    dueMd: task ? (task.deadline_md || '') : '',
    active: task ? !!task.active : true,
  };
  clarifyView.action = task ? task.name : '';
  clarifyView.notes = task ? (task.notes || '') : '';
  clarifyView.areaId = (task && task.area_id) || null;
  clarifyView.domainId = task && !task.area_id ? (task.domain_id || null) : null;
  // 'active' is the branch that renders the filing chips and no date row; the
  // dates here are the SCHEDULE's, and saveClarifyRecurring is what runs.
  clarifyView.verb = 'active';
  clarifyView.project = true;
  renderClarify();
  setTimeout(() => { const el = document.getElementById('cl-action'); if (el) el.focus(); }, 30);
}

// The default first occurrence: the same day next month, so a new template is
// dated forward rather than into a month that has already gone (which
// _recurring_due reads as "never").
function recNextAnchor() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return formatDateYMD(d);
}

// 'MM-DD' as a person reads it. The YEAR is deliberately absent: the rule is a
// day of the year, and the year it lands in is decided when it is seeded.
function recDueLabel(md) {
  if (!md) return '';
  const [m, d] = String(md).split('-').map(x => parseInt(x));
  if (!m || !d) return '';
  return new Date(2001, m - 1, d).toLocaleDateString(undefined,
    { day: 'numeric', month: 'long' });
}

// A date input insists on a year; the RULE has none. The first occurrence's year
// is the one to show — it is the year the first deadline will land in for any
// due date at or after the anchor's, and it reads as a date instead of as a
// placeholder from 2001. It is never saved: recMdFromDate throws the year away,
// and the hint under the row says the year is not part of the rule. (Which year
// a given occurrence is due in is the SERVER's answer, resolved at seed time —
// nothing here re-derives it.)
function recDueInputValue(rec) {
  const year = (rec.anchor || '').slice(0, 4) || String(new Date().getFullYear());
  return `${year}-${rec.dueMd}`;
}

// The date input speaks in whole dates, the rule is a month and a day; the year
// the picker insists on is dropped on the way in and never shown again.
function recMdFromDate(ymd) {
  return ymd && ymd.length >= 10 ? ymd.slice(5, 10) : '';
}

async function saveClarifyRecurring() {
  const rec = clarifyView.forRecurring;
  const name = clarifyView.action.trim();
  if (!name) { toast('Name the outcome first'); return; }
  if (!rec.anchor) { toast('Say when the first one starts'); return; }
  const body = {
    name, ...clarifyFiling(), kind: 'monthly_date',
    interval: rec.interval, anchor_date: rec.anchor, spawn: 'project',
    deadline_md: rec.dueMd || null, notes: clarifyView.notes,
  };
  const res = rec.id
    ? await apiSend(`/api/recurring/${rec.id}`, 'PATCH',
                    Object.assign({ active: rec.active ? 1 : 0 }, body))
    : await apiSend('/api/recurring', 'POST', body);
  if (!res.ok) {
    toast((await res.json().catch(() => ({}))).error || 'Could not save it');
    return;
  }
  toast(rec.id ? 'Saved' : `"${name}" comes back ${recPeriodLabel(rec.interval)}`);
  closeClarify();
}

// ── STICKY DEFAULTS: what the last item you clarified teaches the next ──
//
// Clarifying a queue is ONE SITTING. An inbox is usually about one part of
// your life at a time and one stretch of calendar at a time, so re-picking
// the same domain and re-typing the same show-on date for every item is a tax
// on the common case. This is the ONE store for that, with the policy named
// per field — the second instance (2026-08-23) is what made it a class rather
// than a special case for the domain.
//
// Two policies, and the difference is what the field is a fact ABOUT:
//   'day'   — valid only on the day it was learned. "What I was working on"
//             is a fact about a day, so carrying yesterday's domain into this
//             morning would file today's captures into last night's project.
//   'idle'  — valid until STICKY_IDLE_MS pass with nobody using it. "The date
//             I keep deferring to" is a fact about a sitting, not a calendar
//             day: a queue worked at 23:50 and again at 00:10 is one sitting,
//             and a queue picked up next week is not. Every USE renews it, so
//             it dies of disuse rather than of age.
//
// Everything here is a DEFAULT, never a decision: a value the item already
// carries always wins (an area, a defer date), and every field it fills stays
// fully editable in the sheet. Stored with its stamp so expiry needs no timer
// and survives a restart. localStorage like every other lens preference
// (mapSort, the device override) — what THIS machine filed is a fact about
// this machine.
//
// Adding a field is one STICKY_FIELDS line plus a stickyRemember() call at
// the point the value is COMMITTED (what was actually written, not what
// happened to be on screen) — and a field whose default could silently move
// money or place a row on a day does not belong here at all. The show-on
// TIME is the live example: a sticky time would ride a sticky date into a
// real placement on a day you never chose.
const STICKY_IDLE_MS = 24 * 60 * 60 * 1000;

const STICKY_FIELDS = {
  showDate: 'idle',      // the show-on date the last defer was given
};

function stickyGet(field) {
  try {
    const raw = JSON.parse(localStorage.getItem('sticky.' + field) || 'null');
    if (!raw) return null;
    if (STICKY_FIELDS[field] === 'day') {
      if (raw.day !== wallDay()) return null;
    } else if (Date.now() - (raw.at || 0) >= STICKY_IDLE_MS) {
      return null;
    }
    return raw.value;
  } catch (e) { return null; }  // unparseable = no memory, the safe answer
}

// Reading a sticky value is not using it — APPLYING it is, and only the
// caller knows whether it did. An idle field that is offered and ignored for
// a day should still expire.
function stickyUse(field) {
  const value = stickyGet(field);
  if (value != null && value !== '') stickyRemember(field, value);
  return value;
}

function stickyRemember(field, value) {
  if (!(field in STICKY_FIELDS)) return;
  if (value == null || value === '') return;
  localStorage.setItem('sticky.' + field,
    JSON.stringify({ value, day: wallDay(), at: Date.now() }));
}

// What the clarify sheet files the item under, as the two columns a write
// sends. Every exit reads this; none re-decides a fallback of its own.
function clarifyFiling() {
  return clarifyView.areaId ? { area_id: clarifyView.areaId, domain_id: null }
                            : { area_id: null, domain_id: clarifyView.domainId || null };
}

// ── Recency memory for pickers with NO natural sort (2026-08-11) ──
//
// Where a list has a real order (due dates, the tree, relevance) that order
// wins; where it has none — which project, which time — the best available
// sort is "what you picked last". LIFO with dedup, capped small: this is a
// hand of recent cards, not a history. localStorage like every other lens
// preference (mapSort, the device override, lastFiled) — what THIS machine
// picked recently is a fact about this machine. Values are opaque to the
// helpers; stale ids fall out at render time when the lookup misses.
const RECENT_MAX = 8;

function recentList(key) {
  try { return JSON.parse(localStorage.getItem('recent.' + key)) || []; }
  catch { return []; }
}

function recentBump(key, value) {
  const list = recentList(key).filter(v => v !== value);
  list.unshift(value);
  localStorage.setItem('recent.' + key, JSON.stringify(list.slice(0, RECENT_MAX)));
}


function clarifyResetItem() {
  const item = clarifyView.queue[0];
  clarifyView.compose = null;
  clarifyView.project = !!(item && item.kind === 'project');
  clarifyView.verb = 'defer';
  // The variant never sticks across items: a sticky 'start it now' would
  // silently mark the next capture in progress.
  clarifyView.doVariant = 'done';
  clarifyView.action = item ? item.content : '';
  clarifyView.tags = new Set(item ? ownTags(item) : []);
  clarifyView.showDate = '';
  clarifyView.showTime = '';
  clarifyView.showDateFrom = '';
  clarifyView.calPick = '';
  clarifyView.refPick = null;
  // A project's start date is a standing property, not a fresh decision, so
  // it is prefilled from the ROW where an action's is only ever a suggestion — "Active" is then the explicit act of
  // clearing it, and re-filing a parked project can't silently un-park it.
  if (clarifyView.project) {
    const parked = item.defer_until && item.defer_until > wallDay();
    clarifyView.verb = parked ? 'defer' : 'active';
    clarifyView.showDate = parked ? item.defer_until : '';
  } else if (item) {
    // An ACTION's show-on date: a date STILL IN FORCE is the item's own
    // decision and wins (re-clarifying a deferred item must not overwrite
    // it); a date already passed is spent, and gets the same blank the sheet
    // always gave it. Only then does the sitting's sticky date fill in.
    const deferred = item.defer_until && item.defer_until > wallDay();
    clarifyView.showDate = deferred ? item.defer_until
                                    : (stickyUse('showDate') || '');
    // A SUGGESTED date is marked as one: it defers the item out of the pool,
    // which is a real consequence for a value nobody typed, so the row says
    // where it came from and carries a one-tap clear. A date the item owns
    // gets neither — it is not a suggestion.
    clarifyView.showDateFrom = (!deferred && clarifyView.showDate) ? 'sticky' : '';
  }
  clarifyView.projectId = null;
  clarifyView.projectName = '';
  // AN ITEM ALREADY FILED KEEPS ITS PROJECT ON SCREEN (2026-08-12). The sheet
  // used to open saying "Project: none" for an action sitting inside one, which
  // misreported where the thing lives, hid the ⛓ and the project's own notes
  // (both of which only render once a project is chosen), and meant the
  // post-filing composer never triggered for an item that was already filed.
  // `clarifyLoadAux` is awaited before this runs in both entry points, so
  // state.projects is loaded and the name resolves.
  if (item && item.project_id) {
    const p = (state.projects || []).find(x => x.id === item.project_id);
    clarifyView.projectId = item.project_id;
    clarifyView.projectName = p ? p.content : '';
  }
  // Writing several actions into one project is one sitting; re-picking the
  // project per action is the tax this exists to remove.
  if (clarifyView.forProject && clarifyView.external) {
    clarifyView.projectId = clarifyView.forProject.id;
    clarifyView.projectName = clarifyView.forProject.name;
    clarifyView.verb = 'defer';
  }
  clarifyView.who = '';
  clarifyView.chase = '';
  clarifyView.notes = item ? (item.notes || '') : '';
  clarifyView.due = item ? (item.deadline || '') : '';
  // An item already filed keeps its filing. Only a fresh capture — which has
  // none — is offered one: the domain you last filed into, else the block in
  // force's. Offered ON the chips, so nothing is filed that the sheet did not
  // show you.
  clarifyView.areaId = item && item.area_id ? item.area_id : null;
  // A row still filed under an old domain keeps it until an area is picked
  // (domains left every picker 2026-10-01; nothing refiles by itself).
  clarifyView.domainId = item && !item.area_id && item.status != null
    ? (item.domain_id || null) : null;
  if (!clarifyView.areaId && !clarifyView.domainId && !(item && item.status != null)
      && state.activeAreaId) {
    clarifyView.areaId = state.activeAreaId;
  }
  clarifyView.projSearch = null;
  clarifyView.projNotesOpen = false;
  clarifyView.refOpen = false;
}

// Chain numbering for one project's actions: after_id links order them, and
// [n] is the position along the walk from the head. Unchained actions get no
// number. Returns {id: n} for every chained action in the set.
function chainNumbers(actions) {
  // A position is DEPTH from the head, not a step along a single path.
  //
  // This used to walk predecessor -> successor through a `nextOf` map, which
  // held ONE successor per predecessor — so with a fan-out ([1] with three
  // actions all waiting on it) the last writer won and the other two silently
  // got no number at all. Depth handles fan-out for free: everything directly
  // behind [1] is [2], whether that is one action or five.
  //
  // Storage always allowed this — after_id lives on the DEPENDENT, so any
  // number of items may point at the same predecessor, and each unblocks on
  // its own when that row goes. Only the numbering couldn't say so.
  const byId = {};
  actions.forEach(a => { byId[a.id] = a; });
  const linked = a => a && a.after_id && byId[a.after_id];
  // Number only what is actually IN a chain: it waits on something, or
  // something waits on it. An unchained action has no position to state.
  const pointedAt = new Set(actions.filter(linked).map(a => a.after_id));
  const memo = {};
  const depth = (a, seen) => {
    if (!linked(a)) return 1;
    if (memo[a.id]) return memo[a.id];
    if (seen.has(a.id)) return 1;          // cycle guard; links can't make one
    seen.add(a.id);
    const d = 1 + depth(byId[a.after_id], seen);
    memo[a.id] = d;
    return d;
  };
  const nums = {};
  actions.forEach(a => {
    if (linked(a) || pointedAt.has(a.id)) nums[a.id] = depth(a, new Set());
  });
  return nums;
}
// The sheet's state, copied and put back — for the one detour it takes: into
// the project's own clarify and back. Functions are skipped (the `after` that
// runs the detour is re-attached by the caller) and a Set is copied rather than
// aliased, or restoring would hand back the very object the other sheet edited.
function clarifySnapshot() {
  const snap = {};
  for (const k of Object.keys(clarifyView)) {
    const v = clarifyView[k];
    if (typeof v === 'function') continue;
    snap[k] = v instanceof Set ? new Set(v) : v;
  }
  return snap;
}

function clarifyRestore(snap) {
  Object.assign(clarifyView, snap);
  clarifyView.open = true;
}

// The contexts this item did not choose: they come from the project above it.
// Read from the project SELECTED IN THE SHEET as well as from the row, so
// picking a project says what the item is about to inherit — before it is
// filed, which is when the decision is actually being made.
function clarifyInherited() {
  const p = (state.projects || []).find(x => x.id === clarifyView.projectId);
  const item = clarifyView.queue[0];
  const from = [...(p ? itemTags(p) : []), ...(item ? inheritedTags(item) : [])];
  return [...new Set(from)].filter(t => !clarifyView.tags.has(t));
}

function closeClarify() {
  flushOpenNotes();
  // Notes typed here must survive ANY exit, filed or not — Escape (and the
  // backdrop) means CLOSE, never revert, same as every other notes editor.
  // Only #cl-proj-notes had that guarantee; the item's own #cl-notes saved
  // exclusively through filing, so Esc mid-clarify silently discarded it.
  // Notes are additive support material, safe to write without filing: status,
  // content and position stay untouched. The reworded action is deliberately
  // NOT saved the same way — a rewording is part of the filing decision, and
  // Esc declines that decision.
  // A TEMPLATE is excluded: it has an explicit Save in the foot, it is a config
  // surface (so nothing here belongs on the undo stack), and everything else
  // this sheet decides about a template already discards on Esc. Saving only
  // the notes would be the one field that leaked out of a declined edit.
  const item = clarifyView.queue[0];
  if (item && !clarifyView.external && !clarifyView.forOccasion && !clarifyView.forRecurring
      && clarifyView.notes !== (item.notes || '')) {
    undoablePatch(item, ['notes'], `edited notes on "${item.content}"`);
    patchInboxItem(item.id, { notes: clarifyView.notes });
    item.notes = clarifyView.notes;
  }
  const after = clarifyView.after;
  if (clarifyView.picking) {
    const from = clarifyView.picking.from;
    clarifyView.picking = null;
    if (from != null && from !== currentRoute()) goRoute(from, true);
  }
  clarifyView.flow = 'todo';
  clarifyView.open = false;
  clarifyView.single = false;
  clarifyView.external = false;
  clarifyView.forProject = null;
  clarifyView.forOccasion = null;
  clarifyView.forRecurring = null;
  clarifyView.after = null;
  hideSheet('clarify-sheet');
  document.getElementById('engage-body').classList.remove('eg-dimmed');
  renderInbox();
  if (after) after();
}

// HAND A CAPTURE TO THE OTHER MACHINE, undecided (2026-08-23).
//
// The gesture on a device chip is not "tag it and file it" — it is the one
// thing the phone can honestly say about a capture it cannot do: this belongs
// at the desk. The item stays in "in", unclarified, and simply leaves this
// device's queue; the pc picks it up with every decision still open.
//
// Device tags are EXCLUSIVE here, like the estimates on the chip row: the
// gesture is a statement about WHERE this gets done, so sending it to the pc
// takes the phone tag off. Nothing else on the row is touched — a tag bound to
// a device in the ctx sheet keeps binding, which can leave an item available
// on both machines, and that is the truth about it rather than a bug.
// Whether this sheet is a QUEUE OF CAPTURES — the only place the hand-off
// gesture means anything, and the only place it is advertised. The external
// step has no row to tag, a template sheet is not a capture, and `single` is
// one row re-clarified from the day or MAP, where "hand it over and move on"
// has no queue to move on to and the sheet would just close on you.
function handOffAvailable() {
  return !!clarifyView.queue.length && !clarifyView.external && !clarifyView.single
    && !clarifyView.forRecurring && !clarifyView.forOccasion;
}

async function handOffToDevice(dev) {
  const item = clarifyView.queue[0];
  if (!item || clarifyView.filing || !handOffAvailable()) return;
  const tags = ownTags(item).filter(t => !DEVICE_TAGS.includes(t)).concat([dev]);
  undoablePatch(item, ['tags'], `sent "${item.content}" to the ${dev} inbox`);
  await patchInboxItem(item.id, { tags: tags.join(' ') });
  state.inbox = await fetch('/api/inbox').then(r => r.json()).catch(() => state.inbox);
  // Re-read the row the SERVER now holds: effective_tags is derived up there,
  // and the gate asks for the effective set.
  const fresh = state.inbox.find(i => i.id === item.id);
  if (fresh && !itemOnDevice(fresh, currentDevice())) {
    clarifyView.queue.shift();
    // It left THIS queue, so the "n of M" head counts one fewer — it is a
    // position in the sitting, not a tally of what was captured.
    clarifyView.total = Math.max(clarifyView.queue.length, clarifyView.total - 1);
    toast(`Waiting on the ${dev}`);
  } else {
    if (fresh) clarifyView.queue[0] = fresh;
    toast(`Marked ${dev}`);
  }
  renderInbox();
  // The queue can empty: the cycle then ends where it always does, on the
  // external step — the head isn't empty until the paper and the email are in.
  if (!clarifyView.queue.length) clarifyView.external = true;
  clarifyResetItem();
  renderClarify();
}

async function fileClarify(bucket, refTarget) {
  if (clarifyView.filing) return;          // in flight — ignore the double click
  // A project's "Active" IS the defer exit with no start date — the same
  // write, so it is a label on this surface rather than a bucket of its own.
  if (bucket === 'active') { clarifyView.showDate = ''; bucket = 'defer'; }
  // "Start it now" is the ACTIVE exit with a started_at stamp — the item is
  // kept, not deleted, so it routes through the same bucket every other
  // keep-it exit uses. Only the FINISH variant of Do now marks it done.
  // A template has no bucket — every exit on this sheet is a statement about
  // today, and the whole point of a template is that it has no today. Caught
  // before anything else so a stray keyboard exit (S, R, ⌫) can't file one.
  if (clarifyView.forRecurring) { await saveClarifyRecurring(); return; }
  if (clarifyView.forOccasion) { await fileClarifyOccasion(); return; }
  if (clarifyView.external) { await fileClarifyExternal(bucket, refTarget); return; }
  const startNow = bucket === 'do' && clarifyView.doVariant === 'progress';
  bucket = clarifyActiveNow(bucket, startNow);
  const item = clarifyView.queue[0];
  if (!item) { closeClarify(); return; }
  if (bucket === 'delegate' && !clarifyView.who.trim()) return;
  if (bucket === 'reference' && !refTarget) return;
  // Read before clarifyResetItem clears it — the post-file composer hook
  // below needs to know where this action landed.
  const filedProjectId = (bucket !== 'trash' && bucket !== 'reference')
    ? clarifyView.projectId : null;
  clarifyView.filing = true;
  paintClarifyBusy(true);
  let refUndo = null;
  try {
    // Filing is one-way by GTD design, but a misfile should still be
    // recoverable: snapshot the item exactly as it sat in "in".
    const snap = await snapshotItem(item.id);
    const patch = body => apiSend(`/api/inbox/${item.id}`, 'PATCH', body);
    const content = clarifyView.action.trim() || item.content;
    // A chosen project overrides the filing server-side, and MAP can re-file
    // later. Filing is what teaches the memory — the filing actually written,
    // not the one that happened to be showing.
    const filing = clarifyFiling();

    // (The 'breakdown' bucket — the capture BECOMING the project — was
    // replaced 2026-08-07 by clarifyCreateProject's composer: naming the
    // outcome and putting this action inside it, rather than promoting a line
    // that was written as an action into an outcome it doesn't read as.)
    if (bucket === 'trash' || bucket === 'do') {
      // Do now = the two-minute rule: you did it; filing marks it done.
      await apiSend(`/api/inbox/${item.id}`, 'DELETE');
    } else if (bucket === 'reference') {
      // The other non-actionable keep: the text moves to a reference list and
      // the item leaves the action inventory entirely.
      refUndo = await refFileCapture(refTarget, content, clarifyView.notes);
      await apiSend(`/api/inbox/${item.id}`, 'DELETE');
    } else if (bucket === 'someday') {
      // No due input on this exit, but the prefilled value rides along so
      // parking a deadlined item never silently drops its deadline.
      await patch({ content, status: 'on_hold', ...filing,
                    notes: clarifyView.notes,
                    deadline: clarifyView.due || null });
    } else if (bucket === 'delegate') {
      await patch({ content, status: 'waiting', ...filing,
                    waiting_on: clarifyView.who.trim(),
                    chase_on: clarifyView.chase || null,
                    notes: clarifyView.notes,
                    deadline: clarifyView.due || null,
                    tags: [...clarifyView.tags].join(' ') });
    } else {
      const body = { content, status: 'active', ...filing,
                     tags: [...clarifyView.tags].join(' '),
                     notes: clarifyView.notes,
                     deadline: clarifyView.due || null,
                     defer_until: clarifyView.showDate || null };
      // ◐ is a glance state, not a predicate: nothing gates on started_at, it
      // just floats the row to the top of the pool and accents it.
      if (startNow) body.started_at = new Date().toISOString();
      if (clarifyView.projectId) body.project_id = clarifyView.projectId;
      await patch(body);
      // The date that was actually WRITTEN teaches the next item — a value
      // left on screen and then cleared by the exit never learned anything.
      stickyRemember('showDate', clarifyView.showDate);
      if (clarifyView.showDate && clarifyView.showTime) {
        // A time schedules it: the placement lands in THAT day's schedule.
        // Prior placements go first, so re-clarifying to a new slot never
        // leaves a stale one behind on another date.
        for (const p of (snap && snap.placements) || []) {
          await apiSend(`/api/engage/placements/${item.id}?date=${p.date}`, 'DELETE');
        }
        await apiSend('/api/engage/placements', 'POST', { item_id: item.id, date: clarifyView.showDate,
                                 minute: timeToMinutes(clarifyView.showTime) });
      }
    }

    if (snap) {
      const verb = { do: 'did', trash: 'trashed', someday: 'parked',
                     delegate: 'delegated', defer: 'filed',
                     reference: 'referenced' }[bucket] || 'filed';
      pushUndo(`${verb} "${item.content}"`, async () => {
        // A reference filing has TWO effects; undo reverses both.
        if (refUndo) await refUndo();
        await apiSend('/api/inbox/restore', 'POST', snap);
        // Put it back at the head of the queue if the sheet is still open.
        if (clarifyView.open) {
          clarifyView.queue.unshift(snap.row);
          clarifyResetItem();
          renderClarify();
        }
        await refreshAfterUndo();
      });
    }
      clarifyView.queue.shift();
      state.inbox = await fetch('/api/inbox').then(r => r.json());
      state.projects = await fetch('/api/projects').then(r => r.json())
        .catch(() => state.projects);
      await refreshEngage();
      await refreshActiveItems();
      // Filing into a project that now holds more than one action drops you
      // into the composer to ORDER them, exactly as creating a project does.
      // The moment you have just added the second action is the moment their
      // sequence is in your head; making you leave, find the project and open
      // the chain editor is how ordering never gets done.
      if (filedProjectId != null) {
        const proj = state.projects.find(x => x.id === filedProjectId);
        if (proj && (proj.action_count || 0) >= 2) {
          await openComposeFor(proj);
          return;
        }
      }
      if (!clarifyView.queue.length) {
        // A single pool item goes straight back to the day. The inbox cycle
        // ends with the EXTERNAL step: the head isn't empty until the sticky
        // notes, emails and paper scraps have been clarified too.
        if (clarifyView.single) { closeClarify(); return; }
        clarifyView.external = true;
      }
      clarifyResetItem();
      renderClarify();
  } finally {
    clarifyView.filing = false;
    paintClarifyBusy(false);
  }
}

// TEMPLATE mode: the row is (or becomes) one of an occasion's standing actions.
// Status is never sent — 'occasion' is the only thing keeping the row out of the
// pool, MAP and the review counts, and storage.update_inbox_item refuses to
// change it anyway. Everything else the sheet decided rides along, and MINTING
// copies exactly these fields onto the day (storage._OCC_COPIED).
async function fileClarifyOccasion() {
  const content = clarifyView.action.trim();
  const item = clarifyView.queue[0];
  if (!content && !item) return;
  const body = {
    content: content || item.content,
    ...clarifyFiling(),
    project_id: clarifyView.projectId || null,
    tags: [...clarifyView.tags].join(' '),
    notes: clarifyView.notes,
  };
  clarifyView.filing = true;
  paintClarifyBusy(true);
  try {
    if (item) {
      await apiSend(`/api/inbox/${item.id}`, 'PATCH', body);
    } else {
      await apiSend(`/api/occasions/${clarifyView.forOccasion.id}/items`, 'POST', body);
    }
  } finally {
    clarifyView.filing = false;
    paintClarifyBusy(false);
  }
  // Not on the undo stack: an occasion is a config surface, like the Settings
  // and Block-editor sheets, and Delete in the foot is the inverse that's
  // actually reachable from here.
  const back = clarifyView.after;
  closeClarify();
  if (back) back();
}


// CLARIFY IS FIVE FLOWS (2026-10-08, Quentin's design "Clarify Flow"): an
// action is done now, put on the to-do list, filed into a project, put on the
// calendar or put in a list — and nothing else (Delegate, Defer, contexts and
// Someday went; notes stay; Show on and Due are the Project flow's). The three
// flows that need a PLACE show that place's own page beside the sheet — the
// Projects page, the week, the Lists page — and a click there picks it; on a
// phone the sheet steps aside while you pick. File it then writes through the
// exits that already existed: do, todo, defer (+ project or placement) and
// reference. No second writer for any of them. A project's own sheet and the
// two template sheets are not flows and keep their own.
const CLARIFY_FLOWS = [
  { key: 'now', name: 'Do now', k: 'N' },
  { key: 'todo', name: 'To-do', k: 'T' },
  { key: 'project', name: 'Project', k: 'P', route: () => 'map', what: 'a project' },
  { key: 'calendar', name: 'Calendar', k: 'C', what: 'a block, an event or a time',
    route: () => (calWeekAvailable() ? 'calendar/week' : 'calendar') },
  { key: 'list', name: 'List', k: 'L', route: () => 'lists', what: 'a list or document' },
];
const CLARIFY_FLOW_HINT = {
  now: 'Marks it done and moves to the next item. Nothing is filed.',
  todo: 'Goes on the to-do list, available now.',
  project: 'Click a project on the Projects page to file it there.',
  calendar: 'Click a block or an event to add it there, or an empty time to put it at that time.',
  list: 'Click a list or document on the Lists page to add it there.',
};

function clarifyFlowMode() {
  return !clarifyView.forRecurring && !clarifyView.forOccasion
    && !(clarifyView.project && !clarifyView.external);
}

function clarifyFlowDest(key) {
  if (key === 'now') return 'mark done';
  if (key === 'todo') return 'to-do list';
  if (key === 'project') return clarifyView.projectName || '';
  if (key === 'calendar') return clarifyView.calPick || '';
  return clarifyView.refPick ? clarifyView.refPick.label : '';
}

function clarifyFlowsHtml() {
  const flow = clarifyView.flow;
  const rows = CLARIFY_FLOWS.map(f => `<button class="cl-flow${flow === f.key ? ' cl-flow-on' : ''}" data-flow="${f.key}">
      <span class="cl-key">${f.k}</span><span class="cl-flow-name">${f.name}</span>
      <span class="cl-flow-dest">${flow === f.key ? escHtml(clarifyFlowDest(f.key)) : ''}</span></button>`).join('');
  const project = flow !== 'project' ? '' : `
    <div class="cl-row">
      <span class="cl-label">Project</span>
      <button id="cl-proj" class="cl-pill${clarifyView.projectId ? ' cl-pill-on' : ''}">${clarifyView.projectId ? escHtml(clarifyView.projectName) : 'search'} ⌕</button>
    </div>
    <div class="cl-row">
      <span class="cl-label">Show on</span>
      <input type="date" id="cl-show-date" class="cl-date" title="Held back until this day" value="${clarifyView.showDate}">
      ${clarifyView.showDateFrom === 'sticky' ? '<button id="cl-show-date-x" class="cl-x" title="Carried over from the last item — tap to clear">✕ carried</button>' : ''}
      <span class="cl-label">Due</span>
      <input type="date" id="cl-due" class="cl-date" title="Real deadlines only" value="${clarifyView.due}">
    </div>`;
  return `<div class="cl-flows">${rows}</div>${project}
    <div class="cl-row"><span class="cl-hint">${CLARIFY_FLOW_HINT[flow]}</span></div>`;
}

function wireClarifyFlows(sheet) {
  sheet.querySelectorAll('[data-flow]').forEach(b => b.addEventListener('click', () => setClarifyFlow(b.dataset.flow)));
}

// Picking a flow clears what the LAST flow picked — a placement or a list
// left behind would otherwise ride along into the new one.
async function setClarifyFlow(key) {
  const prev = clarifyView.flow;
  clarifyView.flow = key;
  if (prev !== key) {
    if (prev === 'calendar') { clarifyView.showDate = ''; clarifyView.showTime = ''; clarifyView.calPick = ''; }
    if (prev === 'list') clarifyView.refPick = null;
  }
  const f = CLARIFY_FLOWS.find(x => x.key === key);
  if (f.route) { await startClarifyPick(f); return; }
  if (clarifyView.picking) { await endClarifyPick(); return; }
  renderClarify();
}

// A pick in progress: { flow, from, hidden }. `from` is where clarify was
// opened, kept across flows, so putting the sheet down puts the page back.
async function startClarifyPick(f) {
  const from = clarifyView.picking ? clarifyView.picking.from : currentRoute();
  const phone = !SETTINGS_WIDE.matches;
  clarifyView.picking = { flow: f.key, from, hidden: phone };
  if (phone) hideSheet('clarify-sheet');
  await goRoute(f.route(), true);
  renderClarify();
  if (phone) toast(`Pick ${f.what} for “${clarifyView.action.trim() || 'this'}” · Esc to cancel`);
}

// Give the pick up: back where clarify was opened, on the to-do flow.
async function endClarifyPick() {
  const from = clarifyView.picking && clarifyView.picking.from;
  clarifyView.picking = null;
  if (clarifyView.flow !== 'now' && clarifyView.flow !== 'todo') clarifyView.flow = 'todo';
  if (from != null && from !== currentRoute()) await goRoute(from, true);
  if (clarifyView.open) renderClarify();
}

function clarifyPicked() {
  if (clarifyView.picking) clarifyView.picking.hidden = false;
  renderClarify();
}

// What a click on the Calendar picked: an event by its key (its real start,
// moved or not, and its own date — a next-day event drawn past midnight is
// that next day's), a block by its column's date and its drawn start, empty
// time by where the pointer is in the column, to the quarter hour.
function calPickFrom(el, e) {
  if (el.classList.contains('tl-gcal-event')) {
    const ev = state.gcalEvents.find(x => eventKey(x) === el.dataset.evKey);
    if (!ev) return null;
    return { date: formatDateYMD(new Date(ev.start)), minute: isoMin(ev.start), label: ev.summary || 'Event' };
  }
  if (el.classList.contains('tl-block')) {
    const label = el.querySelector('.tl-block-label');
    return { date: el.dataset.date || viewDay(), minute: Math.max(0, parseInt(el.dataset.startMin) || 0) % DAY_MIN,
             label: (label && label.textContent.trim()) || 'Block' };
  }
  let date, minute;
  if (el.classList.contains('wk-col')) {
    const r = el.getBoundingClientRect(), rg = calWeek.range;
    minute = rg.start + Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * (rg.end - rg.start);
    date = el.dataset.date;
  } else {
    minute = planMinuteAt(e.clientY);
    date = viewDay();
  }
  minute = Math.round(minute / 15) * 15;
  if (minute >= DAY_MIN) { date = localDatePlusDays(date, 1); minute -= DAY_MIN; }
  return { date, minute, label: 'At' };
}

// While picking, a click on what the flow picks is the pick and nothing else:
// on the WINDOW in the capture phase, ahead of each page's own handlers (the
// Calendar's menus, a project row's clarify, a list row's opening). Anything
// else on the page — a directory, the week's paging — works as it always does.
const CLARIFY_PICK_TARGETS = {
  calendar: '#cal-overlay .tl-block, #cal-overlay .tl-gcal-event, #cal-overlay .wk-col[data-date], #cal-overlay #tl-body',
  project: '#map-overlay .map-row-project[data-id]',
  list: '#tab-lists .ref-row[data-id]',
};
window.addEventListener('click', e => {
  const pk = clarifyView.picking;
  if (!pk || !CLARIFY_PICK_TARGETS[pk.flow]) return;
  if (e.target.closest('#clarify-sheet')) return;
  const el = e.target.closest(CLARIFY_PICK_TARGETS[pk.flow]);
  if (!el) return;
  if (pk.flow === 'list') {
    const l = refView.lists.find(x => String(x.id) === el.dataset.id);
    if (!l || l.kind === 'dir') return;            // a directory still opens
    e.preventDefault(); e.stopPropagation();
    clarifyView.refPick = { kind: l.kind, id: l.id, label: l.name };
    clarifyPicked();
    return;
  }
  e.preventDefault(); e.stopPropagation();
  if (pk.flow === 'project') {
    const p = (state.projects || []).find(x => String(x.id) === el.dataset.id);
    const text = el.querySelector('.map-text');
    clarifyView.projectId = parseInt(el.dataset.id);
    clarifyView.projectName = p ? p.content : (text ? text.textContent.trim() : '');
    clarifyPicked();
    return;
  }
  const pick = calPickFrom(el.closest('.tl-block, .tl-gcal-event') || el, e);
  if (!pick) return;
  clarifyView.showDate = pick.date;
  clarifyView.showTime = clockHHMM(pick.minute);
  clarifyView.showDateFrom = '';
  const day = new Date(pick.date + 'T12:00:00');
  clarifyView.calPick = `${pick.label === 'At' ? '' : pick.label + ' · '}${weekdayOf(day).name} ${day.getDate()} ${hhmmToAmPm(clockHHMM(pick.minute))}`;
  clarifyPicked();
}, true);

// File it, for a flow: the exit the flow means, refused in words (toasted —
// the foot is where a phone's keyboard sits) until it has its place.
function fileClarifyFlow() {
  const flow = clarifyView.flow;
  if (flow === 'now') { clarifyView.doVariant = 'done'; return fileClarify('do'); }
  if (flow === 'todo') return fileClarify('todo');
  if (flow === 'project') {
    if (!clarifyView.projectId) { toast('Pick a project first'); return; }
    return fileClarify('defer');
  }
  if (flow === 'calendar') {
    if (!clarifyView.showDate || !clarifyView.showTime) { toast('Pick a block, an event or a time first'); return; }
    return fileClarify('defer');
  }
  if (!clarifyView.refPick) { toast('Pick a list or document first'); return; }
  return fileClarify('reference', { kind: clarifyView.refPick.kind, id: clarifyView.refPick.id });
}

function clarifyFile() {
  return clarifyFlowMode() ? fileClarifyFlow() : fileClarify(clarifyView.verb);
}

// THE TWO EXITS THAT MEAN "AVAILABLE NOW": start it now, and To-do (2026-10-08,
// Quentin's instruction: one button that sends a task straight to the to-do
// list). Both are the ACTIVE exit with no show-on date — a date, even a
// remembered default, would hold it back from the list — so they ride the
// defer bucket rather than growing a second active writer beside it. Start it
// now adds the started_at stamp on top; To-do adds nothing.
function clarifyActiveNow(bucket, startNow) {
  if (!startNow && bucket !== 'todo') return bucket;
  clarifyView.showDate = '';
  clarifyView.showTime = '';
  return 'defer';
}

// External mode: no source row — YOU hold the item (a sticky note, an email
// thread, a pile of paper). The typed next physical action is the content;
// filing creates the item and then routes it exactly like an inbox row.
// Do now / Trash store nothing: the thing happened (or died) outside the app.
async function fileClarifyExternal(bucket, refTarget) {
  const content = clarifyView.action.trim();
  // Same as fileClarify: starting it keeps the item, so it takes the active
  // path rather than the do-now delete.
  const startNow = bucket === 'do' && clarifyView.doVariant === 'progress';
  bucket = clarifyActiveNow(bucket, startNow);
  if (!content && bucket !== 'trash') return;
  if (bucket === 'delegate' && !clarifyView.who.trim()) return;
  if (bucket === 'reference' && !refTarget) return;
  clarifyView.filing = true;
  paintClarifyBusy(true);
  try {
    if (bucket === 'reference') {
      // Straight to the list — reference never touches the action inventory.
      const refUndo = await refFileCapture(refTarget, content, clarifyView.notes);
      pushUndo(`referenced "${content}"`, async () => {
        await refUndo();
        await refreshAfterUndo();
      });
    } else if (bucket !== 'trash' && bucket !== 'do') {
      const filing = clarifyFiling();
      const created = await apiSend('/api/inbox', 'POST', { content }).then(r => r.json());
      const patch = body => apiSend(`/api/inbox/${created.id}`, 'PATCH', body);
      if (bucket === 'someday') {
        await patch({ status: 'on_hold', ...filing, notes: clarifyView.notes,
                      deadline: clarifyView.due || null });
      } else if (bucket === 'delegate') {
        await patch({ status: 'waiting', ...filing,
                      waiting_on: clarifyView.who.trim(),
                      chase_on: clarifyView.chase || null,
                      notes: clarifyView.notes,
                      deadline: clarifyView.due || null,
                      tags: [...clarifyView.tags].join(' ') });
      } else {
        const body = { status: 'active', ...filing,
                       tags: [...clarifyView.tags].join(' '),
                       notes: clarifyView.notes,
                       deadline: clarifyView.due || null,
                       defer_until: clarifyView.showDate || null };
        if (startNow) body.started_at = new Date().toISOString();
        if (clarifyView.projectId) body.project_id = clarifyView.projectId;
        await patch(body);
        stickyRemember('showDate', clarifyView.showDate);
        if (clarifyView.showDate && clarifyView.showTime) {
          await apiSend('/api/engage/placements', 'POST', { item_id: created.id, date: clarifyView.showDate,
                                   minute: timeToMinutes(clarifyView.showTime) });
        }
      }
      pushUndo(`clarified "${content}"`, async () => {
        await apiSend(`/api/inbox/${created.id}`, 'DELETE');
        await refreshAfterUndo();
      });
    }
    state.inbox = await fetch('/api/inbox').then(r => r.json());
    await refreshEngage();
    clarifyView.queue = [];
    clarifyResetItem();
    renderClarify();
  } finally {
    clarifyView.filing = false;
    paintClarifyBusy(false);
  }
}

// The sheet dims and the button says what it's doing, so the wait reads as
// progress rather than a dead click.
function paintClarifyBusy(busy) {
  const sheet = document.getElementById('clarify-sheet');
  if (!sheet) return;
  sheet.classList.toggle('cl-busy', busy);
  const btn = sheet.querySelector('#cl-file');
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? 'Filing…' : 'File it ⏎';
  }
}

function renderClarify() {
  const sheet = document.getElementById('clarify-sheet');
  const item = clarifyView.queue[0];
  if (!clarifyView.open || (!item && !clarifyView.external && !clarifyView.forRecurring)) {
    closeClarify(); return;
  }
  if (clarifyView.picking && clarifyView.picking.hidden) return;
  if (!clarifyView.picking) document.getElementById('engage-body').classList.add('eg-dimmed');
  showSheet('clarify-sheet');
  if (clarifyView.picking) document.getElementById('clarify-sheet-backdrop').classList.add('hidden');
  if (clarifyView.compose) { renderClarifyCompose(sheet); return; }
  if (clarifyView.projSearch != null) { renderClarifyProjSearch(sheet, item); return; }

  const n = clarifyView.total - clarifyView.queue.length + 1;
  const verb = clarifyView.verb;
  // The project sheet: an outcome, not an action. No next-physical-action, no
  // contexts, no parent project, nothing to drop into a day — the decision is
  // just its state, its deadline and where it belongs.
  const rec = clarifyView.forRecurring;
  const isProj = clarifyView.project && !clarifyView.external && (!!item || !!rec);
  const tpl = !!clarifyView.forOccasion;
  const flowMode = clarifyFlowMode();
  // "Do now" means two different things and only one of them was buildable:
  // FINISH it (the two-minute rule — filing deletes it) or START it. Starting
  // it is the ACTIVE exit plus a started_at stamp — no new column, no new
  // status — so the item keeps its area, contexts, due, notes and project,
  // stays in the pool and renders ◐. Delegate→waiting was the only other way
  // to say "under way", and that one is person-shaped and leaves the pool.
  const doProgress = verb === 'do' && clarifyView.doVariant === 'progress';
  const doVariantChips = () => `
    <div class="cl-chips">
      <button class="chip chip-sm${clarifyView.doVariant === 'done' ? ' on' : ''}"
        data-dovar="done" title="Two-minute rule — filing marks it done">finish it now</button>
      <button class="chip chip-sm${doProgress ? ' on' : ''}"
        data-dovar="progress" title="Starting it — it stays in the pool, marked ◐">start it now <span class="cl-key">I</span></button>
    </div>`;
  const verbBtn = (v, label, key) =>
    `<button class="cl-verb${verb === v ? ' cl-verb-on' : ''}" data-verb="${v}">${label} <span class="cl-key">${key}</span></button>`;

  let middle = '';
  if (rec) {
    // The SCHEDULE, in the place a project sheet asks about dates. Two dates,
    // which is the whole reason this is not a recurring action: the day it
    // makes sense to START (taxes: the forms are all in by 31 January) and the
    // day it is DUE (15 April). One field each, and the due rule says which
    // real date it will resolve to so the month-and-day is never a guess.
    middle = `
      <div class="cl-sec"><span class="cl-label">Comes back</span>
        <span class="cl-hint">a new one appears, this often</span></div>
      <div class="cl-chips">
        ${REC_PERIODS.map(p => `<button class="chip chip-sm${
          rec.interval === p.n ? ' on' : ''}" data-recper="${p.n}">${p.label}</button>`).join('')}
      </div>
      <div class="cl-row">
        <span class="cl-label">First one</span>
        <input type="date" id="cl-rec-anchor" class="cl-date"
          title="The day it first appears — and the day of the month it uses from then on"
          value="${escHtml(rec.anchor || '')}">
        <span class="cl-label">Due</span>
        <input type="date" id="cl-rec-due" class="cl-date"
          title="Only the month and day are kept — the year is decided when it appears"
          value="${escHtml(rec.dueMd ? recDueInputValue(rec) : '')}">
        ${rec.dueMd ? '<button id="cl-rec-due-x" class="cl-x" title="No deadline">✕</button>' : ''}
      </div>
      <div class="cl-row">
        <span class="cl-hint">${rec.dueMd
          ? `due ${escHtml(recDueLabel(rec.dueMd))}, in whichever year it appears`
          : 'no deadline: it appears and waits to be decomposed'}</span>
      </div>
      <div class="cl-sec"><span class="cl-label">State</span>
        <span class="cl-hint">paused: nothing new is seeded</span></div>
      <div class="cl-row"><div class="seg">
        <button class="${rec.active ? 'on' : ''}" data-recact="1">Active</button>
        <button class="${rec.active ? '' : 'on'}" data-recact="0">Paused</button>
      </div></div>
      <div class="cl-row"><span class="cl-hint">Paused stops new ones being seeded.
        Any already filed stay exactly where they are.</span></div>`;
  } else if (isProj) {
    // CONTEXTS ON A PROJECT are not the project's own filter — a project is
    // never in the pool — they are the contexts every action under it
    // inherits (2026-08-19, Quentin). Which is why they are offered here at
    // all, against the old rule that a project sheet has none: it is the one
    // place to say "everything in this is done at the desk" once instead of on
    // every action. Time estimates are left out of the vocabulary on purpose —
    // a project's length is not each action's length, and inheriting one would
    // put a false chip on every child.
    middle = verb === 'trash'
      ? '<div class="cl-donow">Not a real outcome. Deleting it splices its actions up one level.</div>'
      : `<div class="cl-sec"><span class="cl-label">Contexts</span>
        <span class="cl-hint">every action under it inherits these</span></div>
      <div class="cl-chips">
        ${clarifyView.tagVocab.filter(t => !EST_TAGS.includes(t)).map(t =>
          `<button class="chip chip-sm${clarifyView.tags.has(t) ? ' on' : ''}" data-tag="${escHtml(t)}">${escHtml(t)}</button>`).join('')}
        <input type="text" id="cl-tag-new" class="cl-chip-input" placeholder="+ new">
      </div>
      <div class="cl-row">
        ${verb === 'defer' ? `<span class="cl-label">Start on</span>
        <input type="date" id="cl-show-date" class="cl-date"
          title="When you want to start working on this" value="${clarifyView.showDate}">` : ''}
        <span class="cl-label">Due</span>
        <input type="date" id="cl-due" class="cl-date" title="Real deadlines only" value="${clarifyView.due}">
      </div>`;
  } else if (verb === 'delegate') {
    const custom = clarifyView.peopleNames.includes(clarifyView.who) ? '' : clarifyView.who;
    middle = `
      <div class="cl-sec"><span class="cl-label">Waiting on</span><span class="cl-hint">who owns it now</span></div>
      <div class="cl-chips">
        ${clarifyView.peopleNames.map(nm =>
          `<button class="chip chip-sm${clarifyView.who === nm ? ' on' : ''}" data-who="${escHtml(nm)}">${escHtml(nm)}</button>`).join('')}
        <input type="text" id="cl-who-custom" class="cl-chip-input" placeholder="+ someone" value="${escHtml(custom)}">
      </div>
      <div class="cl-row">
        <span class="cl-pill cl-pill-static">Handed off ${new Date().toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
        <span class="cl-label">Chase</span>
        <input type="date" id="cl-chase" class="cl-date" title="Optional — when to chase" value="${clarifyView.chase}">
        <span class="cl-label">Due</span>
        <input type="date" id="cl-due" class="cl-date" title="Real deadlines only" value="${clarifyView.due}">
      </div>`;
  } else if (verb === 'defer' || doProgress) {
    middle = `
      ${doProgress ? doVariantChips() : ''}
      <div class="cl-sec"><span class="cl-label">Contexts</span><span class="cl-hint">${clarifyView.tags.size} selected · pick any${
        handOffAvailable() ? ' · hold pc/phone to send it there' : ''}</span></div>
      <div class="cl-chips">
        ${clarifyView.tagVocab.map(t =>
          `<button class="chip chip-sm${clarifyView.tags.has(t) ? ' on' : ''}" data-tag="${escHtml(t)}">${escHtml(t)}</button>`).join('')}
        <input type="text" id="cl-tag-new" class="cl-chip-input" placeholder="+ new">
      </div>
      ${clarifyInherited().length ? `<div class="cl-row"><span class="cl-hint">from the project:
        ${clarifyInherited().map(t => escHtml(t)).join(' · ')} — change them on the project itself</span></div>` : ''}
      ${tpl ? '' : `<div class="cl-row">
        ${doProgress ? '' : `<span class="cl-label">Show on</span>
        <input type="date" id="cl-show-date" class="cl-date"
          title="Date alone defers; adding a time places it into that day's schedule" value="${clarifyView.showDate}">
        <input type="time" id="cl-show-time" class="cl-date" value="${clarifyView.showTime}" title="A time schedules it into that day">
        ${clarifyView.showTime ? '<button id="cl-show-time-x" class="cl-x" title="Clear the time — date alone just defers">✕</button>' : ''}
        ${clarifyView.showDateFrom === 'sticky' ? '<button id="cl-show-date-x" class="cl-x" title="Carried over from the last item you deferred — tap to clear">✕ carried</button>' : ''}`}
        <span class="cl-label">Due</span>
        <input type="date" id="cl-due" class="cl-date" title="Real deadlines only" value="${clarifyView.due}">
      </div>`}
      <div class="cl-row">
        <span class="cl-label">Project</span>
        <button id="cl-proj" class="cl-pill${clarifyView.projectId ? ' cl-pill-on' : ''}">${clarifyView.projectId ? escHtml(clarifyView.projectName) : 'none'} ⌕</button>
        ${clarifyView.projectId ? `<button id="cl-proj-notes-btn" class="cl-pill${clarifyView.projNotesOpen ? ' cl-pill-on' : ''}"
          title="The project's support material — saved to the project, not this item">✎</button>
        <button id="cl-proj-chain" class="cl-pill"
          title="Order this project's actions and set dependencies">⛓</button>
        <button id="cl-proj-open" class="cl-pill"
          title="Clarify the project itself — its outcome, its deadline, the contexts everything in it inherits">›</button>` : ''}
      </div>
      ${clarifyView.projNotesOpen && clarifyView.projectId ? `
      <textarea id="cl-proj-notes" class="cl-notes" rows="3"
        placeholder="Support material for ${escHtml(clarifyView.projectName)}… markdown ok">${
          escHtml(((state.projects || []).find(p => p.id === clarifyView.projectId) || {}).notes || '')}</textarea>` : ''}`;
  } else if (verb === 'do') {
    middle = doVariantChips()
      + '<div class="cl-donow">Under two minutes — do it now. Filing marks it done.</div>';
  } else {
    middle = '';
  }

  // Where it lands: an AREA or nothing — one row of chips, tap again to let
  // go (domains went 2026-10-01). Filing under nothing is a real answer.
  if ((verb !== 'do' || doProgress) && verb !== 'trash') {
    const shown = state.areas.filter(a => a.active && a.type === 'standard'
                                          || a.id === clarifyView.areaId);
    middle += `
      <div class="cl-sec"><span class="cl-label">Filing to</span>
        <span class="cl-hint">${clarifyView.areaId ? 'tap again to clear' : 'nothing in particular'}</span></div>
      ${shown.length ? `<div class="cl-chips">
        ${shown.map(a => `<button class="chip chip-sm${a.id === clarifyView.areaId ? ' on' : ''}"
           data-area="${a.id}">${escHtml(a.name)}</button>`).join('')}
      </div>` : ''}`;
  }

  if (flowMode) middle = clarifyFlowsHtml();
  const next = clarifyView.queue[1];
  const ext = clarifyView.external;
  // Support material rides along on every keep-it exit; do/trash discard it.
  const notesHtml = (flowMode ? clarifyView.flow === 'now' : (verb === 'do' && !doProgress) || verb === 'trash') ? '' : `
    <div class="cl-sec"><span class="cl-label">Notes</span><span class="cl-hint">support material — optional</span></div>
    <textarea id="cl-notes" class="cl-notes" rows="2"
      placeholder="Links, thinking… markdown ok">${escHtml(clarifyView.notes)}</textarea>`;
  // A recurring project's TEMPLATE is a project with no item behind it, so
  // there is nothing to count actions for. Guarded on `item`, not on isProj: an
  // empty state.projects hid this for exactly as long as the scratch db had no
  // projects in it, which is the worst way for a crash to wait.
  const acts = isProj && item
    ? ((state.projects || []).find(p => p.id === item.id) || {}).action_count
    : null;
  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">${rec ? 'Recurring · project'
        : tpl ? 'Occasion' : `Clarify${isProj ? ' · project' : ''}`}</span>
      <span class="cl-count">${rec ? escHtml(recPeriodLabel(rec.interval))
        : tpl ? escHtml(clarifyView.forOccasion.name) : ext
        ? (clarifyView.forProject ? 'new action' : 'outside the app')
        : `${n} of ${clarifyView.total}`}</span>
      <span class="cl-spacer"></span>
      <span class="cl-hint">one at a time · esc / tap off</span>
    </div>
    ${rec ? `
    <div class="cl-item">
      <div class="cl-title">${escHtml(clarifyView.action || 'An outcome that comes back')}</div>
      <div class="cl-captured">a project is seeded on the day it comes round, with
        these notes and this deadline — then you decompose it as you would any other</div>
    </div>` : tpl ? `
    <div class="cl-item">
      <div class="cl-title">${item ? escHtml(item.content) : 'A standing action'}</div>
      <div class="cl-captured">every time an event matches this occasion, a copy of
        this lands on that day — clarified exactly as you leave it here</div>
    </div>` : ext && clarifyView.forProject ? `
    <div class="cl-item">
      <div class="cl-title">${escHtml(clarifyView.forProject.name)}</div>
      <div class="cl-captured">a new next action, filed here as you write it</div>
    </div>` : ext ? `
    <div class="cl-item">
      <div class="cl-title">Anything still in your head — or on it?</div>
      <div class="cl-captured">sticky notes · emails · paper. Type the next physical action; the source stays where it is.</div>
    </div>` : `
    <div class="cl-item">
      <div class="cl-title">${escHtml(item.content)}</div>
      <div class="cl-captured">${isProj
        ? (acts ? `${acts} next action${acts === 1 ? '' : 's'}`
                : '<span class="cl-proj-bad">no next action</span>')
        : `captured ${(item.captured_at || '').slice(0, 10)}`}</div>
    </div>`}
    ${isProj && !rec ? `<div class="cl-row">
      <button class="cl-pill" id="cl-self-add">+ next action</button>
      ${acts >= 2 ? '<button class="cl-pill" id="cl-self-chain">⛓ order them</button>' : ''}
    </div>` : ''}
    <div class="cl-sec"><span class="cl-q">${isProj
      ? "What's the outcome?" : "What's the next physical action?"}</span></div>
    <div class="cl-action-wrap"><input type="text" id="cl-action" class="cl-action" value="${escHtml(clarifyView.action)}" autocomplete="off"${ext ? ' placeholder="e.g. Reply to Sam about the venue"' : ''}></div>
    ${tpl || rec || flowMode ? '' : `<div class="cl-verbs">${isProj
      ? `${verbBtn('active', 'Active', 'A')}${verbBtn('defer', 'Defer', 'F')}${verbBtn('trash', 'Trash', '⌫')}`
      : `${verbBtn('do', 'Do now', 'D')}${verbBtn('delegate', 'Delegate', 'G')}${verbBtn('defer', 'Defer', 'F')}`}</div>`}
    ${middle}
    ${notesHtml}
    ${tpl || rec || flowMode ? '' : `<div class="cl-row cl-or">
      <span class="cl-label">Or</span>
      ${isProj ? '' : `<button class="cl-pill" id="cl-todo" title="File it as an action, available now">To-do <span class="cl-key">T</span></button>`}
      ${ext || isProj ? '' : `<button class="cl-pill" id="cl-trash">Trash <span class="cl-key">⌫</span></button>`}
      <button class="cl-pill" id="cl-someday">Someday <span class="cl-key">S</span></button>
      <button class="cl-pill${clarifyView.refOpen ? ' cl-pill-on' : ''}" id="cl-reference">Reference <span class="cl-key">R</span></button>
    </div>`}
    ${clarifyView.refOpen && !tpl && !rec ? clarifyRefHtml() : ''}
    <div class="cl-foot">
      <span class="cl-then">${rec ? `First one ${escHtml(rec.anchor || '—')}`
        : tpl ? `Every ${escHtml(clarifyView.forOccasion.name)}`
        : ext ? 'Repeat until your head is empty'
        : next ? `Then: ${escHtml(next.content)}`
        : clarifyView.single ? 'Then: back to the day' : 'Then: anything outside the app'}</span>
      ${tpl && item ? '<button id="cl-occ-del" class="cl-pill oc-del">Delete</button>' : ''}
      ${rec && rec.id ? '<button id="cl-rec-del" class="cl-pill oc-del">Delete</button>' : ''}
      ${flowMode && !ext ? '<button class="cl-pill" id="cl-trash">Trash <span class="cl-key">⌫</span></button>' : ''}
      ${ext && !tpl ? '<button id="cl-ext-done" class="cl-pill">Done</button>' : ''}
      <button id="cl-file">${rec ? (rec.id ? 'Save ⏎' : 'Add it ⏎')
        : tpl ? (item ? 'Save ⏎' : 'Add it ⏎') : flowMode && clarifyView.flow === 'now' ? 'Done ⏎'
        : ext ? 'Add it ⏎' : 'File it ⏎'}</button>
    </div>`;

  sheet.querySelectorAll('[data-dovar]').forEach(b => b.addEventListener('click', () => {
    clarifyView.doVariant = b.dataset.dovar;
    renderClarify();
  }));
  wireClarifyFlows(sheet);
  sheet.querySelectorAll('.cl-verb[data-verb]').forEach(b => b.addEventListener('click', () => {
    clarifyView.verb = b.dataset.verb;
    // Active is "no start date" — picking it after Defer has to clear the one
    // that was chosen, or the project files back into the same parked state.
    if (clarifyView.verb === 'active') clarifyView.showDate = '';
    renderClarify();
  }));
  sheet.querySelector('#cl-action').addEventListener('input', e => { clarifyView.action = e.target.value; });
  sheet.querySelectorAll('[data-recper]').forEach(b => b.addEventListener('click', () => {
    clarifyView.forRecurring.interval = parseInt(b.dataset.recper);
    renderClarify();
  }));
  sheet.querySelectorAll('[data-recact]').forEach(b => b.addEventListener('click', () => {
    clarifyView.forRecurring.active = b.dataset.recact === '1';
    renderClarify();
  }));
  const recAnchor = sheet.querySelector('#cl-rec-anchor');
  if (recAnchor) recAnchor.addEventListener('change', e => {
    clarifyView.forRecurring.anchor = e.target.value;
    renderClarify();
  });
  const recDue = sheet.querySelector('#cl-rec-due');
  if (recDue) recDue.addEventListener('change', e => {
    clarifyView.forRecurring.dueMd = recMdFromDate(e.target.value);
    renderClarify();
  });
  const recDueX = sheet.querySelector('#cl-rec-due-x');
  if (recDueX) recDueX.addEventListener('click', () => {
    clarifyView.forRecurring.dueMd = '';
    renderClarify();
  });
  const recDel = sheet.querySelector('#cl-rec-del');
  if (recDel) recDel.addEventListener('click', async () => {
    // A settings kind owes all three verbs, and this is the third. Occurrences
    // already filed are ordinary projects and are left alone — the same words
    // the se-sheet uses for a recurring task.
    if (!confirm('Delete this recurring project? Any already seeded stay.')) return;
    await apiSend(`/api/recurring/${clarifyView.forRecurring.id}`, 'DELETE');
    toast('Deleted');
    closeClarify();
  });
  sheet.querySelectorAll('.chip[data-tag]').forEach(b => {
    b.addEventListener('click', () => {
      const t = b.dataset.tag;
      if (clarifyView.tags.has(t)) clarifyView.tags.delete(t);
      else {
        // Estimates are exclusive: picking one duration unpicks the others.
        if (EST_TAGS.includes(t)) EST_TAGS.forEach(e => clarifyView.tags.delete(e));
        clarifyView.tags.add(t);
      }
      renderClarify();
    });
    // A DEVICE chip has a second verb: hand this capture to that machine's
    // inbox, undecided. Right-click on a mouse, 550ms long press on a finger —
    // both wired, neither replacing the other (touch parity).
    if (DEVICE_TAGS.includes(b.dataset.tag)) {
      b.title = `Long-press or right-click to send this to the ${b.dataset.tag} inbox, unclarified`;
      b.addEventListener('contextmenu', e => {
        e.preventDefault();
        handOffToDevice(b.dataset.tag);
      });
      onLongPress(b, () => handOffToDevice(b.dataset.tag));
    }
  });
  sheet.querySelectorAll('.chip[data-who]').forEach(b => b.addEventListener('click', () => {
    clarifyView.who = clarifyView.who === b.dataset.who ? '' : b.dataset.who;
    renderClarify();
  }));
  sheet.querySelectorAll('.chip[data-area]').forEach(b => {
    b.addEventListener('click', () => {
      // Letting go of an area files under nothing (domains are gone).
      const aid = parseInt(b.dataset.area);
      if (clarifyView.areaId === aid) {
        clarifyView.domainId = null;
        clarifyView.areaId = null;
      } else {
        clarifyView.areaId = aid;
        clarifyView.domainId = null;
      }
      renderClarify();
    });
  });

  const whoCustom = sheet.querySelector('#cl-who-custom');
  if (whoCustom) whoCustom.addEventListener('input', e => { clarifyView.who = e.target.value; });
  const tagNew = sheet.querySelector('#cl-tag-new');
  if (tagNew) tagNew.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.stopPropagation();
    const t = tagNew.value.trim().toLowerCase().replace(/^#/, '');
    if (!t) return;
    if (!clarifyView.tagVocab.includes(t)) clarifyView.tagVocab.push(t);
    clarifyView.tagVocab.sort();
    clarifyView.tags.add(t);
    renderClarify();
  });
  const showDate = sheet.querySelector('#cl-show-date');
  if (showDate) showDate.addEventListener('change', e => {
    clarifyView.showDate = e.target.value;
    clarifyView.calPick = '';
    // Typed over: it is this item's date now, not a carried-over suggestion.
    if (clarifyView.showDateFrom) { clarifyView.showDateFrom = ''; renderClarify(); }
  });
  const showDateX = sheet.querySelector('#cl-show-date-x');
  if (showDateX) showDateX.addEventListener('click', () => {
    clarifyView.showDate = '';
    clarifyView.showDateFrom = '';
    renderClarify();
  });
  const showTime = sheet.querySelector('#cl-show-time');
  if (showTime) showTime.addEventListener('change', e => {
    clarifyView.showTime = e.target.value;
    clarifyView.calPick = '';
    if (e.target.value && !clarifyView.showDate) clarifyView.showDate = wallDay();
    renderClarify();  // date autofill + the clear ✕ appearing/going
  });
  const showTimeX = sheet.querySelector('#cl-show-time-x');
  if (showTimeX) showTimeX.addEventListener('click', () => {
    clarifyView.showTime = '';
    clarifyView.calPick = '';
    renderClarify();
  });
  const chase = sheet.querySelector('#cl-chase');
  if (chase) chase.addEventListener('change', e => { clarifyView.chase = e.target.value; });
  const due = sheet.querySelector('#cl-due');
  if (due) due.addEventListener('change', e => { clarifyView.due = e.target.value; });
  const proj = sheet.querySelector('#cl-proj');
  if (proj) proj.addEventListener('click', () => { clarifyView.projSearch = ''; renderClarify(); });
  // A PROJECT's own sheet keeps what its GTD row used to offer: order its
  // actions, and arm the bar to add one. Removing them from the row was the
  // point; removing them from the app was not.
  const selfChain = sheet.querySelector('#cl-self-chain');
  if (selfChain) selfChain.addEventListener('click', async () => {
    await openComposeFor({ id: item.id, content: item.content, area_id: item.area_id }, 'pick');
  });
  const selfAdd = sheet.querySelector('#cl-self-add');
  if (selfAdd) selfAdd.addEventListener('click', () =>
    openClarifyNewAction(item, clarifyView.after));

  // A PROJECT YOU HAVE JUST NAMED IS UNCLARIFIED (2026-08-19, Quentin). It has
  // an outcome nobody has written, no deadline and none of the contexts its
  // actions will inherit — and the moment you know all three is the moment you
  // named it. So the sheet OFFERS it, the way every surface that creates an
  // action offers the same ›, and clarify still never opens by itself.
  //
  // The half-made decisions on this sheet are data: they are snapshotted and
  // put back when the project's sheet closes, so the detour costs nothing.
  const projOpen = sheet.querySelector('#cl-proj-open');
  if (projOpen) projOpen.addEventListener('click', async () => {
    const proj = (state.projects || []).find(x => x.id === clarifyView.projectId);
    if (!proj) return;
    const snap = clarifySnapshot();
    await openClarifyForItem(proj, async () => {
      // Whatever the project's sheet did to state.projects, the name shown
      // here comes from the snapshot's id — re-read so a rename shows.
      state.projects = await fetch('/api/projects').then(r => r.json()).catch(() => state.projects);
      clarifyRestore(snap);
      const again = (state.projects || []).find(x => x.id === clarifyView.projectId);
      if (again) clarifyView.projectName = again.content;
      renderClarify();
    });
  });
  const chainBtn = sheet.querySelector('#cl-proj-chain');
  if (chainBtn) chainBtn.addEventListener('click', async () => {
    const p = (state.projects || []).find(x => x.id === clarifyView.projectId);
    if (p) await openComposeFor(p, 'pick');
  });
  const notesTa = sheet.querySelector('#cl-notes');
  if (notesTa) {
    notesTa.addEventListener('input', e => {
      clarifyView.notes = e.target.value;
      autoGrowNotes(notesTa);
    });
    // Not autosave-wired (closeClarify owns the flush), so add the markdown
    // suite explicitly. insertText fires input, so the mirror above stays hot.
    wireMdShortcuts(notesTa);
    // ...and for the same reason the growth has to be asked for here: the
    // sizing rides wireNotesAutosave everywhere else, which this field
    // deliberately does not use.
    autoGrowNotes(notesTa);
  }
  // The chosen PROJECT's notes, editable right where you're filing into it.
  // Saves to the project on blur; the item's own notes are #cl-notes above.
  const pnBtn = sheet.querySelector('#cl-proj-notes-btn');
  if (pnBtn) pnBtn.addEventListener('click', () => {
    clarifyView.projNotesOpen = !clarifyView.projNotesOpen;
    renderClarify();
    if (clarifyView.projNotesOpen) sheet.querySelector('#cl-proj-notes')?.focus();
  });
  const pnTa = sheet.querySelector('#cl-proj-notes');
  if (pnTa) {
    let pnUndoPushed = false;
    const pnFlush = wireNotesAutosave(pnTa, async value => {
      const target = (state.projects || []).find(p => p.id === clarifyView.projectId);
      if (!target || value === (target.notes || '')) return;
      if (!pnUndoPushed) {
        pnUndoPushed = true;
        undoablePatch(target, ['notes'], `edited notes on "${target.content}"`);
      }
      await patchInboxItem(target.id, { notes: value });
      target.notes = value;
    });
    pnTa.addEventListener('blur', pnFlush);
    pnTa.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        pnFlush();
        clarifyView.projNotesOpen = false;
        renderClarify();
      }
    });
  }
  const trash = sheet.querySelector('#cl-trash');
  if (trash) trash.addEventListener('click', () => fileClarify('trash'));
  // Guarded like #cl-trash above: template mode drops the whole Or row, and an
  // unguarded querySelector here would throw before the sheet finished wiring.
  const todo = sheet.querySelector('#cl-todo');
  if (todo) todo.addEventListener('click', () => fileClarify('todo'));
  const someday = sheet.querySelector('#cl-someday');
  if (someday) someday.addEventListener('click', () => fileClarify('someday'));
  // Reference: the OTHER non-actionable keep. The pill reveals the list
  // chips; tapping a chip files immediately (exits are one gesture), and the
  // + input creates the list and files into it in the same stroke.
  const reference = sheet.querySelector('#cl-reference');
  if (reference) reference.addEventListener('click', clarifyToggleRef);
  const occDel = sheet.querySelector('#cl-occ-del');
  if (occDel) occDel.addEventListener('click', async () => {
    await apiSend(`/api/occasions/items/${item.id}`, 'DELETE');
    const back = clarifyView.after;
    closeClarify();
    if (back) back();
  });
  wireClarifyRef(sheet);
  sheet.querySelector('#cl-file').addEventListener('click', clarifyFile);
  const extDone = sheet.querySelector('#cl-ext-done');
  if (extDone) extDone.addEventListener('click', closeClarify);
  // ("Place in day" retired 2026-08-06: Show-on date+TIME is the one way a
  // clarify schedules into the day — no second pill for the same write.)
}

// Lexical relevance for the project search: word overlap (weighted) plus a
// character-bigram Dice score for the fuzzy tail. At this corpus size this IS
// semantic search — no embeddings, no network, instant.
function relScore(a, b) {
  const words = s => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(w => w.length > 2));
  const wa = words(a), wb = words(b);
  let overlap = 0;
  wa.forEach(w => { if (wb.has(w)) overlap++; });
  const grams = s => {
    const g = new Set(); const t = s.toLowerCase();
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const ga = grams(a), gb = grams(b);
  let inter = 0;
  ga.forEach(x => { if (gb.has(x)) inter++; });
  const dice = ga.size + gb.size ? 2 * inter / (ga.size + gb.size) : 0;
  return overlap * 2 + dice;
}

function renderClarifyProjSearch(sheet, item) {
  const q = (clarifyView.projSearch || '').toLowerCase();
  const matches = state.projects.filter(p => !q || p.content.toLowerCase().includes(q));
  const active = matches.filter(p => p.status !== 'on_hold');
  const dormant = matches.filter(p => p.status === 'on_hold');
  const byArea = {};
  active.forEach(p => { const k = p.area_name || '—'; (byArea[k] = byArea[k] || []).push(p); });

  // Before any typing, lead with the projects that look like THIS item — the
  // common case is that the right project shares its words with the capture.
  const seed = clarifyView.action.trim() || (item && item.content) || '';
  const best = !q && seed
    ? state.projects.filter(p => p.status !== 'on_hold')
        .map(p => [relScore(seed, p.content), p])
        .filter(([s]) => s >= 0.5)
        .sort((x, y) => y[0] - x[0])
        .slice(0, 3).map(([, p]) => p)
    : [];
  // Every row states its action count — the closest-matches and dormant rows
  // used to show only the area or the word 'dormant', so the one number that
  // says whether a project is stalled was missing from exactly the rows you
  // reach first.
  const countMeta = p => (p.action_count
    ? `${p.action_count} action${p.action_count === 1 ? '' : 's'}` : 'no next action');
  const bestHtml = best.length ? `
    <div class="cl-proj-group">Closest matches</div>
    ${best.map(p => `
      <button class="cl-proj-row" data-proj="${p.id}">
        <span class="cl-proj-name">${escHtml(p.content)}</span>
        <span class="cl-proj-meta${p.action_count ? '' : ' cl-proj-bad'}">${escHtml(p.area_name || '—')} · ${countMeta(p)}</span>
      </button>`).join('')}` : '';

  // Then the projects picked most recently — the area groups below sort
  // alphabetically, which is no sort at all when you're filing the fifth
  // capture into the same project. Semantic wins over recent (a match to
  // THIS item beats a habit), and typing anything replaces both with the
  // filter. Stale ids (completed/deleted projects) miss the lookup and drop.
  const bestIds = new Set(best.map(p => p.id));
  const recent = !q
    ? recentList('project')
        .map(id => state.projects.find(p => p.id === id))
        .filter(p => p && p.status !== 'on_hold' && !bestIds.has(p.id))
        .slice(0, 4)
    : [];
  const recentHtml = recent.length ? `
    <div class="cl-proj-group">Recently used</div>
    ${recent.map(p => `
      <button class="cl-proj-row" data-proj="${p.id}">
        <span class="cl-proj-name">${escHtml(p.content)}</span>
        <span class="cl-proj-meta${p.action_count ? '' : ' cl-proj-bad'}">${escHtml(p.area_name || '—')} · ${countMeta(p)}</span>
      </button>`).join('')}` : '';

  const rows = Object.keys(byArea).sort().map(area => `
    <div class="cl-proj-group">${escHtml(area)} · ${byArea[area].length} open</div>
    ${byArea[area].map(p => `
      <button class="cl-proj-row" data-proj="${p.id}">
        <span class="cl-proj-name">${escHtml(p.content)}</span>
        <span class="cl-proj-meta${p.action_count ? '' : ' cl-proj-bad'}">${
          p.action_count ? `${p.action_count} action${p.action_count === 1 ? '' : 's'}` : 'no next action'}</span>
      </button>`).join('')}`).join('');
  const dorm = dormant.length ? `
    <div class="cl-proj-group">Someday / maybe</div>
    ${dormant.map(p => `
      <button class="cl-proj-row" data-proj="${p.id}">
        <span class="cl-proj-name cl-proj-dormant">${escHtml(p.content)}</span>
        <span class="cl-proj-meta">dormant · ${countMeta(p)}</span>
      </button>`).join('')}` : '';

  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">Clarify · project</span>
      <span class="cl-spacer"></span>
      <span class="cl-hint">esc to go back</span>
    </div>
    <div class="cl-item">
      <div class="cl-proj-for">${escHtml(clarifyView.action.trim() || (item && item.content) || '')}</div>
      <div class="cl-captured">Which open loop does this belong to?</div>
    </div>
    <div class="cl-action-wrap cl-proj-search">
      <input type="text" id="cl-proj-q" class="cl-action" placeholder="⌕ filter, or name a new project" value="${escHtml(clarifyView.projSearch || '')}" autocomplete="off">
      <span class="cl-hint">${matches.length} of ${state.projects.length}</span>
    </div>
    ${q ? `<button class="cl-proj-row cl-proj-new" id="cl-proj-new">
      <span>+ New project — "${escHtml(clarifyView.projSearch)}"</span><span class="cl-key">⏎</span>
    </button>`
      // Always OFFERED, even with an empty box. The row used to appear only
      // once you had typed, and the placeholder said "type to filter" — so
      // the one surface that creates projects looked like it could only
      // search, and creating one meant guessing that the filter doubled as a
      // name field. Empty, it points at the input rather than naming the
      // project after the action: an outcome is not the action serving it,
      // which is why the old "this item becomes the project" exit was removed.
      : `<button class="cl-proj-row cl-proj-new cl-proj-new-empty" id="cl-proj-new-hint">
      <span>+ New project — name it above</span>
    </button>`}
    <div class="cl-proj-list">${bestHtml}${recentHtml}${rows}${dorm}</div>
    <button class="cl-proj-row" id="cl-proj-none">No project — file as a standalone action</button>`;

  const input = sheet.querySelector('#cl-proj-q');
  input.addEventListener('input', e => {
    clarifyView.projSearch = e.target.value;
    preserveCaret('cl-proj-q', renderClarify);
  });
  input.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.stopPropagation();
    const nq = input.value.trim();
    if (!nq) return;
    await clarifyCreateProject(nq);
  });
  const newBtn = sheet.querySelector('#cl-proj-new');
  if (newBtn) newBtn.addEventListener('click', () => clarifyCreateProject(clarifyView.projSearch.trim()));
  const newHint = sheet.querySelector('#cl-proj-new-hint');
  if (newHint) newHint.addEventListener('click', () => input.focus());
  sheet.querySelectorAll('.cl-proj-row[data-proj]').forEach(b => b.addEventListener('click', async () => {
    const p = state.projects.find(x => x.id === parseInt(b.dataset.proj));
    recentBump('project', p.id);
    clarifyView.projectId = p.id;
    clarifyView.projectName = p.content;
    clarifyView.projSearch = null;
    // Show what will ACTUALLY happen: filing under a project adopts that
    // project's area server-side, unconditionally. Leaving the Filing-to row
    // on some other area would display a destination the write overrides.
    clarifyView.areaId = p.area_id || null;
    clarifyView.domainId = p.area_id ? null : (p.domain_id || null);
    // Picking a project does NOT open the composer (Quentin, 2026-08-11).
    // It used to, whenever the project already had actions — but the composer
    // ALSO opens after filing, so ordering was asked twice per item: once
    // before you had finished clarifying, once after. The post-filing prompt
    // is the one that arrives when the order is actually in your head; this
    // one just interrupted the sheet. The ⛓ pill beside the project pill
    // stays as the explicit way in.
    renderClarify();
  }));
  sheet.querySelector('#cl-proj-none').addEventListener('click', () => {
    clarifyView.projectId = null;
    clarifyView.projectName = '';
    clarifyView.projSearch = null;
    renderClarify();
  });
}

// Creating a project is now exactly PICKING one that happens not to exist yet
// (Quentin, 2026-08-16). It used to be the breakdown flow: it filed the item as
// action [1], took it out of the queue and opened the composer on the spot. But
// naming a project is a filing decision, not a decision to decompose — and
// asking for the breakdown here interrupts the sheet mid-clarify, before you
// have picked a verb, exactly the way picking an existing project used to and
// stopped doing on 2026-08-11. So this fills the project in and returns you to
// the sheet you were already in; nothing is filed until you exit it normally.
// The composer is untouched and still reached the explicit way, the ⛓ pill.
async function clarifyCreateProject(name) {
  if (!name) return;
  const p = await apiSend('/api/projects', 'POST', { content: name, ...clarifyFiling() })
    .then(r => r.json());
  state.projects = await fetch('/api/projects').then(r => r.json());
  recentBump('project', p.id);
  clarifyView.projectId = p.id;
  clarifyView.projectName = p.content;
  clarifyView.projSearch = null;
  // A create inverts to a delete. The item is NOT filed here any more, so
  // there is nothing to restore — but if the sheet is still pointing at the
  // project when this runs, the selection has to let go of a row that is gone.
  pushUndo(`new project "${p.content}"`, async () => {
    await apiSend(`/api/inbox/${p.id}`, 'DELETE');
    if (clarifyView.projectId === p.id) {
      clarifyView.projectId = null;
      clarifyView.projectName = '';
    }
    await refreshAfterUndo();
  });
  renderClarify();
}

// Two ways in, and the difference is whether the item has been filed yet:
//   (no origin) — the post-filing hook, or the ⛓ pill: the item is already
//            filed, so leaving resumes the clarify queue.
//   'pick'  — you chose a project from the search and NOTHING has been filed;
//            leaving goes back to the main sheet so you still pick a verb.
//            Ordering the project's actions must not silently commit the item
//            you were clarifying.
// (The 'new' origin is gone as of 2026-08-16: creating a project no longer
// opens the composer at all, so there is no post-create entry to distinguish.)
async function openComposeFor(project, origin) {
  clarifyView.compose = {
    id: project.id, name: project.content,
    areaId: project.area_id || clarifyView.areaId || state.activeAreaId,
    actions: [], arm: null, origin,
  };
  await refreshCompose();
}

// The composer's action list is read back from the server so [n] positions and
// the blocked/unblocked state are the real ones, not a local guess.
async function refreshCompose() {
  if (!clarifyView.compose) return;
  const all = await apiGet('/api/map', []);
  clarifyView.compose.actions = all.filter(
    i => i.project_id === clarifyView.compose.id && i.kind !== 'project');
  renderClarify();
}

function renderClarifyCompose(sheet) {
  const c = clarifyView.compose;
  const nums = chainNumbers(c.actions);
  const byId = {};
  c.actions.forEach(a => { byId[a.id] = a; });
  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">Clarify · breaking down</span>
      <span class="cl-spacer"></span>
      <span class="cl-hint">esc when you're done</span>
    </div>
    <div class="cl-item">
      <div class="cl-proj-for">${escHtml(c.name)}</div>
      <div class="cl-captured">${c.origin === 'pick'
        ? 'Order what is already here, then keep clarifying — this item joins the project when you file it.'
        : 'What has to happen? Add the actions, then say which waits on which.'}</div>
    </div>
    <div class="cl-sec"><span class="cl-label">Actions</span>
      <span class="cl-hint">${c.arm != null ? 'now tap the action it comes AFTER'
        : 'drag one onto the one it comes after'}</span></div>
    <div class="cl-chain">
      ${c.actions.map(a => `
        <div class="cl-chain-row${c.arm === a.id ? ' cl-chain-armed' : ''}"
          draggable="true" data-id="${a.id}">
          ${nums[a.id] ? `<span class="cl-chain-n">[${nums[a.id]}]</span>`
            : '<span class="cl-chain-n cl-chain-free"></span>'}
          <span class="cl-chain-text">${escHtml(a.content)}</span>
          <span class="cl-chain-tags">${(a.tags || '').split(' ').filter(Boolean)
            .map(t => `<span class="map-tag">${escHtml(t)}</span>`).join('')}${
            dueOf(a) ? dueChip(a, 'badge') : ''}</span>
          ${a.after_id ? `<button class="cl-chain-x" data-id="${a.id}"
            title="Unchain — it stops waiting on ${escHtml((byId[a.after_id] || {}).content || 'that')}">✕</button>` : ''}
          <button class="cl-chain-go" data-go="${a.id}"
            title="Clarify this action — contexts, due, show-on, notes">›</button>
        </div>`).join('')
        || emptyHtml('No actions yet — type the first one below.')}
    </div>
    <div class="cl-action-wrap">
      <input type="text" id="cl-compose-add" class="cl-action"
        placeholder="+ add an action…" autocomplete="off">
    </div>
    <div class="cl-row">
      <button class="cl-pill cl-pill-on" id="cl-compose-done">${
        c.origin === 'pick' ? 'Back to clarify' : 'Done'}<span class="cl-key">⏎⏎</span></button>
    </div>`;

  // THE RULE: an action created here is clarifiable here. A new action used
  // to be bare text — no contexts, no due, no show-on, no notes — and the
  // only way to reach those was to leave, find it on another surface and open
  // the sheet from there. `›` opens the SAME clarify sheet for that action
  // and returns to the composer when it closes, so the breakdown is not lost.
  // Clarify does NOT open on creation: the composer's whole rhythm is "one
  // more, one more, done", and a sheet after every Enter would end it.
  sheet.querySelectorAll('.cl-chain-go').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const action = byId[btn.dataset.go];
      if (!action) return;
      const saved = { id: c.id, name: c.name, areaId: c.areaId };
      openClarifyForItem(action, async () => {
        clarifyView.compose = { ...saved, actions: [], arm: null };
        clarifyView.open = true;
        clarifyView.single = false;
        showSheet('clarify-sheet');
        document.getElementById('engage-body').classList.add('eg-dimmed');
        await refreshCompose();
      });
    });
  });

  const add = sheet.querySelector('#cl-compose-add');
  add.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    // stopPropagation, or the sheet's document-level Enter files the item.
    e.stopPropagation();
    const raw = add.value.trim();
    // Enter on an EMPTY field is the way out — the same "one more, one more,
    // done" rhythm the bar's rapid entry has.
    if (!raw) { closeCompose(); return; }
    add.value = '';
    const { content, tags } = parseTags(raw);
    const created = await apiSend('/api/inbox', 'POST', { content, status: 'active', area_id: c.areaId,
                             project_id: c.id, tags: tags.join(' ') }).then(r => r.json());
    pushUndo(`added "${content}"`, async () => {
      await apiSend(`/api/inbox/${created.id}`, 'DELETE');
      await refreshAfterUndo();
      if (clarifyView.compose) await refreshCompose();
    });
    await refreshCompose();
    document.getElementById('cl-compose-add').focus();
  });
  add.focus();

  // Dependencies, in the chain editor's own grammar (drag, or tap-arm then tap
  // the predecessor) — one editor's gesture vocabulary, two places.
  const link = async (fromId, toId) => {
    if (fromId === toId) return;
    const it = byId[fromId];
    if (!it) return;
    // Refuse a loop client-side; update_inbox_item no-ops it server-side too.
    let cur = byId[toId];
    const seen = new Set();
    while (cur && cur.after_id && !seen.has(cur.id)) {
      if (cur.after_id === fromId) { toast('That would make a loop'); return; }
      seen.add(cur.id);
      cur = byId[cur.after_id];
    }
    undoablePatch(it, ['after_id'], `chained "${it.content}"`);
    await apiSend(`/api/inbox/${fromId}`, 'PATCH', { after_id: toId });
    c.arm = null;
    await refreshCompose();
  };
  sheet.querySelectorAll('.cl-chain-row').forEach(rw => {
    const id = parseInt(rw.dataset.id);
    rw.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', String(id));
      e.dataTransfer.effectAllowed = 'link';
    });
    rw.addEventListener('dragover', e => e.preventDefault());
    rw.addEventListener('drop', e => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData('text/plain'));
      if (from) link(from, id);
    });
    rw.addEventListener('click', e => {
      if (e.target.classList.contains('cl-chain-x')) return;
      if (c.arm == null || c.arm === id) { c.arm = c.arm === id ? null : id; renderClarify(); }
      else link(c.arm, id);
    });
  });
  sheet.querySelectorAll('.cl-chain-x').forEach(b => b.addEventListener('click', async () => {
    const id = parseInt(b.dataset.id);
    const it = byId[id];
    undoablePatch(it, ['after_id'], `unchained "${it.content}"`);
    await apiSend(`/api/inbox/${id}`, 'PATCH', { after_id: null });
    await refreshCompose();
  }));
  sheet.querySelector('#cl-compose-done').addEventListener('click', closeCompose);
}

// Leaving the composer resumes the clarify cycle where it left off: the item
// that started it is already filed, so this is the next capture (or the
// external step, or the end).
function closeCompose() {
  const origin = clarifyView.compose && clarifyView.compose.origin;
  clarifyView.compose = null;
  clarifyView.projSearch = null;
  // 'pick': the item is still unfiled and still yours to decide on.
  if (origin === 'pick') { renderClarify(); return; }
  if (clarifyView.single) { closeClarify(); return; }
  if (clarifyView.queue.length) clarifyResetItem();
  else { clarifyView.external = true; clarifyResetItem(); }
  renderClarify();
  refreshEngage();
}

// Keyboard: the whole inbox can be emptied without the mouse. Typing fields
// keep their keys; Enter files from the main sheet.
document.addEventListener('keydown', e => {
  if (!clarifyView.open || (clarifyView.picking && clarifyView.picking.hidden)) return;
  const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  // Both sub-views own their own keys — the composer's Enter adds an action.
  if (clarifyView.projSearch != null || clarifyView.compose) return;
  // Enter files from ANY field — the two inputs where Enter means something
  // local (new tag, project query) stopPropagation before this handler, and
  // the notes textarea keeps Enter as a newline.
  if (e.key === 'Enter') {
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    clarifyFile();
    return;
  }
  if (typing) return;
  // A template has no verbs and no exits, so it has no verb keys either —
  // otherwise D/G/S/⌫ would silently mean Save on a sheet that shows no such
  // button. Enter (above) is the one key it keeps, and that IS the Save.
  if (clarifyView.forOccasion) return;
  const k = e.key.toLowerCase();
  if (clarifyFlowMode()) {
    const f = CLARIFY_FLOWS.find(x => x.k.toLowerCase() === k);
    if (f && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setClarifyFlow(f.key); }
    else if (e.key === 'Backspace' && !clarifyView.external) { e.preventDefault(); fileClarify('trash'); }
    return;
  }
  // A project's keys mirror its verbs. Backspace SELECTS trash rather than
  // firing it: deleting a project takes its actions with it a level up, which
  // is more than one keystroke should do on its own.
  if (clarifyView.project && !clarifyView.external) {
    if (k === 'a') { clarifyView.verb = 'active'; clarifyView.showDate = ''; renderClarify(); }
    else if (k === 'f') { clarifyView.verb = 'defer'; renderClarify(); }
    else if (e.key === 'Backspace') { e.preventDefault(); clarifyView.verb = 'trash'; renderClarify(); }
    else if (k === 's') { fileClarify('someday'); }
    else if (k === 'r') clarifyToggleRef();
    return;
  }
  if (k === 'd') { clarifyView.verb = 'do'; clarifyView.doVariant = 'done'; renderClarify(); }
  else if (k === 'i') { clarifyView.verb = 'do'; clarifyView.doVariant = 'progress'; renderClarify(); }
  else if (k === 'g') { clarifyView.verb = 'delegate'; renderClarify(); }
  else if (k === 'f') { clarifyView.verb = 'defer'; renderClarify(); }
  else if (k === 's') { fileClarify('someday'); }
  else if (k === 't') { fileClarify('todo'); }
  else if (k === 'r') clarifyToggleRef();
  else if (e.key === 'Backspace') { e.preventDefault(); fileClarify('trash'); }
});

// ── Offline (service worker + the stale marker) ───────────────
//
// Registration needs a SECURE CONTEXT, which is the whole reason `tailscale
// serve` exists in deploy/ORACLE.md: over plain http://<host>:5000 this is a
// silent no-op, and the app behaves exactly as it did before. Over
// https://<host>.<tailnet>.ts.net (and over localhost, so pywebview local mode
// counts) the worker installs and the day survives with no network.
//
// The marker is driven by the worker itself rather than by navigator.onLine,
// which lies in the direction that matters: it reports true on a WiFi network
// that has no route out, which is a captive portal or dead uplink — precisely
// when you are looking at yesterday's day and being told it is today's.
function initOffline() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'pt-stale') markStale(true);
  });
  // A page that LOADS offline gets no 'offline' event — there was no transition
  // to fire one — and that is the common case: you open the app on the train.
  if (!navigator.onLine) markStale(true);
  window.addEventListener('offline', () => markStale(true));
  window.addEventListener('online', async () => {
    markStale(false);
    toast('Back online');
    // Engage IS the home screen (9c), so it is always the thing to re-render.
    await loadAll();
    await refreshEngage();
  });
}

let staleShown = false;

function markStale(on) {
  if (on === staleShown) return;
  staleShown = on;
  let el = document.getElementById('pt-stale');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pt-stale';
    el.textContent = 'Offline · last synced day';
    document.body.appendChild(el);
  }
  el.classList.toggle('stale-on', on);
  // The marker is fixed to the top of the viewport, so the app has to give up
  // exactly its height or it covers the date header. Measured, not assumed: on
  // a notched iPhone in standalone the safe-area inset makes it much taller.
  document.body.classList.toggle('pt-stale', on);
  document.documentElement.style.setProperty('--stale-h', on ? el.offsetHeight + 'px' : '0px');
}

initOffline();
