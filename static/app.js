// Minutes in a day. The one spelling of the wrap — see the semantic
// minutes block further down for spanEndMin / windowEndMin / clockHHMM.
// Declared HERE because `const` has no hoisting and state.view uses it.
const DAY_MIN = 1440;

// ── Theme ─────────────────────────────────────────────────────
// The setting table is the source of truth (it lands in state.settings with
// everything else), but it arrives a fetch late — long enough to paint the
// dark theme first and flash. So the choice is mirrored into localStorage and
// read synchronously here, before the first paint, with the fetched value
// reconciling it afterwards. Only the MAIN window has a theme: the NOW panel
// is its own document and is deliberately light always.
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.classList.toggle('theme-light', light);
  const label = document.getElementById('theme-label');
  if (!label) return;  // called before the shell parses on the pre-paint pass
  label.textContent = light ? 'Light' : 'Dark';
  document.getElementById('theme-icon-sun').classList.toggle('hidden', !light);
  document.getElementById('theme-icon-moon').classList.toggle('hidden', light);
}

applyTheme(localStorage.getItem('theme') || 'dark');

function initThemeToggle() {
  applyTheme(localStorage.getItem('theme') || 'dark');  // now that the icons exist
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
  // Engage's eye says which state the panel is in, not just that a panel
  // exists — patched in place rather than through renderEngage, so toggling
  // never repaints the day (or the focused capture input under it).
  const eg = document.getElementById('eg-panel-btn');
  if (eg && window.pywebview) {
    eg.innerHTML = panelEyeSvg(hidden);
    eg.title = hidden ? 'NOW panel — off' : 'NOW panel';
  }
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
  sheetsInbox: [],
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
  review: { due: null, last: {} },
  accountabilityNodes: null,
  qrPageOverrides: {},
  qrDismissed: {},
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
  // Right-click day-level view dismissals: blocks/qr keyed `id:date`, events
  // keyed `uid|start`. Undo lives on the global stack (see pushUndo).
  tlHidden: { block: {}, event: {}, qr: {} },
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
  const [blocks, projects, domains, gcal, overrides, inbox, sheetsInbox, reviewStatus, accountabilityNodes, calendars, settings, qrOutcomes, dismissals, locations, tagLocations, tagDevices, tagTimes, tagDaily, viewSegments] = await Promise.all([
    apiGet('/api/blocks', state.blocks),
    apiGet('/api/areas', state.areas),
    apiGet('/api/domains', state.domains),
    apiGet('/api/gcal', state.gcalEvents),
    apiGet(`/api/overrides?date=${dateStr}`, state.overrides),
    apiGet('/api/inbox', state.inbox),
    apiGet('/api/sheets/inbox', state.sheetsInbox),
    apiGet('/api/gtd-review', ({})),
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
  ]);

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
  state.sheetsInbox = sheetsInbox;
  // The nav dot means "this week's review isn't filed yet".
  state.review = { due: !reviewStatus.completed_at };
  state.accountabilityNodes = Array.isArray(accountabilityNodes) ? accountabilityNodes : [];
  state.calendars = calendars;
  state.settings = settings;
  paintPanelToggle(settings.panel_hidden === '1');
  // The db is authoritative; the localStorage mirror only exists to beat the
  // flash, so re-sync it in case another window (or a restore) changed it.
  if (settings.theme) {
    localStorage.setItem('theme', settings.theme);
    applyTheme(settings.theme);
  }
  state.qrOutcomes = {};
  (Array.isArray(qrOutcomes) ? qrOutcomes : []).forEach(o => { state.qrOutcomes[`${o.node_id}:${o.date}`] = o.outcome; });
  state.tlHidden = { block: {}, event: {}, qr: {} };
  (Array.isArray(dismissals) ? dismissals : []).forEach(d => {
    if (!state.tlHidden[d.type]) return;
    state.tlHidden[d.type][d.key] = true;
  });
  state.lastFetched = new Date();

  const activeBlock = detectCurrentStandardBlock();
  state.activeBlock = activeBlock;
  state.section2OverrideDomainId = null;
  state.section2OverrideItems = null;
  const defaultArea = state.areas.find(p => p.is_default && p.active && p.type === 'standard');
  const activeAreaId = activeBlock ? activeBlock.area_id : (defaultArea ? defaultArea.id : null);
  state.activeAreaId = activeAreaId;
  state.activeDomainId = domainIdForArea(activeAreaId);
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

  updateReviewNavDot();
  renderAll();
}

function renderAll() {
  renderTimeline();
  renderSheetsInbox();
  renderInbox();
}

function updateReviewNavDot() {
  // The due dot rides on the hub's LISTS icon and the review fold-out header —
  // the review moved into Lists when the GTD tab went (2026-08-16).
  ['hub-lists-btn', 'gtd-review-head'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('has-due', !!state.review.due);
  });
  const prog = document.getElementById('gtd-review-prog');
  if (prog && gtdReview) {
    const ticks = reviewTicks();
    const steps = reviewSteps();
    prog.textContent = steps.length
      ? `${steps.filter(s => ticks[s.id]).length}/${steps.length}` : '';
  }
}

// ── Timeline ─────────────────────────────────────────────────

let fetchFailed = false;
let currentTimeTick = null;

function renderTimeline() {
  renderReviewPassBar();
  state.view = computeViewWindow();
  renderGrid();
  renderDateLabel();
  renderAlldayStrip();
  const bodyH = document.getElementById('tl-body').clientHeight || 600;
  renderBlocksLayer(bodyH);
  renderGcalLayer(bodyH);
  renderQrLayer();
  updateCurrentTimeLine();
  updateFetchStatus();
  startCurrentTimeTick();
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

function onLongPress(el, fn) {
  let t = null, sx = 0, sy = 0, fired = false;
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
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
function onPointerDrag(el, spec) {
  let t = null, live = null, sy = 0, pid = null, prevTouch = '';

  const release = () => {
    clearTimeout(t); t = null;
    if (prevTouch !== null) el.style.touchAction = prevTouch;
    if (pid != null && el.hasPointerCapture && el.hasPointerCapture(pid)) {
      el.releasePointerCapture(pid);
    }
    pid = null;
  };

  const arm = e => {
    live = spec.start(e);
    if (!live) { release(); return; }
    sy = e.clientY;
    pid = e.pointerId;
    prevTouch = el.style.touchAction;
    el.style.touchAction = 'none';
    try { el.setPointerCapture(pid); } catch (err) { /* capture is a nicety */ }
  };

  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') { arm(e); if (live) e.preventDefault(); return; }
    // Touch: hold still for 550ms to grab it.
    sy = e.clientY;
    const sx = e.clientX;
    // The watchers live on DOCUMENT, not on el, and the timer checks that the
    // finger is still down. Both because a finger that slides off the row — or
    // lifts off it — fires neither move nor up on el, so the timer used to arm
    // a drag for a touch that was already over: `touch-action: none` and a
    // preventDefaulting pointermove handler left behind, which is a page that
    // has stopped scrolling for no reason the user can see.
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
    };
    t = setTimeout(() => { t = null; if (down) arm(e); }, 550);
    document.addEventListener('pointermove', cancelOnMove);
    ['pointerup', 'pointercancel'].forEach(ev =>
      document.addEventListener(ev, stop, { once: true }));
  });

  document.addEventListener('pointermove', e => {
    if (!live) return;
    e.preventDefault();
    live.move(e.clientY);
  }, { passive: false });

  ['pointerup', 'pointercancel'].forEach(ev =>
    document.addEventListener(ev, e => {
      if (!live) return;
      const done = live;
      live = null;
      release();
      done.end(e.clientY, e);
    }));

  // A long press that became a drag must not also fire the element's click.
  el.addEventListener('click', e => {
    if (el.dataset.lpDragged === '1') {
      delete el.dataset.lpDragged;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
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
  const pageDow = jsDateToDayOfWeek(state.currentDate);
  const deadlineMin = (node) => {
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
  return { start, end };
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

function renderDateLabel() {
  const el = document.getElementById('tl-date-label');
  // The weekday is what you read; the date is what you check. Two weights, the
  // design's — and the date in mono so the digits line up as you page through.
  if (el) {
    const d = state.currentDate;
    el.innerHTML = `<span class="tl-dow">${escHtml(_WEEKDAYS_LONG[d.getDay()])}</span>`
      + `<span class="tl-dm">${d.getDate()} ${escHtml(_MONTHS_SHORT[d.getMonth()])}</span>`;
  }
  updateNavButtons();
}

function updateNavButtons() {
  const diff = dayOffset(state.currentDate);
  const prev = document.getElementById('nav-prev');
  const next = document.getElementById('nav-next');
  const bounds = navBounds();
  if (prev) prev.disabled = diff <= bounds.min;
  if (next) next.disabled = diff >= bounds.max;
}


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
  const segments = viewSegmentsFor(dateStr).map(segmentRow);

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

  const blocksHtml = visible.map(({ b, top, height, cancelled, label, cont, startMin, endMin }) => {
    const proj = b.area_id ? projectsById[b.area_id] : null;
    const tight = (height * bodyH / 100) < 18;
    const labelSpan = `<span class="tl-block-label${cancelled ? ' tl-cancelled-text' : ''}">${escHtml(label)}</span>`;
    const locLabel = b.location_name ? `<span class="tl-block-sublabel">📍︎ ${escHtml(b.location_name)}</span>` : '';
    const inner = `<div class="tl-block-bar"></div>${labelSpan}${proj ? `<span class="tl-block-sublabel">${escHtml(proj.name)}</span>` : ''}${locLabel}`;
    return `<div class="tl-block${cancelled ? ' tl-block-cancelled' : ''}${cont ? ' tl-block-cont' : ''}${tight ? ' tl-event-tight' : ''}"
                 data-block-id="${b.id}" data-start-min="${startMin}" data-end-min="${endMin}"
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

  layer.querySelectorAll('.tl-block:not(.tl-block-cont)').forEach(el => {
    el.addEventListener('click', () => toggleBlockOverride(parseInt(el.dataset.blockId)));
  });

  layer.querySelectorAll('.tl-block').forEach(el => {
    const hide = () => {
      hideTimelineItem('block', `${el.dataset.blockId}:${dateStr}`,
        el.querySelector('.tl-block-label')?.textContent || 'Block');
      renderTimeline();
    };
    el.addEventListener('contextmenu', e => { e.preventDefault(); hide(); });
    onLongPress(el, hide);   // the touch right-click
  });

  initBlockBarDrag(layer, dateStr);
}

// The color bar is the manipulation surface (mirrors gate pills): top/bottom
// edges resize, the middle moves the whole block — each writes a one-day
// override on drop. Block defaults stay in the Block Editor.
function initBlockBarDrag(layer, dateStr) {
  const body = document.getElementById('tl-body');
  layer.querySelectorAll('.tl-block:not(.tl-block-cont):not(.tl-block-cancelled) .tl-block-bar').forEach(bar => {
    const blockEl = bar.parentElement;
    const blockId = parseInt(blockEl.dataset.blockId);
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
      const span = state.view.end - state.view.start;
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
      const bodyPx = body.getBoundingClientRect().height;
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
          curS = Math.min(Math.max(state.view.start, origStart + deltaMin), state.view.end - len);
          curE = curS + len;
        } else if (mode === 'start') {
          curS = Math.min(Math.max(state.view.start, origStart + deltaMin), origEnd - 15);
        } else {
          curE = Math.max(Math.min(state.view.end, origEnd + deltaMin), origStart + 15);
        }
        blockEl.style.top = `${Math.max(0, minutesToViewPercent(curS))}%`;
        blockEl.style.height = `${Math.min(100, minutesToViewPercent(curE)) - Math.max(0, minutesToViewPercent(curS))}%`;
      }

      async function onUp() {
        document.body.style.cursor = '';
        if (!moved || (curS === origStart && curE === origEnd)) { renderTimeline(); return; }
        const res = await apiSend('/api/overrides', 'POST', {
            block_id: blockId, date: dateStr, cancelled: false,
            start_time: clockHHMM(curS),
            end_time: clockHHMM(curE),
          });
        if (res.ok) {
          const data = await res.json();
          const idx = state.overrides.findIndex(o => o.block_id === blockId && o.date === dateStr);
          if (idx !== -1) state.overrides[idx] = data; else state.overrides.push(data);
          // The times on screen are the SERVER's resolution of this day, so a
          // dropped block moves once the day is re-resolved — not when the
          // local override array is patched.
          await fetchOverridesForDate(state.currentDate);
        }
        renderTimeline();
      }

      document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ns-resize';
      return { move: onMove, end: onUp };
    } });
  });
}

function renderAlldayStrip() {
  const strip = document.getElementById('tl-allday-strip');
  if (!strip) return;
  const dayEvents = state.gcalEvents.filter(e => e.allday && sameDay(state.currentDate, e.start));
  strip.innerHTML = dayEvents.map(e => {
    const col = e.color || '#888888';
    // The calendar's hue is handed to CSS as a variable; what is DONE with it
    // — the fill, the rule, and how far the text is pulled toward legibility —
    // belongs to the theme. It used to be mixed 50% with a hardcoded #fff
    // here, which reads on the dark surface and is invisible on the light one.
    return `<div class="tl-allday-event" style="--ev-color:${col}">${escHtml(e.summary || '')}</div>`;
  }).join('');
}

// The height of the row that names an event — what two titles need between
// them to be two titles rather than one smear. Matched to .tl-event-row.
const EVENT_ROW_PX = 19;

function renderGcalLayer(bodyH = 600) {
  const layer = document.getElementById('tl-gcal-layer');
  if (!layer) return;
  layer.style.pointerEvents = 'none';
  const isoMin = iso => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };
  const nextDate = new Date(state.currentDate.getTime() + 86400000);
  // Next-day events count when the view runs past midnight (sleep +1d)
  const dayEvents = state.gcalEvents.filter(e => !e.allday &&
    !state.tlHidden.event[`${e.uid}|${e.start}`] &&
    (sameDay(state.currentDate, e.start) || (state.view.end > DAY_MIN && sameDay(nextDate, e.start))));
  // TWO TITLES MAY NOT SHARE A LINE. Events are positioned by their start, so
  // two that begin at the same minute land at the same top and print over each
  // other — the day showed one smear of overlapping letters and neither event
  // could be read. Boxes are allowed to overlap (that IS the day: a meeting
  // inside a longer block); what cannot overlap is the row that names them.
  //
  // So the tops are walked in order and any one that would land within a row
  // of the previous is pushed just below it. Only a collision moves anything:
  // events far enough apart keep the position their time gives them, and the
  // BOTTOM never moves, so an event still ends when it ends.
  const rowPct = (EVENT_ROW_PX / Math.max(bodyH, 1)) * 100;
  const boxes = [];
  for (const e of dayEvents) {
    const base = sameDay(nextDate, e.start) ? DAY_MIN : 0;
    const startMin = base + isoMin(e.start);
    let endMin = base + isoMin(e.end);
    if (endMin <= startMin) endMin += DAY_MIN;
    const top = Math.max(0, minutesToViewPercent(startMin));
    const bottom = Math.min(100, minutesToViewPercent(endMin));
    if (bottom - top <= 0) continue;
    boxes.push({ e, startMin, top, bottom });
  }
  boxes.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  let lastTop = -Infinity;
  for (const box of boxes) {
    if (box.top < lastTop + rowPct) box.top = lastTop + rowPct;
    lastTop = box.top;
  }

  layer.innerHTML = boxes.map(({ e, top, bottom }) => {
    const height = Math.max(bottom - top, 2);
    const tight = (height * bodyH / 100) < 18;
    const timeStr = `${isoToAmPm(e.start)}–${isoToAmPm(e.end)}`;
    const inner = `<div class="tl-event-row"><span class="tl-event-summary">${escHtml(e.summary || '')}</span><span class="tl-event-time">${escHtml(timeStr)}</span></div>`;
    const col = e.color || '#888888';
    const key = `${e.uid}|${e.start}`;
    return `<div class="tl-gcal-event${tight ? ' tl-event-tight' : ''}" data-ev-key="${escHtml(key)}" data-ev-label="${escHtml(e.summary || 'Event')}" style="pointer-events:auto;top:${top}%;height:${height}%;--ev-color:${col}">${inner}</div>`;
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
    // Same plain-tap meaning as the event row on Engage: open its occasion.
    el.addEventListener('click', () => openOccasionSheet(el.dataset.evLabel || ''));
  });
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
  if (gcalResult.status === 'fulfilled') state.gcalEvents = gcalResult.value;
  else fetchFailed = true;
  if (sheetsResult.status === 'fulfilled') state.sheetsInbox = sheetsResult.value;
  if (outcomesResult.status === 'fulfilled' && Array.isArray(outcomesResult.value)) {
    state.qrOutcomes = {};
    outcomesResult.value.forEach(o => { state.qrOutcomes[`${o.node_id}:${o.date}`] = o.outcome; });
  }
  if (!fetchFailed) localStorage.setItem('lastExternalRefresh', Date.now().toString());
  state.lastFetched = new Date();
  renderTimeline();
  renderSheetsInbox();
  refreshEngage();
}

// ── The review pass ──────────────────────────────────────────
//
// "Review previous calendar, 2-3 weeks back" is a reading you do IN the
// calendar, not a list to be drained — the window is a trigger list, and
// re-reading the same fortnight next week is the mechanism, not waste. So the
// pass is a MODE over the existing timeline rather than a new surface: it
// widens the nav bound for its duration, drops you at the far end, and ends
// when you reach the other.
//
// The metadata overlaid on each day is the count of what you CAPTURED that
// day. A day with events and no captures is the shape of a missed follow-up,
// which is exactly what this step hunts for.
function startReviewPass(step) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const iso = d => formatDateYMD(d);
  const back = step === 'cal_back';
  const from = new Date(today.getTime() + (back ? -14 : 0) * 86400000);
  const to = new Date(today.getTime() + (back ? 0 : 14) * 86400000);
  reviewPass.active = true;
  reviewPass.step = step;
  reviewPass.from = iso(from);
  reviewPass.to = iso(to);
  state.currentDate = new Date(from);
  fetchOverridesForDate(state.currentDate).then(() => {
    openM('cal-overlay');
    renderTimeline();
    renderSheetsInbox();
  });
}

async function returnToReview() {
  closeM('cal-overlay');
  openM('tab-lists');
  refView.open = null;
  refView.openFlow = null;
  await refreshRef();
  await openGtdReview();
}

function endReviewPass() {
  reviewPass.active = false;
  reviewPass.step = null;
  const bar = document.getElementById('rp-bar');
  if (bar) bar.remove();
  // Snap back inside the everyday window, or the timeline is left somewhere
  // its own buttons cannot reach.
  const off = dayOffset(state.currentDate);
  if (off < -3 || off > 3) {
    state.currentDate = new Date();
    fetchOverridesForDate(state.currentDate).then(renderTimeline);
  }
}

function renderReviewPassBar() {
  const host = document.getElementById('cal-overlay');
  let bar = document.getElementById('rp-bar');
  if (!reviewPass.active) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'rp-bar';
    host.insertBefore(bar, host.querySelector('#cal-strips'));
  }
  const b = navBounds();
  const off = dayOffset(state.currentDate);
  const total = b.max - b.min + 1;
  const nth = off - b.min + 1;
  const atEnd = off >= b.max;
  const dateStr = viewDay();
  // What you captured that day. captured_at is SQLite UTC with a space.
  const captured = (engageView.allItems || []).filter(i =>
    ((i.captured_at || '').replace(' ', 'T')).slice(0, 10) === dateStr).length;
  const events = (state.gcalEvents || []).filter(
    e => (e.start || '').slice(0, 10) === dateStr).length;

  bar.className = atEnd ? 'rp-bar rp-bar-end' : 'rp-bar';
  bar.innerHTML = `
    <span class="rp-step">${reviewPass.step === 'cal_back' ? 'Reviewing back' : 'Reviewing ahead'}</span>
    <span class="rp-prog">day ${nth}/${total}</span>
    <span class="rp-meta">${events} event${events === 1 ? '' : 's'} · ${
      captured} captured${events && !captured ? ' ⚠' : ''}</span>
    <span class="cl-spacer"></span>
    ${atEnd
      ? '<button id="rp-done">Mark reviewed ✓</button>'
      : '<button id="rp-next">Next day →</button>'}
    <button id="rp-quit" title="Leave without marking it done">✕</button>`;

  const next = bar.querySelector('#rp-next');
  if (next) next.addEventListener('click', () => document.getElementById('nav-next').click());
  bar.querySelector('#rp-quit').addEventListener('click', async () => {
    endReviewPass();
    await returnToReview();
  });
  const done = bar.querySelector('#rp-done');
  if (done) done.addEventListener('click', async () => {
    // Arriving at today is not the same as having done the reading, so the
    // tick is a button rather than automatic.
    const step = reviewPass.step;
    if (gtdReview) {
      gtdReview = await apiSend('/api/gtd-review/step', 'POST', { week: gtdReview.week_start_date, step, done: true }).then(r => r.json());
    }
    endReviewPass();
    // Back to where the pass was started from. openM shows one overlay at a
    // time, so the calendar had hidden GTD — closing it alone would drop you
    // on the day screen with the review you were halfway through gone.
    await returnToReview();
  });
}

function initTimeline() {
  document.getElementById('nav-prev').addEventListener('click', async () => {
    if (dayOffset(state.currentDate) <= navBounds().min) return;
    state.currentDate = new Date(state.currentDate.getTime() - 86400000);
    await fetchOverridesForDate(state.currentDate);
    renderTimeline();
  });
  document.getElementById('nav-next').addEventListener('click', async () => {
    if (dayOffset(state.currentDate) >= navBounds().max) return;
    state.currentDate = new Date(state.currentDate.getTime() + 86400000);
    await fetchOverridesForDate(state.currentDate);
    renderTimeline();
  });
  document.getElementById('nav-today').addEventListener('click', async () => {
    state.currentDate = new Date();
    await fetchOverridesForDate(state.currentDate);
    renderTimeline();
  });
  document.getElementById('refresh-btn').addEventListener('click', refreshExternal);
  document.getElementById('tl-add-event').addEventListener('click', openEvSheet);

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
  const [overrides, segments] = await Promise.all([
    apiGet(`/api/overrides?date=${dateStr}`, state.overrides),
    apiGet(`/api/blocks/day?date=${dateStr}&all=1`, []),
  ]);
  state.overrides = overrides;
  state.viewSegments = { date: dateStr, segments };
}

// The segments for the day being looked at, or nothing if the cache holds
// another day — a stale answer keyed by the wrong date is the bug this shape
// exists to prevent, so it reports empty rather than guessing.
function viewSegmentsFor(dateStr) {
  return state.viewSegments && state.viewSegments.date === dateStr
    ? state.viewSegments.segments : [];
}

// One segment as the renderers want it: the day question is the SERVER's, the
// cosmetic join (which location is that id) stays here.
function segmentRow(s) {
  const cont = s.start < 0;                       // yesterday's overnight tail
  const loc = (state.locations || []).find(l => String(l.id) === String(s.location_id));
  return {
    b: { id: s.block_id, area_id: s.area_id, color: s.color,
         location_name: loc ? loc.name : null },
    startMin: cont ? 0 : s.start,
    endMin: s.end,
    cancelled: !!s.cancelled,
    label: s.label + (cont ? ' (cont.)' : ''),
    cont,
  };
}

async function toggleBlockOverride(blockId) {
  const dateStr = viewDay();
  const existing = state.overrides.find(o => o.block_id === blockId && o.date === dateStr);
  const hasTimes = existing && (existing.start_time || existing.end_time);

  if (existing && existing.cancelled === 1 && !hasTimes) {
    // un-cancel with nothing else on the row — drop it
    const saved = existing;
    const idx = state.overrides.indexOf(existing);
    state.overrides.splice(idx, 1);
    markSegmentCancelled(blockId, dateStr, false);
    renderTimeline();
    try {
      const res = await apiSend(`/api/overrides/${saved.id}`, 'DELETE');
      if (!res.ok) throw new Error();
      await fetchOverridesForDate(state.currentDate);
      renderTimeline();
    } catch (err) {
      state.overrides.push(saved);
      markSegmentCancelled(blockId, dateStr, true);
      renderTimeline();
      console.error('Override delete failed:', err);
    }
    return;
  }

  // cancel, or un-cancel while keeping the row's time override
  const cancelled = existing && existing.cancelled === 1 ? 0 : 1;
  const prev = existing ? existing.cancelled : null;
  const optimistic = existing || { id: null, block_id: blockId, date: dateStr, cancelled };
  if (existing) existing.cancelled = cancelled;
  else state.overrides.push(optimistic);
  // The strike-through is drawn from the SERVED day, so the local echo has to
  // reach that too or the tap looks dead until the fetch returns. It is an
  // echo of a write just made, not a second copy of the resolution rule —
  // the refetch below replaces it with the server's answer either way.
  markSegmentCancelled(blockId, dateStr, !!cancelled);
  renderTimeline();
  try {
    const res = await apiSend('/api/overrides', 'POST', { block_id: blockId, date: dateStr, cancelled: !!cancelled });
    if (!res.ok) throw new Error();
    const data = await res.json();
    const idx = state.overrides.indexOf(optimistic);
    if (idx !== -1) state.overrides[idx] = data;
    await fetchOverridesForDate(state.currentDate);
    renderTimeline();
  } catch (err) {
    if (existing) existing.cancelled = prev;
    else {
      const idx = state.overrides.indexOf(optimistic);
      if (idx !== -1) state.overrides.splice(idx, 1);
    }
    markSegmentCancelled(blockId, dateStr, !cancelled);
    renderTimeline();
    console.error('Override save failed:', err);
  }
}

function markSegmentCancelled(blockId, dateStr, cancelled) {
  viewSegmentsFor(dateStr).forEach(s => {
    if (s.block_id === blockId && s.date === dateStr) s.cancelled = cancelled;
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
    if (!seg.area_id) continue;
    const proj = projectsById[seg.area_id];
    if (!proj || proj.type !== 'standard') continue;
    if (nowMin >= seg.start && nowMin < seg.end) return blocksById[seg.block_id] || seg;
  }
  return null;
}

let section2RevertTimer = null;

// Every area belongs to exactly one domain (storage backfills the default), so
// a missing domain_id can only mean stale client state — fall back rather than
// leaving section 2 blank.
function defaultDomainId() {
  const d = state.domains.find(x => x.is_default) || state.domains[0];
  return d ? d.id : null;
}

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
// A review pass still sets its own window: it needs `min`/`max` to count
// "day 3/15" and to know when it has reached the end.
const reviewPass = { active: false, from: null, to: null, step: null };

function navBounds() {
  if (!reviewPass.active) return { min: -Infinity, max: Infinity };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const off = iso => Math.round(
    (new Date(iso + 'T12:00:00').setHours(0, 0, 0, 0) - today) / 86400000);
  return { min: off(reviewPass.from), max: off(reviewPass.to) };
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
  const a = areaId ? state.areas.find(p => p.id === areaId) : null;
  return (a && a.domain_id) || defaultDomainId();
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
// rather than guessing it later.
const undoStack = [];
const UNDO_MAX = 30;

function pushUndo(label, inverse) {
  undoStack.push({ label, inverse });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  paintUndo();
}

function paintUndo() {
  // ↩ lives in the global bar, which is visible from every surface — this
  // just keeps it hidden while there is nothing to undo.
  const eg = document.getElementById('eg-undo');
  if (eg) eg.classList.toggle('hidden', !undoStack.length);
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
  if (clarify) clarify.textContent = `Clarify ${state.inbox.length}`;
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
//   · ✎ log             → derived, not selected: the Logs LIST names a new
//                         log; with the editor open the bar reverts to inbox
//                         capture on purpose — a stray task mid-writing goes
//                         to the inbox, not into the log.
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
  const undo = bar.querySelector('#eg-undo');
  const clarify = bar.querySelector('#eg-clarify');
  if (undo) undo.classList.toggle('hidden', !undoStack.length);
  if (clarify) clarify.textContent = `Clarify ${state.inbox.length}`;
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
  bar.innerHTML = `
    <span class="eg-cap-plus">+</span>
    <input type="text" id="eg-capture" placeholder="Capture anything…" autocomplete="off">
    <button id="eg-undo" class="${undoStack.length ? '' : 'hidden'}" title="Undo">↩︎</button>
    <button id="eg-clarify" title="Process the inbox">Clarify ${state.inbox.length}</button>
    <button id="eg-hub" title="Everything else">≡</button>
  `;

  const input = bar.querySelector('#eg-capture');
  // Rule 2, the read half. Text only: a draft restores what you typed, it does
  // not decide that you are typing.
  input.value = captureDraftGet();
  input.addEventListener('input', () => captureDraftSet(input.value));
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

  bar.querySelector('#eg-undo').addEventListener('click', runUndo);
  bar.querySelector('#eg-clarify').addEventListener('click', openClarify);
  bar.querySelector('#eg-hub').addEventListener('click', () => {
    document.getElementById('hub-overlay').classList.toggle('hidden');
  });
}


// Swipe LEFT anywhere on the day to open the ≡ hub — the phone gesture for
// the thing the bar's rightmost button does. Touch only: a mouse drag is how
// an action is placed, and hijacking it would break scheduling.
//
// The guards are what keep it from firing by accident:
//  - it must be mostly HORIZONTAL (|dx| > 2·|dy|), so a fast list scroll and
//    a swipe are not the same gesture;
//  - it must clear 70px within 600ms, so a slow drag is not a swipe;
//  - it never starts inside a text field, a draggable row, the clarify sheet
//    or an open overlay — those own their own horizontal gestures.
function initSwipe() {
  const SWIPE_MIN = 70, SWIPE_MS = 600;
  let sx = 0, sy = 0, t0 = 0, live = false;
  const root = document.getElementById('engage-root') || document.body;

  root.addEventListener('pointerdown', e => {
    live = false;
    if (e.pointerType === 'mouse') return;
    if (e.target.closest('input, textarea, select, [draggable="true"], '
        + '#clarify-sheet, #fr-sheet, .m-overlay:not(.hidden), #flow-run')) return;
    sx = e.clientX; sy = e.clientY; t0 = Date.now(); live = true;
  });

  root.addEventListener('pointerup', e => {
    if (!live) return;
    live = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Date.now() - t0 > SWIPE_MS) return;
    if (dx > -SWIPE_MIN) return;                 // left only
    if (Math.abs(dx) < Math.abs(dy) * 2) return; // not a scroll
    const hub = document.getElementById('hub-overlay');
    if (hub && hub.classList.contains('hidden')) hub.classList.remove('hidden');
  });

  root.addEventListener('pointercancel', () => { live = false; });
}

// ── The two shapes every call in this file already had ───────
//
// One JSON envelope, written once instead of at 134 call sites. They are
// deliberately TWO functions, not one, because the file has two different
// contracts and collapsing them would break one:
//
// apiGet SWALLOWS and falls back. That is the rule loadAll is built on — a
// fetch never blanks the surface it feeds, so a dead endpoint yields the
// CURRENT value, not []. Promise.all rejects as a unit, and one dead endpoint
// used to blank the whole day.
//
// apiSend returns the RESPONSE, not the parsed body: 39 call sites read res.ok
// or res.status to decide what to say, and a helper that hid the response
// would send every one of them back to a raw fetch. Body omitted = no
// Content-Type header, which is what a bare DELETE always sent.
function apiGet(path, fallback) {
  // Written out, not via a helper: this IS the helper. (The sweep that created
  // the call sites rewrote this body into a call to itself — a good reminder
  // that a mechanical transform will happily eat its own definition — twice, as
  // it turned out: once on the sweep, once on the re-sweep after a merge.)
  return fetch(path).then(r => r.json()).catch(() => fallback);
}

function apiSend(path, method, body) {
  return fetch(path, body === undefined ? { method } : {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let toastTimer = null;

function toast(msg) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('toast-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast-on'), 2600);
}

async function runUndo() {
  const entry = undoStack.pop();
  paintUndo();
  if (!entry) { toast('Nothing to undo'); return; }
  try {
    await entry.inverse();
    toast('Undone: ' + entry.label);
  } catch (e) {
    toast("Couldn't undo " + entry.label);
  }
}

// Repaint whatever surfaces are open after an undo, without caring which one
// the original action came from.
async function refreshAfterUndo() {
  await refreshEngage();
  if (!document.getElementById('map-overlay').classList.contains('hidden')) await refreshMap();
  if (!document.getElementById('tab-people').classList.contains('hidden')) await loadPeopleData();
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

// A delete whose inverse restores the captured snapshot.
async function undoableDelete(id, label) {
  const snap = await snapshotItem(id);
  await apiSend(`/api/inbox/${id}`, 'DELETE');
  if (snap) {
    pushUndo(label, async () => {
      await apiSend('/api/inbox/restore', 'POST', snap);
      await refreshAfterUndo();
    });
  }
}

// Time-estimate tags: one of these on an item means "takes about this long".
// They are ordinary tags everywhere (chips, filters, #5m in an add bar) —
// only the clarify picker treats them as exclusive, because a thing doesn't
// take 5 AND 90 minutes.
const EST_TAGS = ['5m', '15m', '30m', '90m'];

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

function renderInbox() {
  // The inbox is the capture bar's live count now; processing is the Clarify
  // sheet (openClarify). Callers that used to repaint the queue just bump N.
  const el = document.getElementById('eg-clarify');
  if (el) el.textContent = `Clarify ${state.inbox.length}`;
}


// ── Sheets Inbox ─────────────────────────────────────────────

function renderSheetsInbox() {
  // The "Due" strip lives at the top of the Calendar overlay now.
  const panel = document.getElementById('sheets-due-strip');
  if (!panel) return;

  let section = document.getElementById('sheets-inbox-section');
  if (!section) {
    section = document.createElement('div');
    section.id = 'sheets-inbox-section';
    panel.appendChild(section);
  }

  if (!state.sheetsInbox.length) {
    section.innerHTML = '';
    return;
  }

  const rowsHtml = state.sheetsInbox.map(item => {
    const timeStr = item.due_time ? ` ${item.due_time}` : '';
    return `<div class="si-item">
      <span class="si-course">${escHtml(item.course)}</span>
      <span class="si-title">${escHtml(item.title)}</span>
      <span class="si-date">${escHtml(item.due_date)}${escHtml(timeStr)}</span>
    </div>`;
  }).join('');

  section.innerHTML = `
    <div class="si-header">Due</div>
    <div class="si-list">${rowsHtml}</div>
  `;
}

// ── Utilities ────────────────────────────────────────────────

const _WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _MONTHS_SHORT   = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _WEEKDAYS_LONG  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const _MONTHS_LONG    = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function jsDateToDayOfWeek(date) {
  return (date.getDay() + 6) % 7;
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
  return `${_WEEKDAYS_SHORT[date.getDay()]} ${_MONTHS_SHORT[date.getMonth()]} ${date.getDate()}`;
}

function formatDateYMD(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
//   runDay()   what this work BELONGS TO — pinned when a runner opened, and
//              it survives midnight. Every write from inside a runner.
//
// The rule: a write picks the day deliberately. If a new write reaches for
// wallDay(), that has to be because the fact really is about the clock.
function wallDay() {
  return formatDateYMD(new Date());
}

function viewDay() {
  return formatDateYMD(state.currentDate);
}

// The pin holds only while a run is OPEN. `flowRunView.date` is left standing
// after closeFlowRun (it is the record of the run that just ended), so reading
// the field itself meant every later runDay() in the session still answered
// with a night that finished hours ago. Gate it on `open` and the fallback is
// the honest one: no run, no pin, wall clock.
//
// It reaches PAST the runner's own pages: any surface the runner RAISES is
// acting for that run, so the CRM fill's night, the interaction it logs and
// the read that asks whether tonight was filled all file under the run's day,
// not the clock's. That is the bug Quentin hit — a nightly routine finished at
// 02:00 recorded its CRM fill under the new day, so the step it was opened
// from went on saying it was unfilled.
function runDay() {
  return (flowRunView.open && flowRunView.date) || wallDay();
}

function formatTodoDate(date) {
  return `${_WEEKDAYS_LONG[date.getDay()]}, ${_MONTHS_LONG[date.getMonth()]} ${date.getDate()}`;
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
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// MTWRFSU — the scheduling notation, not first initials: R is Thursday and U
// is Sunday, so all seven stay distinct at one character. Anywhere with room
// for `DAY_NAMES` should use that instead; this is for pickers that have none.
const DAY_LETTERS = ['M', 'T', 'W', 'R', 'F', 'S', 'U'];
// Monday-first, matching DAY_NAMES' indices — recurrence.py's BYDAY tokens.
const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

// Which section is open; null is the index. The sheet has its own state below.
const settingsView = { section: null };

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
  { key: 'blocks', name: 'Blocks', group: 'Your week',
    desc: 'Recurring windows the day is built around.',
    summary: () => `${beCounts.blocks || 0} set` },
  { key: 'times', name: 'Times', group: 'Your week',
    desc: 'Rules are single patterns. Schedules gather rules, or follow something else.',
    summary: () => plural(beCounts.times, 'schedule') },
  { key: 'recurring', name: 'Recurring', group: 'Your week',
    desc: 'Tasks that come back on a schedule.',
    summary: () => plural(beCounts.recurring, 'task') },
  { key: 'occasions', name: 'Occasions', group: 'Your week',
    desc: 'Actions that arrive with a kind of calendar event.',
    summary: () => plural(beCounts.occasions, 'occasion') },
  { key: 'areas', name: 'Areas', group: 'Where and what',
    desc: 'The areas of your life, and the domains that group them.',
    summary: () => String(beCounts.areas || 0) },
  { key: 'locations', name: 'Locations', group: 'Where and what',
    desc: 'Places a gate or a context tag can be pinned to.',
    summary: () => String(beCounts.locations || 0) },
  { key: 'qr', name: 'Gates', group: 'Where and what',
    desc: 'Scan points that gate the day.',
    summary: () => plural(beCounts.qr, 'gate') },
  { key: 'metrics', name: 'Metrics', group: 'Where and what',
    desc: 'What you track about yourself. Asked on a routine step — a metric can '
      + 'be asked by a morning step AND a night one.',
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
];

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

const seSheet = { kind: null, item: null, values: null, error: '' };

function openSeSheet(kind, item) {
  const spec = SETTINGS_SHEETS[kind];
  seSheet.kind = kind;
  seSheet.item = item || null;
  seSheet.values = item ? spec.load(item) : spec.blank();
  seSheet.error = '';
  // Folded on open: the steps are for the one evening you program a tag, not
  // for every visit to the gate that uses it.
  seSheet.infoOpen = {};
  document.getElementById('se-sheet').classList.remove('hidden');
  document.getElementById('se-sheet-backdrop').classList.remove('hidden');
  document.getElementById('block-editor-modal').classList.add('be-sheet-open');
  renderSeSheet();
  const first = document.querySelector('#se-sheet .se-input');
  if (first && !seSheet.item) first.focus();
}

function closeSeSheet() {
  seSheet.kind = null;
  seSheet.item = null;
  seSheet.values = null;
  document.getElementById('se-sheet').classList.add('hidden');
  document.getElementById('se-sheet-backdrop').classList.add('hidden');
  document.getElementById('block-editor-modal').classList.remove('be-sheet-open');
}

// ── A gate's NFC tags ─────────────────────────────────────────
//
// Rows on the gate's sheet, each opening the tag's own sheet — the same
// arrangement a routine's steps have, and for the same reason: a flat field
// list cannot hold a list of things that each need editing, pausing and
// deleting. Which gate a new tag belongs to is remembered here, because
// openSeSheet takes a kind and an item and a tag being CREATED has no item to
// carry its parent.
const tagSheetView = { gate: null };

function tagState(t) {
  if (!t.keys_set) return 'no keys yet';
  if (t.pending_live_at) return `starts ${t.pending_live_at.slice(0, 16).replace('T', ' ')}`;
  if (!t.active) return 'paused';
  if (!t.last_tap_at) return 'live, never tapped';
  return `last tap ${t.last_tap_at.slice(0, 16).replace('T', ' ')}`;
}

// HOW TO PROGRAM A TAG, in the one place the decision is made. Tag-only proof
// is the only setting here that cannot be finished inside the app: half of it
// happens in a third-party NFC writer, and getting the SDM options wrong makes
// a tag that reads fine and never satisfies the gate. So the steps live behind
// an ⓘ on the Proof row rather than in a document nobody has open at the time.
// It is a disclosure, not a tooltip — a phone has no hover to find one with.
const TAG_SETUP_INFO = [
  { h: 'Before you open NFC.cool', start: 1, items: [
    { t: 'Get the UID. Read the tag with NFC.cool — it shows the chip type and '
       + 'the UID. You want the 7-byte, 14-hex-character value.' },
    { t: 'Generate the two keys yourself, as hex, somewhere you can read them. '
       + 'NFC.cool will take a key as a passphrase, but this app needs the '
       + 'actual key bytes — a passphrase whose hex you cannot see is a key you '
       + 'cannot paste in here.',
      code: "python -c \"import secrets; print('meta', secrets.token_hex(16)); "
       + "print('file', secrets.token_hex(16))\"" },
    { t: 'Copy the tap URL. The Tags row above prints it in full. The zeros are '
       + 'placeholders — the tag overwrites them on every tap.',
      code: 'https://<host>:8443/t?e=000…000&c=0000000000000000' },
    { t: 'Add the tag here NOW, keys and all: + Tag → name, UID, both keys. Do '
       + 'it before programming, so a half-failed write does not leave you '
       + 'holding a configured tag whose keys are only in your scrollback.' },
  ] },
  { h: 'In NFC.cool Tools', start: 5, items: [
    { t: 'Write the NDEF URL — the full tap URL from step 3, zeros included.' },
    { t: 'Turn on SUN / SDM on the NDEF file (file 02):', sub: [
      'Encrypted PICC data mirror positioned at the e= zeros, with UID '
        + 'mirroring and read-counter mirroring both on. Not the plain '
        + 'uid=…&ctr=… variant — that one is rejected deliberately.',
      'SDMMAC mirror positioned at the c= zeros.',
      'No encrypted file data, and MAC input offset = MAC offset (the MAC '
        + 'covers nothing but itself). Some apps word this as “SDM MAC input '
        + 'starts at the MAC” — same thing.',
      'NDEF file read access: free, no key, so any phone can follow the URL.',
      'SDM Meta Read key → the slot for the meta key; SDM File Read key → the '
        + 'slot for the file key. Slot numbers are yours to choose — this app '
        + 'stores key VALUES, not slot numbers.',
    ] },
    { t: 'Change the keys LAST, entering them as hex, not as a passphrase. '
       + 'Doing it after the URL and the SDM config means every earlier step '
       + 'ran on the easy factory auth, so a failure midway leaves a tag you '
       + 'can still talk to. If you also change key 0 (the master), write it '
       + 'down somewhere durable — lose it and the tag can never be '
       + 'reconfigured.' },
    { t: 'Leave it in AES mode. If you see an LRP option, do not.' },
  ] },
  { h: 'Then', start: 9, items: [
    { t: 'Back here: set Proof to “NFC tag only”. It refuses until the tag and '
       + 'its keys are in place — that refusal is the check working.' },
    { t: 'Tap it. You should get “Logged — <tag name>, read N”. If you do not, '
       + "copy the e= and c= values out of the phone's address bar and run "
       + 'this on the VM. It prints each stage, so you will see whether the '
       + 'meta key is wrong (picc_data will not decrypt), the file key is wrong '
       + '(cmac fails), or the counter mirror is off.',
      code: 'python ntag.py <e> <c> <meta-key> <file-key>' },
  ] },
];

function gateTagRows(n) {
  const rows = (n.tags || []).map((t, i) => ({
    key: `tag_${t.id}`, label: i === 0 ? 'Tags' : '', kind: 'action',
    text: `${t.label} · ${t.uid} · ${tagState(t)}`,
    action: 'Edit', keepOpen: true,
    run: () => openGateTagSheet(n, t),
  }));
  rows.push({
    key: 'tag_add', label: rows.length ? '' : 'Tags', kind: 'action',
    text: n.tap_url
      ? `write ${n.tap_url} to a tag`
      : 'set a Scan URL in Connections first — a tag needs somewhere to point',
    action: '+ Tag', keepOpen: true,
    hint: rows.length
      ? 'A tag belongs to this gate only. On a tag-only gate a NEW tag starts'
        + ' counting in 24h — it is another way to clear the gate.'
      : 'A tag proves you were AT the thing. Program the URL above into an NTAG'
        + ' 424 DNA with SDM mirroring on, then paste its two keys here.',
    run: () => openGateTagSheet(n, null),
  });
  return rows;
}

function openGateTagSheet(node, tag) {
  tagSheetView.gate = node;
  openSeSheet('gatetag', tag);
}

// Back to the gate it belongs to, with fresh numbers — the tag sheet replaced
// the gate's sheet on the way in, so this is the way back.
async function backToGateSheet() {
  const gate = tagSheetView.gate;
  await renderQrManager();
  const fresh = (state.accountabilityNodes || []).find(n => n.id === (gate || {}).id);
  if (fresh) { openSeSheet('gate', fresh); return; }
  // Nothing to go back to (the gate was deleted from another surface): close,
  // rather than leave a sheet open over a gate that no longer exists.
  closeSeSheet();
  renderSettingsIndex();
}

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
    control = `<div class="se-static">${escHtml(f.text)}</div>`;
  } else if (f.kind === 'openpicker') {
    // The row states the schedule in words and hands the editing to the picker.
    // A consumer never grows fields of its own for "when does this run".
    control = `<button type="button" class="se-openpicker" data-f="${f.key}">
      <span>${escHtml(f.text || 'not set')}</span><span class="be-chev">›</span></button>`;
  } else if (f.kind === 'action') {
    // A state the sheet can only clear, not edit — a gate's today-only window.
    control = `<div class="se-static">${escHtml(f.text)}</div>`
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
    control = `<div class="se-swatches" data-f="${f.key}">${BLOCK_COLORS.map(c =>
      `<button type="button" class="se-swatch${c === val ? ' se-on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`
    ).join('')}</div>`;
  } else if (f.kind === 'days') {
    control = `<div class="se-days" data-f="${f.key}">${DAY_LETTERS.map((d, i) =>
      `<button type="button" class="se-day${val.includes(i) ? ' se-on' : ''}" data-day="${i}" title="${DAY_NAMES[i]}">${d}</button>`
    ).join('')}</div>`;
  } else if (f.kind === 'check') {
    control = `<button type="button" class="se-check${val ? ' se-on' : ''}" data-f="${f.key}">${
      escHtml(val ? f.on : f.off)}</button>`;
  } else if (f.kind === 'weekly') {
    // A gate's per-day windows: only the days the gate runs on get a row, and
    // a day that matches the defaults above is not stored at all.
    control = `<div class="se-weekly" data-f="${f.key}">${v.days.slice().sort().map(i => {
      const w = val[i] || { start: v.start, end: v.end, offset: v.offset };
      return `<div class="se-wk-row" data-dow="${i}">
        <span class="se-wk-day">${DAY_NAMES[i]}</span>
        <input type="time" class="se-input se-wk-start" value="${escHtml(w.start || '')}">
        <span class="se-wk-sep">–</span>
        <input type="time" class="se-input se-wk-end" value="${escHtml(w.end || '')}">
        <button type="button" class="se-wk-off${w.offset ? ' se-on' : ''}">+1d</button>
      </div>`;
    }).join('')}</div>`;
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
      wrap.addEventListener('click', () => f.open(v));
    } else if (f.kind === 'action') {
      wrap.addEventListener('click', async () => {
        await f.run(seSheet.item);
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
        const btn = e.target.closest('.se-day');
        if (!btn) return;
        const n = parseInt(btn.dataset.day);
        const at = v[f.key].indexOf(n);
        if (at === -1) v[f.key].push(n); else v[f.key].splice(at, 1);
        if (f.onChange) f.onChange(v);
        // A re-render is what makes the dependent fields (a gate's per-day
        // windows) follow the day keys; without one, repaint just this key.
        if (f.rerender) renderSeSheet();
        else btn.classList.toggle('se-on', at === -1);
      });
    } else if (f.kind === 'check') {
      wrap.addEventListener('click', () => {
        v[f.key] = !v[f.key];
        wrap.classList.toggle('se-on', v[f.key]);
        wrap.textContent = v[f.key] ? f.on : f.off;
        if (f.rerender) renderSeSheet();
      });
    } else if (f.kind === 'weekly') {
      wrap.querySelectorAll('.se-wk-row').forEach(row => {
        const dow = row.dataset.dow;
        const read = () => ({
          start: row.querySelector('.se-wk-start').value,
          end: row.querySelector('.se-wk-end').value,
          offset: row.querySelector('.se-wk-off').classList.contains('se-on') ? 1 : 0,
        });
        row.querySelectorAll('input').forEach(inp =>
          inp.addEventListener('change', () => { v[f.key][dow] = read(); }));
        row.querySelector('.se-wk-off').addEventListener('click', e => {
          e.currentTarget.classList.toggle('se-on');
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
  // A sheet that NAVIGATES has already opened the one you land on (a tag hands
  // back to its gate), so closing here would shut that. Same bargain as an
  // action row's keepOpen.
  if (spec.navigates) return;
  closeSeSheet();
  renderSettingsIndex();
}

async function removeSeItem() {
  const spec = SETTINGS_SHEETS[seSheet.kind];
  if (spec.confirm && !confirm(spec.confirm(seSheet.item))) return;
  await spec.remove(seSheet.item);
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
function seAreaOptions(current) {
  return [{ value: '', name: '— none —' }].concat(
    (state.areas || []).filter(p => p.active || String(p.id) === String(current))
      .map(p => ({ value: p.id, name: p.name + (p.active ? '' : ' (paused)') })));
}

function seLocationOptions(firstName, current) {
  return [{ value: '', name: firstName || '— none —' }].concat(
    (state.locations || []).filter(l => l.active !== 0 || String(l.id) === String(current))
      .map(l => ({ value: l.id, name: l.name + (l.active === 0 ? ' (paused)' : '') })));
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
  end_time: 'To', area_id: 'Area', location_id: 'Location', active: 'State',
  delete: 'Deleted',
};

function blockChangeValue(c) {
  if (c.field === 'day_of_week') return DAY_NAMES[parseInt(c.new_value)] || c.new_value;
  if (c.field === 'active') return c.new_value ? 'Active' : 'Paused';
  if (c.field === 'area_id') {
    return ((state.areas || []).find(a => String(a.id) === String(c.new_value)) || {}).name || '—';
  }
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
  if (String(v.area || '') !== String(g.area_id || '')) fields.area_id = v.area || null;
  if (String(v.location || '') !== String(g.location_id || '')) fields.location_id = v.location || null;
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

  // A block row is a GROUP of one-per-day rows (groupBlocks), so saving an
  // edit deletes the group and re-posts it — the API has no group identity.
  block: {
    title: it => it ? 'Edit block' : 'Add block',
    save: () => 'Save block',
    removeLabel: 'Delete block',
    blank: () => ({ label: '', color: BLOCK_COLORS[0], days: [], start: '', end: '',
                    area: '', location: '', active: true, effective: '' }),
    load: g => ({
      label: g.label, color: g.color, days: g.days.slice(),
      start: g.start_time, end: g.end_time,
      area: g.area_id || '', location: g.location_id || '',
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
      { key: 'area', label: 'Area', kind: 'select', half: true,
        options: () => seAreaOptions(v.area) },
      { key: 'location', label: 'Location', kind: 'select', half: true,
        options: () => seLocationOptions(null, v.location) },
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
          area_id: v.area || null, location_id: v.location || null,
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
              area_id: g.area_id || null, location_id: g.location_id || null,
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
        { key: 'area', label: 'Area', kind: 'select', placeholder: '— pick an area —',
          options: () => (state.areas || []).filter(p => p.active && p.type === 'standard')
            .map(p => ({ value: p.id, name: p.name })) },
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
            options: () => DAY_NAMES.map((d, i) => ({ value: i, name: d })) },
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
      if (!v.area) return 'Pick an area for it.';
      if (!v.anchor) return 'Set the day it starts.';
      const body = {
        name: v.name.trim(), area_id: parseInt(v.area), kind: v.kind,
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
    confirm: it => `Delete area "${it.name}"?`,
    blank: () => ({ name: '', type: 'standard', domain: (state.domains[0] || {}).id || '' }),
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
        { key: 'domain', label: 'Domain', kind: 'select', half: true,
          options: () => seDomainOptions(v.domain) },
      ];
      return [
        { key: 'name', label: 'Name', kind: 'static', text: it.name },
        { key: 'type', label: 'Type', kind: 'select', half: true, rerender: true, options: () => types },
        { key: 'domain', label: 'Domain', kind: 'select', half: true,
          options: () => seDomainOptions(v.domain) },
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
      if (String(v.domain) !== String(a.domain_id || '')) await patch({ domain_id: parseInt(v.domain) });
      if (v.type === 'routine' && String(v.qr) !== String(a.qr_node_id || '')) {
        await patch({ qr_node_id: v.qr ? parseInt(v.qr) : null });
      }
      if (v.active !== !!a.active) await patch({ active: v.active ? 1 : 0 });
      await refreshBlockEditor();
      return null;
    },
    remove: async a => {
      await apiSend(`/api/areas/${a.id}`, 'DELETE');
      await refreshBlockEditor();
    },
  },

  // The default domain has no Delete — it is where a deleted domain's areas
  // land, so it can't be removed.
  domain: {
    title: it => it ? 'Domain' : 'Add domain',
    save: () => 'Save domain',
    removeLabel: 'Delete domain',
    confirm: it => `Delete domain "${it.name}"? Its areas move to the default domain.`,
    blank: () => ({ name: '', active: true }),
    load: d => ({ name: d.name, active: d.active !== 0 }),
    fields: (v, it) => [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'Domain name' },
      // The default domain is the fallback every area lands in, so it is the
      // one thing here that cannot be taken out of circulation.
      ...(it && !it.is_default
        ? [seStateRow('Paused: not offered when filing. Its areas keep working.')] : []),
    ],
    submit: async (v, d) => {
      const name = v.name.trim();
      if (!name) return 'Name is required.';
      if (d) {
        await apiSend(`/api/domains/${d.id}`, 'PATCH', { name, ...(d.is_default ? {} : { active: v.active ? 1 : 0 }) });
      } else {
        await apiSend('/api/domains', 'POST', { name });
      }
      await refreshBlockEditor();
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
        placeholder: 'optional — the wording the runner shows' },
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
                  hint: 'Add a "metrics" step to a routine, then pick this '
                    + 'metric in that step’s sheet.' }] : []),
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

  // A gate loosened (wider window, larger radius) only takes effect in 24h —
  // the server answers with what it deferred, and the sheet says so.
  gate: {
    title: it => it ? it.label : 'Add gate',
    save: it => it ? 'Save gate' : 'Create gate',
    removeLabel: n => (n && n.active ? 'Delete gate (in 24h)' : 'Delete gate'),
    // Deleting a LIVE gate is offered, and takes the 24h road like every other
    // easing (2026-08-15). Refusing it until the gate was deactivated was two
    // waits for one decision, and the button read as broken. Turning the gate
    // back on cancels a queued deletion, same as it cancels a queued disable.
    canRemove: () => true,
    confirm: n => (n && n.active
      ? 'Delete this gate? Anything that lets you off waits 24h — it goes '
        + 'tomorrow, and re-activating it before then calls the deletion off.'
      : 'Delete this gate permanently? Its scan link stops working.'),
    blank: () => ({
      label: '', source: '', sourceLabel: '',
      location: '', radius: '', stake: '', routine: '', effective: '',
    }),
    load: n => {
      // A gate with a pending deactivation reads as Inactive here, so turning
      // it back on is what cancels that — `active0` remembers which way the
      // toggle started, since `n.active` is still 1 while the disable waits.
      const off = (n.pending_changes || []).some(p => p.field === 'active' && String(p.new_value) === '0');
      const active = !!n.active && !off;
      return {
        source: n.source_uid || '', source0: n.source_uid || '',
        sourceLabel: n.schedule_label || '',
        location: '', radius: n.geofence_radius_m || '',
        active, active0: active,
        proof: n.proof_mode || 'link', proof0: n.proof_mode || 'link',
        // Always blank on open: a date is a decision about the save you are
        // making now, not a property of the gate. Re-showing the last one
        // would silently re-date the next edit.
        effective: '',
        // Dollars in the field, cents in the column. Blank means "use the
        // default", which is a different thing from zero.
        stake: n.charge_cents == null ? '' : (n.charge_cents / 100).toFixed(2),
        routine: n.routine_id == null ? '' : String(n.routine_id),
        routine0: n.routine_id == null ? '' : String(n.routine_id),
      };
    },
    fields: (v, it) => {
      // `active` is left out of the list below because the State row above IS
      // that change — but the row alone cannot say WHEN, and a pause dated to
      // Wednesday reading as a flat "Paused" is the ambiguity this whole
      // feature exists to remove. So the day goes in its hint.
      const pending = it ? (it.pending_changes || []).filter(p => p.field !== 'active') : [];
      const pausedFrom = it ? (it.pending_changes || [])
        .find(p => p.field === 'active' && falsyFlag(p.new_value)) : null;
      return [
        ...(it ? [] : [{ key: 'label', label: 'Label', kind: 'text', placeholder: 'e.g. Desk' }]),
        // WHEN this gate runs is a schedule source, edited in the picker — the
        // same object a block or a task would hold. The four fields that used to
        // live here (from, to, crosses-midnight, days) and the per-day windows
        // are all expressible as one rule or one schedule, so the gate no longer
        // carries a second grammar for time.
        { key: 'source', label: 'Repeats', kind: 'openpicker',
          text: v.sourceLabel || 'not set yet',
          hint: it ? 'Anything that makes the schedule easier waits 24h.' : null,
          open: draft => openPicker({
            sourceUid: draft.source || null,
            noFollows: true,
            onSaved: async (uid, src) => {
              draft.source = uid;
              draft.sourceLabel = src.label || describeDraft();
              renderSeSheet();
            },
          }) },
        { key: 'location', label: 'Location', kind: 'select', half: true,
          options: () => seLocationOptions(it ? '— keep current —' : '— none —') },
        { key: 'radius', label: 'Radius', kind: 'number', half: true, suffix: 'm' },
        // The routine this gate demands. It was settable only from the routine
        // editor, which put the rule that decides ✓/✗ on a different surface
        // from the gate it decides about — so a gate could be judged on a
        // condition that appeared nowhere in its own settings.
        ...(it ? [{ key: 'routine', label: 'Requires routine', kind: 'select',
          options: () => [{ value: '', name: '— presence only —' }].concat(
            (state.gateRoutines || []).map(f => ({ value: String(f.id), name: f.name }))),
          hint: 'Scanning alone won\'t pass this gate until the routine is done.'
            + ' Removing the requirement takes effect at once — unlike every other easing.' }] : []),
        ...(it ? [{ key: 'stake', label: 'Stake', kind: 'number', step: '0.25', min: 0,
          half: true, placeholder: 'default',
          hint: 'What failing this gate costs. Blank uses the default in Billing below.'
            + ' Raising it applies now; lowering waits 24h, like any other easing.' }] : []),
        // What this gate is actually judged ON. The routine half is configured
        // in the routine editor, so without this line the rule that decides
        // ✓/✗ appears nowhere on the gate it decides about.
        ...(it ? [{ key: 'judged', label: 'Passes when', kind: 'static',
          text: ['you scan it inside the window',
            it.geofence_lat != null ? `within ${it.geofence_radius_m}m of the pinned place` : null,
            it.routine ? `“${it.routine}” is done first` : null,
          ].filter(Boolean).join(', and ') }] : []),
        ...(it && it.today_state && it.today_state.judged
            && it.today_state.judged.failure_reason ? [{ key: 'todayres', label: 'Today',
          kind: 'static',
          text: `✗ ${gateReason(it.today_state.judged.failure_reason)} · `
            + gateStatus(it.today_state.judged.charge_status) }]
          : it && it.today_state && it.today_state.scan ? [{ key: 'todayres', label: 'Today',
            kind: 'static', text: `✓ scanned ${it.today_state.scan.scanned_at.slice(11, 16)}` }] : []),
        // HOW THIS GATE MAY BE PROVED. The soft answer is the link (plus the
        // geofence where one is set) — which proves a URL was opened, not that
        // you were there. The hard answer is a tap of one of this gate's NFC
        // tags: the tag holds keys it never gives up and re-signs every tap, so
        // a captured link is worth nothing.
        ...(it ? [{ key: 'proof', label: 'Proof', kind: 'select',
          options: () => [{ value: 'link', name: 'Link + geofence' },
                          { value: 'tag', name: 'NFC tag only' }],
          hint: v.proof === 'tag'
            ? 'Only a tap of a tag below clears this gate — a link or a geofence no'
              + ' longer counts. Going back to the link is an easing, so it waits 24h.'
            : 'A tap still counts on a link gate — it is stronger than what is asked.'
              + ' Switching to tag-only applies at once, and needs a live tag first.' }] : []),
        // Sits under Proof, above the tags themselves — the order you do it in.
        ...(it ? [{ key: 'tagsetup', kind: 'info', label: '',
          text: 'How to program a tag for hard mode', sections: TAG_SETUP_INFO }] : []),
        ...(it ? gateTagRows(it) : []),
        ...(it ? [{ key: 'link', label: 'Scan link', kind: 'action',
          text: `${state.settings.gate_scan_url || ''}/scan/${it.token}`,
          action: 'Copy',
          hint: 'The QR code to print. Anyone with this URL can satisfy the gate.',
          run: n => copyAndSay(
            `${state.settings.gate_scan_url || ''}/scan/${n.token}`, 'Scan link'),
          }] : []),

        // A today-only window and a deferred loosening are states this sheet
        // can report and clear but not edit — they were tooltips on the old
        // table, which is unreachable on a phone.
        ...(it && it.today_override ? [{ key: 'override', label: 'Today only', kind: 'action',
          text: `${it.today_override.window_start}–${it.today_override.window_end}`
            + `${it.today_override.window_end_offset_days ? ' +1d' : ''}`,
          action: 'Remove',
          run: n => removeOverride(n.id, n.today_override.date) }] : []),
        // Last, like every other sheet's — the read-outs above it are facts
        // about the gate, not fields, so the ladder still ends on the switch.
        ...(it ? [seStateRow(pausedFrom
          ? `Paused from ${seWhenLabel(pausedFrom.effective_date)} — it still runs`
            + ' until then, and the timeline shows it stopping there. Set it back'
            + ' to Active to call that off.'
          : 'Pausing a gate is an easing, so it takes effect in 24h —'
            + ' turning it back on before then calls it off. Give it a date below'
            + ' to pause it from a day instead.')] : []),
        ...(it ? [seWhenRow('Blank: now, with easings waiting their 24h as always. A date'
          + ' moves the whole change to that day — the timeline shows it there'
          + ' before it happens. An easing dated sooner than 24h still waits.')] : []),
        // One row per DECISION, each with its own way out — a scheduled change
        // you cannot call off is worse than none. Cancelling never applies
        // anything: the row was never touched, so there is nothing to undo,
        // and staying as you are is the tighter direction anyway.
        //
        // The DAY it starts, not the timestamp it lands: "from Wed 19 Aug" is
        // what was decided, and a change landing at 16:24 does not govern that
        // morning's window (storage.effective_date_for).
        ...gatePendingGroups(pending).map((grp, i) => ({
          key: `pending_${i}`, label: i === 0 ? 'Scheduled' : '', kind: 'action',
          text: `${grp.label ? grp.label + ' → ' : ''}${grp.text}`
            + ` from ${seWhenLabel(grp.effective_date)}`,
          action: 'Call off',
          hint: i === 0 ? 'Anything that makes a gate easier waits 24h, so it can\'t be '
            + 'loosened in the moment you want to dodge it.' : null,
          run: async n => {
            // Every field of the decision, or none: half a moved fence is a
            // place that does not exist.
            for (const f of grp.fields) {
              await apiSend(`/api/accountability/nodes/${n.id}/pending/${f}`, 'DELETE');
            }
            await renderQrManager();
          },
        })),
      ];
    },
    submit: async (v, n) => {
      if (!n) {
        if (!v.label.trim()) return 'A gate needs a label.';
        if (!v.source) return 'Set when this gate runs.';
        const loc = (state.locations || []).find(l => String(l.id) === String(v.location));
        const radius = parseInt(v.radius);
        // No window fields: the server derives them from the source, so the
        // legacy columns and the schedule cannot disagree from the start.
        const resp = await apiSend('/api/accountability/nodes', 'POST', {
            label: v.label.trim(), source_uid: v.source,
            geofence_lat: loc ? loc.lat : null,
            geofence_lng: loc ? loc.lng : null,
            geofence_radius_m: loc ? (isNaN(radius) ? loc.radius_m : radius) : null,
          });
        if (!resp.ok) return `Create failed (${resp.status}).`;
        const node = await resp.json();
        const workerUrl = state.settings.gate_scan_url || '';
        alert(`Gate created. Its scan URL:\n${workerUrl}/scan/${node.token}`);
        await renderQrManager();
        return null;
      }
      const body = {
        geofence_radius_m: parseInt(v.radius) || n.geofence_radius_m,
      };
      if (v.proof !== v.proof0) body.proof_mode = v.proof;
      // The schedule goes through the same 24h test as everything else, but the
      // test is now over OCCURRENCES (schedule.demands_less) rather than fields.
      if (v.source && v.source !== v.source0) body.source_uid = v.source;
      const stake = String(v.stake).trim() === '' ? null : Math.round(parseFloat(v.stake) * 100);
      if (stake !== (n.charge_cents == null ? null : n.charge_cents)) body.charge_cents = stake;
      // The link lives on the FLOW (flow.qr_node_id), so moving it is two
      // writes: release the routine that held this gate, then claim it. The
      // flows route keeps the Worker's routine_required flag in step both ways.
      if (v.routine !== v.routine0) {
        if (v.routine0) {
          await apiSend(`/api/flows/${v.routine0}`, 'PATCH', { qr_node_id: null });
        }
        if (v.routine) {
          await apiSend(`/api/flows/${v.routine}`, 'PATCH', { qr_node_id: n.id });
        }
      }
      if (v.location) {
        const loc = state.locations.find(l => String(l.id) === String(v.location));
        body.geofence_lat = loc.lat;
        body.geofence_lng = loc.lng;
      }
      // The date rides the same patch, so one save is one decision: what
      // changes, and from when. The server takes the later of it and the
      // easing floor, and answers with the day each field really starts.
      if (v.effective) body.effective_from = v.effective;
      const res = await apiSend(`/api/accountability/nodes/${n.id}`, 'PATCH', body);
      if (!res.ok) {
        // The server refuses some changes in WORDS (a tag-only gate with no
        // live tag could never be cleared). Saying the number instead of the
        // sentence is how a refusal reads as a bug.
        const why = (await res.json().catch(() => ({}))).error;
        if (why) toast(why);
        return why || `Edit failed (${res.status}).`;
      }
      const result = await res.json();
      if (v.active !== v.active0) {
        const route = v.active ? 'activate' : 'disable';
        const r = await apiSend(`/api/accountability/nodes/${n.id}/${route}`, 'PATCH',
                                v.active || !v.effective ? undefined
                                  : { effective_from: v.effective });
        if (!r.ok) return `${v.active ? 'Resume' : 'Pause'} failed (${r.status}).`;
      }
      // What the server actually decided, per field — the date asked for is
      // not always the day it starts, and saying the day back is the only way
      // that is honest. A loosening dated inside 24h lands later than asked.
      if (result.pending && result.pending.length) {
        const days = [...new Set(result.pending.map(f =>
          seWhenLabel((result.scheduled[f] || {}).effective_date)))];
        const asked = v.effective ? seWhenLabel(v.effective) : null;
        toast(`${result.pending.map(f => GATE_FIELDS[f] || f).join(', ')} `
          + `from ${days.join(' / ')}`
          + (asked && !days.includes(asked) ? ` — not ${asked}: an easing waits 24h` : ''));
      }
      await renderQrManager();
      return null;
    },
    remove: async n => {
      // The Takes-effect date applies to a deletion too: "gone from Wednesday"
      // is a thing you schedule, and the gate keeps running until then.
      const when = (seSheet.values || {}).effective;
      const res = await apiSend(`/api/accountability/nodes/${n.id}`
        + (when ? `?effective_from=${encodeURIComponent(when)}` : ''), 'DELETE');
      if (!res.ok) { toast(`Delete failed (${res.status}): ${await res.text()}`); return; }
      const out = await res.json().catch(() => ({}));
      // A live gate's deletion is QUEUED, so say when it lands — the gate is
      // still on the list until then, and silence would read as a failure.
      if (out.pending) toast(`Deleted from ${seWhenLabel(out.effective_date)}`);
      await renderQrManager();
    },
  },

  // ONE TAG. A settings item like any other — edited, paused and deleted in the
  // same words and the same place — with two extras nothing else has: a UID
  // that is the tag's identity (so it cannot be edited afterwards) and two AES
  // keys that are WRITE-ONLY, kept in config.json rather than the db, which is
  // dumped into backups/ and pushed.
  gatetag: {
    // It hands back to the gate's sheet rather than to the index: a tag is only
    // ever reached from there, and landing on the section list would lose the
    // gate you were setting up.
    navigates: true,
    title: it => it ? it.label : 'Add tag',
    save: it => it ? 'Save tag' : 'Add tag',
    removeLabel: () => 'Delete tag',
    canRemove: () => true,
    confirm: t => `Delete "${t.label}"? Taps of it stop clearing the gate. `
      + 'The scans it already proved stay.',
    blank: () => ({ label: '', uid: '', meta: '', mac: '', active: true, active0: true }),
    load: t => ({ label: t.label, uid: t.uid, meta: '', mac: '',
                  active: !!t.active, active0: !!t.active }),
    fields: (v, it) => [
      { key: 'label', label: 'Name', kind: 'text', placeholder: 'e.g. Gym door' },
      ...(it
        ? [{ key: 'uid', label: 'UID', kind: 'static', text: it.uid }]
        : [{ key: 'uid', label: 'UID', kind: 'text', placeholder: '7 bytes, 14 hex chars',
             hint: 'The tag\'s own serial — the app reads it out of the first tap it '
                 + 'verifies, so paste what the programming app shows.' }]),
      { key: 'meta', label: 'Meta key', kind: 'password',
        placeholder: it && it.keys_set ? '•••• set — blank leaves it' : '32 hex chars',
        hint: 'The key the tag encrypts its UID and read counter with (SDM meta read key).' },
      { key: 'mac', label: 'File key', kind: 'password',
        placeholder: it && it.keys_set ? '•••• set — blank leaves it' : '32 hex chars',
        hint: 'The key it signs each tap with (SDM file read key). Write-only: the app '
            + 'says whether a key is set, never what it is.' },
      ...(it ? [{ key: 'state', label: 'State', kind: 'static', text: tagState(it) }] : []),
      ...(it ? [seStateRow('Paused: taps are refused and cannot clear the gate. On a'
        + ' tag-only gate waking it up again waits 24h, like every other easing.')] : []),
    ],
    submit: async (v, t) => {
      const gate = tagSheetView.gate || {};
      const label = (v.label || '').trim();
      const keys = async id => {
        if (!v.meta && !v.mac) return null;
        const r = await apiSend(`/api/accountability/tags/${id}/keys`, 'PUT',
                                { meta: v.meta, mac: v.mac });
        if (!r.ok) return (await r.json().catch(() => ({}))).error || 'Those keys were refused.';
        return null;
      };
      if (!t) {
        if (!label) return 'A tag needs a name.';
        const res = await apiSend(`/api/accountability/nodes/${gate.id}/tags`, 'POST',
                                  { label, uid: v.uid });
        if (!res.ok) return (await res.json().catch(() => ({}))).error
          || `Could not add it (${res.status}).`;
        const made = await res.json();
        const kerr = await keys(made.id);
        if (kerr) return kerr;
        if (made.pending_live_at) {
          toast(`added — it starts counting ${made.pending_live_at.slice(0, 16).replace('T', ' ')}`);
        }
        await backToGateSheet();
        return null;
      }
      if (label && label !== t.label) {
        const r = await apiSend(`/api/accountability/tags/${t.id}`, 'PATCH', { label });
        if (!r.ok) return (await r.json().catch(() => ({}))).error || 'Rename failed.';
      }
      const kerr = await keys(t.id);
      if (kerr) return kerr;
      if (v.active !== v.active0) {
        const r = await apiSend(`/api/accountability/tags/${t.id}`, 'PATCH',
                                { active: v.active ? 1 : 0 });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) return out.error || 'That change was refused.';
        // Waking a tag on a tag-only gate is an easing: the server queues it and
        // says when, and the sheet has to pass that on or it reads as a no-op.
        if (out.pending) {
          toast(`it starts counting ${String(out.apply_at).slice(0, 16).replace('T', ' ')}`);
        }
      }
      await backToGateSheet();
      return null;
    },
    remove: async t => {
      const res = await apiSend(`/api/accountability/tags/${t.id}`, 'DELETE');
      if (!res.ok) {
        toast((await res.json().catch(() => ({}))).error || `Delete failed (${res.status}).`);
        return;
      }
      await backToGateSheet();
    },
  },

  // The money settings, reached from the System tab's rows. A sheet rather than
  // inline fields for the usual reason — these are decisions — and because the
  // token needs a password field, which has no business sitting open on a panel
  // you scroll past every time you check a gate.
  billing: {
    title: () => 'Billing',
    save: () => 'Save and check',
    blank: () => ({ token: '', user: '', stake: '', cap: '', fee: '' }),
    load: b => ({
      token: '', user: b.user || '',
      stake: (b.default_cents / 100).toFixed(2), cap: (b.cap_cents / 100).toFixed(2),
      fee: (b.fee_cents / 100).toFixed(2),
    }),
    fields: (v, b) => [
      { key: 'token', label: 'Beeminder token', kind: 'password',
        placeholder: b && b.has_token ? 'set — type to replace' : 'paste your token',
        hint: 'Stored on the server in config.json, never in the database, and never readable'
          + ' back — leave it blank to keep the one already there.' },
      { key: 'user', label: 'Bills', kind: 'text', placeholder: 'beeminder username' },
      { key: 'stake', label: 'Default stake', kind: 'number', step: '0.25', min: 0, half: true },
      { key: 'cap', label: 'Weekly cap', kind: 'number', step: '1', min: 0, half: true,
        hint: 'A charge that would breach the cap is skipped whole, not trimmed.' },
      { key: 'fee', label: 'Card fee per charge', kind: 'number', step: '0.05', min: 0, half: true,
        hint: 'What the card provider takes on each transaction (Privacy: $0.50). The stake'
          + ' stays the total cost of failing — Beeminder is billed the stake minus this.'
          + ' Beeminder’s own $1 minimum applies to the remainder, so keep every stake'
          + ' at least the fee plus $1.' },
    ],
    submit: async v => {
      const body = {
        gate_charge_cents: Math.round(parseFloat(v.stake) * 100) || 0,
        gate_weekly_cap_cents: Math.round(parseFloat(v.cap) * 100) || 0,
        gate_card_fee_cents: Math.round(parseFloat(v.fee) * 100) || 0,
      };
      // Empty means "leave it alone", so saving the cap can't wipe the token.
      if (String(v.token).trim()) body.beeminder_auth_token = String(v.token).trim();
      if (String(v.user).trim()) body.beeminder_user = String(v.user).trim();
      const res = await apiSend('/api/gates/billing', 'PATCH', body);
      if (!res.ok) return `Save failed (${res.status}).`;
      await renderGatesBilling(true);
      return null;
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
    ${opts.badge ? `<span class="be-row-badge">${escHtml(opts.badge)}</span>` : ''}
    <span class="be-chev">›</span>
  </button>`;
}

function beAddRow(label) {
  return `<button class="be-add-row" data-add="1">+ ${escHtml(label)}</button>`;
}

// Wires a list's rows and its one add affordance to the sheet.
function wireBeList(el, kind, items) {
  el.querySelectorAll('[data-row]').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = items.find(i => String(i.id != null ? i.id : i.key) === btn.dataset.row);
      if (item) openSeSheet(kind, item);
    });
  });
  const add = el.querySelector('[data-add]');
  if (add) add.addEventListener('click', () => openSeSheet(kind, null));
}

// ── Wiring, open, close ──────────────────────────────────────

function initBlockEditor() {
  document.getElementById('modal-close').addEventListener('click', closeBlockEditor);
  document.getElementById('be-back').addEventListener('click', backToSettingsIndex);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') closeBlockEditor();
  });
  document.getElementById('se-sheet-backdrop').addEventListener('click', closeSeSheet);

  document.getElementById('be-download-ics-btn').addEventListener('click', async () => {
    const btn = document.getElementById('be-download-ics-btn');
    const status = document.getElementById('be-ics-status');
    btn.disabled = true;
    status.textContent = 'Saving…';
    const res = await apiSend('/api/blocks/export-ics', 'POST');
    const data = await res.json();
    btn.disabled = false;
    status.textContent = res.ok ? `Saved to ${data.path}` : 'Error';
  });
}

async function openBlockEditor() {
  const [projects, domains, blocks, locations] = await Promise.all([
    fetch('/api/areas').then(r => r.json()),
    apiGet('/api/domains', []),
    fetch('/api/blocks').then(r => r.json()),
    fetch('/api/locations').then(r => r.json()),
  ]);
  state.locations = locations;
  state.areas = projects;
  state.domains = domains;
  renderBeAreas(projects);
  renderBeDomains();
  renderBeBlocks(blocks);
  await renderQrManager();
  renderBeRecurring(await apiGet('/api/recurring', []), projects);
  renderBeOccasions(await apiGet('/api/occasions', []));
  // Loaded on OPEN, not only when the section is entered: the index states
  // "N metrics" beside the row, and a count that reads 0 until you tap it is
  // worse than no count.
  await loadMetrics();
  renderMetricsSettings();
  renderBeCalendars(await apiGet('/api/calendars', []));
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
  const [projects, domains, blocks, gcal, calendars] = await Promise.all([
    fetch('/api/areas').then(r => r.json()),
    apiGet('/api/domains', []),
    fetch('/api/blocks').then(r => r.json()),
    fetch('/api/gcal').then(r => r.json()),
    apiGet('/api/calendars', []),
  ]);
  state.areas = projects;
  state.domains = domains;
  state.blocks = blocks;
  state.gcalEvents = gcal;
  state.calendars = calendars;
  // Domains and area assignments can have changed in here, so section 2's
  // obligation may now be a different one. This goes before renderTimeline so a
  // timeline failure (a dead gate fetch, say) can't take section 2 down with it.
  state.activeDomainId = state.activeAreaId ? domainIdForArea(state.activeAreaId) : null;
  state.section2OverrideDomainId = null;
  state.section2OverrideItems = null;
  await refreshActiveItems();
  renderTimeline();
}

async function refreshBlockEditor() {
  const [projects, domains, blocks] = await Promise.all([
    fetch('/api/areas').then(r => r.json()),
    apiGet('/api/domains', []),
    fetch('/api/blocks').then(r => r.json()),
  ]);
  state.areas = projects;
  state.domains = domains;
  renderBeAreas(projects);
  renderBeDomains();
  renderBeBlocks(blocks);
  renderInbox();
}

async function refreshCalendars() {
  renderBeCalendars(await fetch('/api/calendars').then(r => r.json()));
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
    ${state.occasions.length ? '' : '<div class="be-empty">No occasions yet. '
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

function renderBeCalendars(calendars) {
  const list = document.getElementById('be-calendars-list');
  if (!list) return;
  beCounts.calendars = calendars.filter(c => c.active).length;
  list.innerHTML = calendars.map(c => beRow({
    id: c.id, color: c.color, name: c.name, dim: !c.active,
    meta: c.active ? 'On the timeline' : 'Off the timeline',
    badge: c.active ? '' : 'paused',
  })).join('') + beAddRow('Add calendar');
  wireBeList(list, 'calendar', calendars);
}

function renderBeAreas(projects) {
  const list = document.getElementById('be-areas-list');
  if (!list) return;
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
function renderBeDomains() {
  const list = document.getElementById('be-domains-list');
  if (!list) return;
  const counts = {};
  state.areas.forEach(a => {
    if (a.domain_id) counts[a.domain_id] = (counts[a.domain_id] || 0) + 1;
  });
  list.innerHTML = state.domains.map(d => beRow({
    id: d.id, name: d.name, dim: d.active === 0,
    meta: plural(counts[d.id], 'area'),
    badge: d.active === 0 ? 'paused' : d.is_default ? 'default' : '',
  })).join('') + beAddRow('Add domain');
  wireBeList(list, 'domain', state.domains);
}

function groupBlocks(blocks) {
  const groups = new Map();
  for (const b of blocks) {
    const key = `${b.label}|${b.color}|${b.start_time}|${b.end_time}|${b.area_id ?? ''}|${b.location_id ?? ''}`;
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
  if (isConsecutive) return `${DAY_NAMES[sorted[0]]}–${DAY_NAMES[sorted[sorted.length - 1]]}`;
  return sorted.map(d => DAY_NAMES[d]).join(', ');
}

function renderBeBlocks(blocks) {
  const list = document.getElementById('be-blocks-list');
  if (!list) return;
  // A block row's identity is its GROUP, which has no server id — index it.
  const groups = groupBlocks(blocks).map((g, i) => ({ ...g, id: `g${i}` }));
  beCounts.blocks = groups.length;
  list.innerHTML = groups.map(g => {
    // A change dated forward is part of what this block IS from that day, so
    // the row says so — the whole point is not having to remember it.
    const changes = blockGroupChanges(g);
    const from = changes.length
      ? changes.map(c => c.effective_date).sort()[0] : null;
    return beRow({
      id: g.id, color: g.color, name: g.label,
      dim: !g.rows.some(r => r.active),
      meta: `${formatDays(g.days)} · ${g.start_time}–${g.end_time}`,
      sub: [g.project_name, g.location_name,
            from ? `changes ${seWhenLabel(from)}` : null].filter(Boolean).join(' · '),
      badge: g.rows.some(r => r.active) ? (from ? 'scheduled' : '') : 'paused',
    });
  }).join('') + beAddRow('Add block');
  wireBeList(list, 'block', groups);
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
    const days = (t.days_of_week || '').split('').map(d => DAY_NAMES[parseInt(d)]).join(', ');
    return `${days} ${every(t.interval, 'week')}`;
  }
  if (t.kind === 'monthly_nth') return `${ordinalNth(t.nth)} ${DAY_NAMES[t.weekday]} ${every(t.interval, 'month')}`;
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
    sub: [byId[t.area_id] ? byId[t.area_id].name : null, projectName(t.project_id),
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
  const defaultArea = state.areas.find(p => p.is_default && p.active && p.type === 'standard');
  const newProjectId = newBlock
    ? newBlock.area_id
    : (defaultArea ? defaultArea.id : null);
  if (newProjectId === state.activeAreaId) return;
  state.activeBlock = newBlock;
  state.activeAreaId = newProjectId;
  const newDomainId = newProjectId ? domainIdForArea(newProjectId) : null;
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
  // The engage pool follows the block calendar's domain unless the chip was
  // deliberately pointed elsewhere.
  if (domainChanged && engageView.domainId !== newDomainId && newDomainId) {
    engageView.domainId = newDomainId;
    await refreshEngage();
  }
  // The inbox processing view suggests the current block's area; follow the
  // block change unless the user is mid-edit inside the inbox.
  const inboxSection = document.getElementById('inbox-section');
  if (inboxSection && !inboxSection.contains(document.activeElement)) renderInbox();
}

// ── Midnight: the day's routines start over ──────────────────
//
// The app is left open for days at a time. Every day-scoped FETCH already
// computes its date at call time, so nothing is wrong with what the server
// says — what rots is the data sitting in state from before midnight: the
// routine fold-out still showing yesterday's ticks, the daily checklist still
// crossed off, the timeline still pointed at yesterday. This rides
// checkActiveBlock's 60s tick and also runs when the window comes back (a
// phone sleeps through midnight rather than ticking through it), and reloads
// the day the moment the local date moves.
//
// The RUNNER is the deliberate exception, see creditFlowStep: a run credits
// the day it was OPENED on, so a night routine finished at 00:05 files against
// the night it started and the new day does not begin already ticked.
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
  toast('New day — routines start over');
}

// ── Weekly Review (GTD) ──────────────────────────────────────
// Allen's three-phase drill, as a checklist that persists per week. The three
// counts and the stalled-project list are the parts a paper checklist can't do:
// "every active project has a next action" is the review's load-bearing check
// and it is not runnable by hand.

// The inboxes "collect loose papers" actually means for THIS setup. Ticking
// them is per-week state, stored as `collect:<slug>` in the review's own
// {key: timestamp} blob — no migration, which is why that shape was chosen.
//
// EDIT THIS LIST. It is deliberately a plain constant rather than a table:
// the set changes when your life changes, not often, and a table would need a
// manager screen to earn itself. Counts in the hints are what was actually
// sitting there on 2026-08-10.
const COLLECT_INBOXES = [
  { key: 'physical', label: 'Desk, bag, pockets, wallet, notebook',
    hint: 'Anything paper or physical that is standing in for a thought.' },
  { key: 'downloads', label: 'Downloads + Desktop',
    hint: 'Files you saved meaning to do something with.' },
  { key: 'drive', label: 'Google Drive root',
    hint: '103 loose files as of 2026-08-10 — the biggest unprocessed pile you own.' },
  { key: 'email_princeton', label: 'Princeton email' },
  { key: 'email_sf', label: 'Sentient Futures email' },
  { key: 'email_personal', label: 'Personal email' },
  { key: 'slack', label: 'Slack — DMs, mentions, saved items' },
  { key: 'asana', label: 'Asana' },
  { key: 'github', label: 'GitHub notifications, review requests, open PRs' },
  { key: 'granola', label: 'Granola meeting notes',
    hint: 'Action items from the week\'s recordings.' },
  { key: 'phone', label: 'Phone — notes, voice memos, screenshots, camera roll' },
  { key: 'messages', label: 'Texts, WhatsApp, LinkedIn' },
  { key: 'browser', label: 'Open browser tabs',
    hint: 'A tab you have not closed is an undecided action.' },
  { key: 'paper_mail', label: 'Physical mail' },
];

// THE WEEKLY REVIEW IS A ROUTINE (2026-08-12). Its steps are flow_step rows on
// a period-'week' flow and its ticks live in that flow's flow_run, so the
// fold-out below and the routine runner are two views of ONE run: tick a step
// here, it is credited there. What was GTD_STEPS is now this registry — the
// step→SURFACE binding, joined to the step by its KIND (`content` is the
// wording, and the user's to rewrite; the kind is the identity).
//
// A kind may bind three things: `phase` (which of Allen's three it belongs
// under), a live COUNT or list the step is judged against, and an `act` — the
// button that does the step from where you read it. Only two of the eleven have
// a runner page so far (see renderFlowRun); the rest state themselves and take
// the tick.
const REVIEW_KINDS = {
  review_collect: { phase: 'Get Clear', collect: true,
    hint: 'Every inbox you own, swept into "in".' },
  review_in_zero: { phase: 'Get Clear', count: 'inbox', act: 'clarify',
    hint: 'Every item through the clarify tree. Be ruthless; purge what isn\'t needed.' },
  review_sweep: { phase: 'Get Clear', act: 'sweep',
    hint: 'Five minutes, no stopping. Anything still in your head that isn\'t written down.' },

  review_cal_back: { phase: 'Get Current', act: 'pass_back',
    hint: 'Uncaptured follow-ups. Archive the past with nothing left in it.' },
  review_cal_fwd: { phase: 'Get Current', act: 'pass_fwd',
    hint: 'Anything needing preparation that starts now.' },
  review_waiting: { phase: 'Get Current', waiting: true,
    hint: 'What\'s owed to you? What needs chasing?' },
  // MERGED (2026-08-17). 'Review next-action lists' and 'Every active project
  // has a next action' were one question asked twice, and the first was vague
  // enough to be ticked without doing anything. One step, one list: every
  // active project with the actions under it, the empty ones called out. It
  // keeps `pushed` because the repeatedly-deferred items are next-action
  // information and had nowhere else to go.
  review_projects: { phase: 'Get Current', projects: true, pushed: true,
    act: 'map_projects',
    hint: 'Every project needs one. Anything with none is stalled or dead — decide which.' },
  review_checklists: { phase: 'Get Current' },

  review_someday: { phase: 'Get Creative', count: 'someday',
    hint: 'Activate what\'s ripe, delete what\'s outlived your interest, add new.' },
  review_creative: { phase: 'Get Creative',
    hint: 'Anything new worth capturing into the system.' },
  // The habit/experiment tally used to render BELOW the steps, so it was read
  // but never ticked and never counted toward the review's completion — and
  // the runner, which walks steps, never showed it at all. It is a step now.
  review_habits: { phase: 'Get Creative', habits: true,
    hint: 'Graduate what stuck, drop what didn\'t, judge resolved experiments.' },
};

// ▶ IS A DRAWING, NOT A CHARACTER (2026-08-17). U+25B6 gets claimed by the
// emoji font on Windows: it paints blue whatever `color` says, and its glyph
// metrics sit it off the baseline of the text beside it. One helper, so every
// run affordance says it the same way and inherits the ink around it.
function playMark(size = 11) {
  return `<svg class="play-mark" viewBox="0 0 12 12" width="${size}" height="${size}"`
    + ` fill="currentColor" aria-hidden="true"><path d="M2.5 1.2 L10.2 6 L2.5 10.8 Z"/></svg>`;
}

// The runner's wording for the "go and do it" button, per act. The fold-out
// writes its own inline; both open the same surface, so only the phrasing
// differs — the runner is one step per page and can afford the full sentence.
const FR_ACT_LABELS = {
  map_projects: 'Open MAP · Projects',
  map_someday: 'Open MAP · Someday',
  map_waiting: 'Open MAP · Waiting',
  pass_back: 'Walk it back 14 days',
  pass_fwd: 'Walk the next 14 days',
  lists: 'Open Lists',
};

// EVERY active project with the actions under it — the surface of the merged
// step. SERVER-COMPOSED (`counts.project_list`, actions gathered over the whole
// subtree, someday projects excluded); the client only renders it, so "does
// this project have a next action?" is answered in exactly one place and the
// list you read cannot disagree with the verdict you are given.
//
// One function, used by BOTH the fold-out and the runner page — the same reason
// the ticks are one store: two renderings of one question drift.
function reviewProjectsHtml(counts) {
  const ps = (counts && counts.project_list) || [];
  if (!ps.length) return '<div class="gr-proj-sum">No active projects.</div>';
  const stalled = ps.filter(p => !(p.actions || []).length).length;
  return `<div class="gr-projects">
    <div class="gr-proj-sum">${ps.length} active project${ps.length === 1 ? '' : 's'} · ${
      stalled ? `<b>${stalled} with no next action</b>` : 'all covered'}</div>
    ${ps.map(p => `
      <div class="gr-proj${(p.actions || []).length ? '' : ' gr-proj-stalled'}">
        <div class="gr-proj-head">
          <span class="gr-proj-name">${escHtml(p.content)}</span>
          <span class="gr-list-meta">${escHtml(p.area_name || '—')}</span>
        </div>
        ${(p.actions || []).length
          ? `<ul class="gr-list gr-proj-acts">${p.actions.map(a =>
              `<li><span>${escHtml(a.content)}</span><span class="gr-list-meta">${
                [a.status === 'waiting' ? 'waiting' : '',
                 a.defer_until ? 'from ' + a.defer_until : '',
                 a.pushed >= 3 ? 'pushed ' + a.pushed + 'x' : '']
                  .filter(Boolean).join(' · ')}</span></li>`).join('')}</ul>`
          : '<div class="gr-proj-none">no next action — decide: a next step, someday, or done</div>'}
      </div>`).join('')}
  </div>`;
}

// A step added to the review flow by hand is not in the registry and has no
// surface to bind — it still renders, under its own heading, and still ticks.
function reviewKind(step) {
  return REVIEW_KINDS[step.kind] || { phase: 'Yours' };
}

let gtdReview = null;

// The steps of the review, as the flow says them. Empty until the fold-out has
// been opened once (it is what fetches the flow).
function reviewSteps() {
  return (gtdReview && gtdReview.flow && gtdReview.flow.steps) || [];
}

// The ticks of THIS week's run. One store, shared with the runner: keys are
// step ids, plus '<step_id>:<sub>' for the collect sweep's per-inbox rows.
function reviewTicks() {
  if (!gtdReview || !gtdReview.flow || !gtdReview.flow.run) return {};
  try { return JSON.parse(gtdReview.flow.run.steps || '{}'); } catch (e) { return {}; }
}

// The weekly review is a fold-out at the top of LISTS, toggled by
// #gtd-review-head. No modal. It moved there when the GTD tab was removed
// (2026-08-16): the tab's four lists were MAP's lenses said twice, and the
// review is a ROUTINE, so it belongs where the routines are.
async function openGtdReview() {
  const today = wallDay();
  const [review, habits, flows] = await Promise.all([
    fetch('/api/gtd-review').then(r => r.json()),
    apiGet('/api/habits', null),
    apiGet(`/api/flows?date=${today}`, []),
  ]);
  gtdReview = review;
  gtdReview.habits = habits;
  gtdReview.flow = (Array.isArray(flows) ? flows : []).find(f => f.id === review.flow_id) || null;
  renderGtdReview();
  document.getElementById('review-panel').classList.remove('hidden');
  updateReviewNavDot();
}

// Write one tick into the run. The runner's own completion rule (every step of
// today's run credited) applies here too, so finishing the review from the
// checklist completes the routine — the two surfaces cannot disagree.
async function setReviewTick(key, done) {
  if (!gtdReview || !gtdReview.flow) return;
  const ticks = reviewTicks();
  if (done) ticks[key] = 'done'; else delete ticks[key];
  const complete = reviewSteps().every(s => ticks[s.id]);
  const run = await apiSend(`/api/flows/${gtdReview.flow.id}/run`, 'PUT', { date: runDay(), steps: ticks, completed: complete }).then(r => r.json()).catch(() => null);
  if (run) gtdReview.flow.run = run;
  renderGtdReview();
  updateReviewNavDot();
}

function initGtdReviewFold() {
  document.getElementById('gtd-review-head').addEventListener('click', () => {
    const panel = document.getElementById('review-panel');
    if (panel.classList.contains('hidden')) openGtdReview();
    else panel.classList.add('hidden');
  });
  // RUN IT AS A ROUTINE: the same steps, one per page, in the runner every
  // other routine uses. A span, not a button — it sits inside the fold-out's
  // own button, and it must not toggle it.
  const run = document.getElementById('gtd-review-run');
  if (run) run.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    const id = (gtdReview && gtdReview.flow_id)
      || await fetch('/api/gtd-review').then(r => r.json()).then(r => r.flow_id).catch(() => null);
    if (id) openFlowRun(id);
    else toast('The review routine is missing');
  });
}

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

function habitReviewHtml(hb) {
  if (!hb) return '';
  const ex = hb.experiments || {};
  // Experiments are STARTED and RESOLVED in the journal — that is where the
  // day gets written down. The review only EVALUATES what is already resolved,
  // and promotion is rationed: ONE experiment becomes a habit per review week,
  // so the rest wait (which is simply not acting on them).
  const spent = (ex.promoted_this_week || []).length > 0;
  const exBlock = `
    <div class="gr-ht-head">Resolved experiments</div>
    ${ex.running ? `<div class="gr-ht-line">${escHtml(ex.running.content)}
        <span class="gr-ht-counts">still running — resolve it in the journal</span></div>` : ''}
    ${spent ? `<div class="gr-ht-counts">promoted this week: ${
      escHtml(ex.promoted_this_week[0].content)} — the rest wait for next review</div>` : ''}
    ${(ex.awaiting || []).length ? ex.awaiting.map(e => `<div class="gr-ht-line" data-exid="${e.id}">
      ${escHtml(e.content)} <span class="gr-ht-counts">resolved: ${escHtml(e.resolution || '—')}</span>
      <span class="gr-ht-verbs">
        ${spent ? '' : '<button class="cl-pill" data-exverb="habit" title="promote it: start forming it as a tracked habit. One per week.">make a habit</button>'}
        <button class="cl-pill" data-exverb="extend" title="do something with it yourself, off the tracker — no habit is created">adapt</button>
        <button class="cl-pill" data-exverb="wait" title="leave it resolved; it will be here next review">wait</button>
        <button class="cl-pill" data-exverb="drop">drop</button>
      </span></div>`).join('')
      : '<div class="gr-ht-counts">nothing resolved to judge — experiments start in the journal</div>'}`;
  const hbBlock = (hb.forming || []).length ? `
    <div class="gr-ht-head">Habits forming</div>
    ${hb.forming.map(h => {
      const t = h.tally;
      const asked = t.effort_answered;
      return `<div class="gr-ht-line" data-hbid="${h.id}">
        ${habitHealthDot(t)} <b>${escHtml(h.content)}</b>
        <span class="gr-ht-counts">great ${t.great} · good ${t.good} · ehh ${t.ehh}${
          asked ? ` · on its own ${t.auto_recent}/${asked} of last 10d` : ''}</span>
        ${h.suggest ? '<span class="gr-ht-suggest">30+ days, mostly automatic — graduate?</span>' : ''}
        <span class="gr-ht-verbs">
          <button class="cl-pill${h.suggest ? ' cl-pill-on' : ''}" data-hbverb="graduated">graduate</button>
          <button class="cl-pill" data-hbverb="continue">continue</button>
          <button class="cl-pill" data-hbverb="dropped">drop</button>
        </span></div>`;
    }).join('')}
    ${hb.forming.length > 3 ? `<div class="gr-ht-counts">${hb.forming.length} habits forming — the marks get less honest as this grows.</div>` : ''}`
    : '';
  return `<div class="gr-habit-tally">${exBlock}${hbBlock}</div>`;
}

async function habitVerb(id, verb, name) {
  if (verb === 'continue') { toast(`continuing: ${name}`); return; }
  // A habit ends in the same sheet an experiment does — it is the same kind of
  // act, and the verdict is the same kind of line. Optional here, unlike an
  // experiment's resolution: nothing downstream has to act on it.
  openEndSheet({
    title: verb === 'graduated' ? 'Graduate the habit' : 'Drop the habit',
    subject: name,
    meta: verb === 'graduated' ? 'it runs on its own — stop tracking it'
                               : 'a verdict, not a failure',
    label: 'One line for the ledger',
    placeholder: verb === 'graduated' ? 'what made it stick?' : 'why drop it?',
    actions: [{
      label: verb === 'graduated' ? 'Graduate it' : 'Drop it',
      run: async verdict => {
        const res = await apiSend(`/api/habits/${id}`, 'PATCH',
                                  { status: verb, verdict: verdict || null });
        if (!res.ok) { toast('could not end it'); return false; }
        pushUndo(`${verb === 'graduated' ? 'graduated' : 'dropped'} "${name}"`, async () => {
          await apiSend(`/api/habits/${id}`, 'PATCH', { status: 'forming' });
          await openGtdReview();
        });
        toast(`${verb}: ${name}`);
        await openGtdReview();
        return true;
      },
    }],
  });
}

async function experimentVerb(id, verb, name) {
  // WAIT is the honest no-op: the experiment is already resolved-and-awaiting,
  // so choosing to leave it writes nothing. It exists as a button because
  // "I considered it and left it" and "I never looked" should not be the same
  // gesture.
  if (verb === 'wait') { toast(`left for next review: ${name}`); return; }
  const res = await apiSend(`/api/habit-experiments/${id}`, 'PATCH', { outcome: verb });
  if (!res.ok) { toast((await res.json()).error || 'could not evaluate'); return; }
  // Undoing an evaluation also unmints the habit it may have created — half
  // an undo would strand a habit nothing decided on.
  pushUndo(`${verb === 'habit' ? 'promoted' : verb + 'ed'} experiment "${name}"`, async () => {
    await apiSend(`/api/habit-experiments/${id}`, 'PATCH', { outcome: 'resolved' });
    await openGtdReview();
  });
  toast(verb === 'habit' ? `now forming: ${name}` : `${verb}: ${name}`);
  await openGtdReview();
}

// ── Reordering the phases ────────────────────────────────────
//
// A phase is not a row: it is a RUN of consecutive steps that share a
// `REVIEW_KINDS[kind].phase`, and the header appears wherever that value
// changes as the steps are walked in `position` order. So dragging a header
// moves the steps under it — the only thing the store knows — and the header
// follows because it was never anything but a label on the order.
//
// Clear → Current → Creative is Allen's sequence, not a law: what has to stay
// true is that the steps of one phase remain CONTIGUOUS, or the fold-out would
// print the same header twice. Moving whole runs is what guarantees that.
function reviewPhaseOrder(panel) {
  return [...panel.querySelectorAll('.gr-phase[data-phase]')].map(el => el.dataset.phase);
}

// The steps of every phase, in their own order, concatenated in the order the
// phases are given — then renumbered from 1. Only the steps that actually
// moved are written.
async function saveReviewPhaseOrder(order) {
  const steps = reviewSteps();
  const next = [];
  order.forEach(p => steps.forEach(s => {
    if (reviewKind(s).phase === p) next.push(s);
  }));
  // A step whose phase is not in the list (a kind added since, or one of your
  // own) keeps its place at the end rather than being dropped from the write.
  steps.forEach(s => { if (!next.includes(s)) next.push(s); });
  const moved = next.filter((s, i) => s.position !== i + 1);
  await Promise.all(next.map((s, i) => s.position === i + 1 ? null
    : apiSend(`/api/flow-steps/${s.id}`, 'PATCH', { position: i + 1 })).filter(Boolean));
  return moved.length;
}

// The nearest ancestor that actually scrolls. Needed because a drag takes
// pointer capture and `touch-action: none`, so the page cannot scroll itself
// while one is live — and the three phases are ~1400px on a 930px screen, which
// would make "move Get Creative to the top" a gesture that cannot be performed
// on the phone this app is shaped for.
// Starts at the element ITSELF: the review fold-out is its own scroller
// (#review-panel is overflow-y:auto inside a fixed-height overlay), so walking
// straight to the parent found the document, which does not scroll here — and
// the auto-scroll silently did nothing.
function scrollParentOf(el) {
  for (let p = el; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement || document.documentElement;
}

// Hold the pointer near an edge and the list keeps coming, the way a drag
// against the edge behaves everywhere else. A rAF loop rather than a reaction
// to pointermove, because a finger held STILL at the edge fires no events and
// would otherwise stall an inch from the target.
function edgeAutoScroll(scroller) {
  const ZONE = 64, STEP = 14;
  let y = null, raf = null;
  const tick = () => {
    raf = null;
    if (y == null) return;
    const r = scroller === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
    let d = 0;
    if (y < r.top + ZONE) d = -STEP;
    else if (y > r.bottom - ZONE) d = STEP;
    if (d) {
      scroller.scrollTop += d;
      raf = requestAnimationFrame(tick);
    }
  };
  return {
    at(clientY) { y = clientY; if (!raf) raf = requestAnimationFrame(tick); },
    stop() { y = null; if (raf) cancelAnimationFrame(raf); raf = null; },
  };
}

function wireReviewPhaseDrag(panel) {
  const heads = panel.querySelectorAll('.gr-phase[data-phase] > .gr-phase-name');
  if (heads.length < 2) return;               // nothing to reorder against
  heads.forEach(head => {
    const box = head.parentElement;
    let scroll = null;
    onPointerDrag(head, { start(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return null;
      const before = reviewPhaseOrder(panel);
      box.classList.add('gr-phase-dragging');
      document.body.style.cursor = 'grabbing';
      scroll = edgeAutoScroll(scrollParentOf(panel));
      // A long press that becomes a drag must not also fire the click.
      if (e.pointerType !== 'mouse') head.dataset.lpDragged = '1';
      return {
        // Reordered live in the DOM, so the drop lands where you saw it —
        // there is no separate preview to keep in step with the real thing.
        move(clientY) {
          scroll.at(clientY);
          for (const other of panel.querySelectorAll('.gr-phase[data-phase]')) {
            if (other === box) continue;
            const r = other.getBoundingClientRect();
            if (clientY < r.top || clientY > r.bottom) continue;
            const above = clientY < r.top + r.height / 2;
            other.parentNode.insertBefore(box, above ? other : other.nextSibling);
            break;
          }
        },
        async end() {
          scroll.stop();
          box.classList.remove('gr-phase-dragging');
          document.body.style.cursor = '';
          const after = reviewPhaseOrder(panel);
          if (after.join('|') === before.join('|')) return;
          const moved = await saveReviewPhaseOrder(after);
          if (!moved) return;
          // Every data-changing gesture ships its inverse, drags included.
          pushUndo(`moved "${box.dataset.phase}"`, async () => {
            await saveReviewPhaseOrder(before);
            await openGtdReview();
          });
          await openGtdReview();
        },
      };
    } });
  });
}

function renderGtdReview() {
  const panel = document.getElementById('review-panel');
  if (!panel || !gtdReview) return;
  const counts = gtdReview.counts;
  const steps = reviewSteps();
  const ticks = reviewTicks();
  const done = steps.filter(s => ticks[s.id]).length;

  const badge = s => {
    if (s.stalled) {
      const n = counts.stalled.length;
      return `<span class="gr-badge${n ? ' gr-badge-bad' : ' gr-badge-ok'}">${n ? `${n} stalled` : 'all covered'}</span>`;
    }
    // Waiting-for and deferred are two different parks, so the step that
    // reviews both shows both. This step asked for a waiting count for a long
    // time and had nothing to count until 'waiting' became a real state.
    if (s.waiting) {
      const w = counts.waiting || 0;
      const d = counts.deferred || 0;
      return `<span class="gr-badge${w ? '' : ' gr-badge-ok'}">${w} waiting · ${d} deferred</span>`;
    }
    if (!s.count) return '';
    const n = counts[s.count];
    const ok = s.count === 'inbox' ? n === 0 : true;
    return `<span class="gr-badge${ok && s.count === 'inbox' ? ' gr-badge-ok' : ''}">${n} ${
      s.count === 'inbox' ? 'in "in"' : s.count === 'deferred' ? 'deferred' : 'maybe'}</span>`;
  };

  // Sub-steps keep the same shape as steps: a key in the blob, ticked with a
  // timestamp. Their own row so a half-done sweep is visible next week. The key
  // is '<step_id>:<inbox>' now the run belongs to the routine.
  const subKey = (s, b) => `${s.id}:${b.key}`;
  const collectList = s => {
    const swept = COLLECT_INBOXES.filter(b => ticks[subKey(s, b)]).length;
    return `<div class="gr-sub">
      <div class="gr-sub-head">${swept}/${COLLECT_INBOXES.length} swept</div>
      ${COLLECT_INBOXES.map(b => `
        <label class="gr-sub-item${ticks[subKey(s, b)] ? ' gr-sub-done' : ''}">
          <input type="checkbox" class="gr-cb" data-step="${subKey(s, b)}"${
            ticks[subKey(s, b)] ? ' checked' : ''}>
          <span><span class="gr-sub-label">${escHtml(b.label)}</span>${
            b.hint ? `<span class="gr-step-hint">${escHtml(b.hint)}</span>` : ''}</span>
        </label>`).join('')}
    </div>`;
  };

  const rowList = (rows, meta) => (rows || []).length
    ? `<ul class="gr-list">${rows.map(r =>
        `<li><span>${escHtml(r.content)}</span><span class="gr-list-meta">${escHtml(meta(r))}</span></li>`
      ).join('')}</ul>`
    : '';
  const waitingList = rowList(counts.waiting_list,
    r => `${r.area_name || '—'} · since ${(r.captured_at || '').slice(0, 10)}`);
  // Repeatedly "not today"-ed. The daily list deliberately never shows this —
  // a running tally there would be a guilt tax on a surface glanced at dozens
  // of times a day. Here it is exactly the right signal.
  const pushedList = rowList(counts.pushed_list,
    r => `${r.area_name || '—'} · pushed ${r.pushed}x`);

  let html = '';
  let phase = null;
  steps.forEach(step => {
    const s = reviewKind(step);
    if (s.phase !== phase) {
      if (phase) html += '</div>';
      phase = s.phase;
      html += `<div class="gr-phase" data-phase="${escHtml(phase)}">`
        + `<div class="gr-phase-name" title="Drag to reorder the phases">${escHtml(phase)}</div>`;
    }
    const isDone = !!ticks[step.id];
    html += `
      <label class="gr-step${isDone ? ' gr-step-done' : ''}">
        <input type="checkbox" class="gr-cb" data-step="${step.id}"${isDone ? ' checked' : ''}>
        <span class="gr-step-body">
          <span class="gr-step-label">${escHtml(step.content)}${badge(s)}</span>
          ${s.hint ? `<span class="gr-step-hint">${escHtml(s.hint)}</span>` : ''}
          ${s.collect ? collectList(step) : ''}
          ${s.act === 'clarify' ? `<button class="gr-act" data-act="clarify">Clarify ${
            counts.inbox} →</button>` : ''}
          ${s.act === 'sweep' ? `<button class="gr-act" data-act="sweep">${playMark(9)} 5-minute sweep</button>` : ''}
          ${s.act === 'pass_back' ? '<button class="gr-act" data-act="pass_back">' + playMark(9) + ' Walk it back 14 days</button>' : ''}
          ${s.act === 'pass_fwd' ? '<button class="gr-act" data-act="pass_fwd">' + playMark(9) + ' Walk the next 14 days</button>' : ''}
          ${s.act === 'map_projects'
            ? '<button class="gr-act" data-act="map_projects">' + playMark(9) + ' Open MAP · Projects</button>' : ''}
          ${s.projects ? reviewProjectsHtml(counts) : ''}
          ${s.waiting ? waitingList : ''}
          ${s.pushed ? pushedList : ''}
          ${s.habits ? habitReviewHtml(gtdReview.habits) : ''}
        </span>
      </label>`;
  });
  if (phase) html += '</div>';
  if (!steps.length) {
    html = `<div class="gtd-empty">The review routine is missing — it should be
      in ≡ Lists → routines as “Weekly review”.</div>`;
  }

  const weekLabel = new Date(gtdReview.week_start_date + 'T00:00:00')
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  panel.innerHTML = `
    <div class="gr-head">
      <span class="gr-week">Week of ${escHtml(weekLabel)}</span>
      <span class="gr-progress">${done} / ${steps.length}</span>
    </div>
    <div class="gr-criterion">Done when you can say: “I know right now everything I'm not doing but could be doing if I decided to.”</div>
    ${html}
    ${steps.some(st => reviewKind(st).habits) ? '' : habitReviewHtml(gtdReview.habits)}
    <div class="gr-footer">
      <label class="gr-field"><span>New habit (free text — experiments are the usual way in)</span>
        <input type="text" id="gr-habit" value="" placeholder="optional — starts forming this week, rated nightly"></label>
      <label class="gr-field"><span>Note</span>
        <input type="text" id="gr-note" value="${escHtml(gtdReview.note || '')}" placeholder="optional"></label>
      ${gtdReview.completed_at
        ? `<div class="gr-completed">Filed ${escHtml(gtdReview.completed_at)}</div>`
        : `<button id="gr-finish" class="be-btn-primary">Finish review</button>`}
    </div>`;

  // The two steps that are a DOING, not a ticking. A review step you can act
  // on from where you read it is a step that gets done.
  panel.querySelectorAll('.gr-act').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();      // the button sits inside the step's <label>
      if (btn.dataset.act === 'clarify') { openClarify(); return; }
      if (btn.dataset.act === 'pass_back') { startReviewPass('cal_back'); return; }
      if (btn.dataset.act === 'pass_fwd') { startReviewPass('cal_fwd'); return; }
      if (btn.dataset.act === 'map_projects') { openMapAtLens('projects'); return; }
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
        String(d.getDate()).padStart(2, '0')}`;
      openDangerousWriting({ goalKind: 'time', goalTime: 5, hardcore: false,
                             logName: `${iso} emptied`, autostart: true });
    });
  });

  // The tally renders INSIDE the review_habits step's <label> now, so a verb
  // click would also toggle that step's checkbox — judging a habit is not
  // saying the step is done. Same reason .gr-act stops the event.
  panel.querySelectorAll('[data-hbverb]').forEach(b => b.addEventListener('click', e_ => {
    e_.preventDefault();
    e_.stopPropagation();
    const row = b.closest('[data-hbid]');
    const h = gtdReview.habits.forming.find(x => x.id === parseInt(row.dataset.hbid));
    habitVerb(h.id, b.dataset.hbverb, h.content);
  }));
  panel.querySelectorAll('[data-exverb]').forEach(b => b.addEventListener('click', e_ => {
    e_.preventDefault();
    e_.stopPropagation();
    const row = b.closest('[data-exid]');
    const e = gtdReview.habits.experiments.awaiting.find(x => x.id === parseInt(row.dataset.exid));
    experimentVerb(e.id, b.dataset.exverb, e.content);
  }));
  panel.querySelectorAll('.gr-cb').forEach(cb => {
    cb.addEventListener('change', () => setReviewTick(cb.dataset.step, cb.checked));
  });
  wireReviewPhaseDrag(panel);

  const finish = document.getElementById('gr-finish');
  if (finish) {
    finish.addEventListener('click', async () => {
      finish.disabled = true;
      // The free-text path mints a real habit row (habit_week is history now);
      // the finish route no longer receives it.
      const newHabit = document.getElementById('gr-habit').value.trim();
      if (newHabit) {
        await apiSend('/api/habits', 'POST', { content: newHabit });
      }
      await apiSend('/api/gtd-review/finish', 'POST', {
          week: gtdReview.week_start_date,
          note: document.getElementById('gr-note').value,
        });
      // FILING THE REVIEW IS FINISHING THE ROUTINE. Deciding you are done is
      // the same act whichever surface you say it on, so the run is completed
      // here too — otherwise the runner would still show the week as open.
      if (gtdReview.flow) {
        await apiSend(`/api/flows/${gtdReview.flow.id}/run`, 'PUT', { date: runDay(),
                                 steps: reviewTicks(), completed: true });
      }
      state.review.due = false;
      updateReviewNavDot();
      await openGtdReview();
    });
  }
}

// ── Hub rail + mobile overlays (9c) ──────────────────────────
// The day is the whole screen; every reference surface is a full-screen
// overlay reached from the ≡ hub in the capture bar. One surface at a time.

function openM(id) {
  document.querySelectorAll('.m-overlay').forEach(o => o.classList.add('hidden'));
  document.getElementById('hub-overlay').classList.add('hidden');
  document.getElementById(id).classList.remove('hidden');
  renderBar();   // derived modes (✎ log / ✎ list / ◉ <list>) follow the surface
}

function closeM(id) {
  flushOpenNotes();
  const el = document.getElementById(id);
  el.classList.add('hidden');
  // The CRM raised above the runner returns to its own layer, and the routine
  // step it was opened from re-reads the night before it repaints.
  if (id === 'tab-people' && document.body.classList.contains('crm-over-runner')) {
    document.body.classList.remove('crm-over-runner');
    if (flowRunView.open) refreshCrmNight();
  }
  renderBar();
}

async function refreshCrmNight() {
  const night = await apiGet(`/api/people/night?date=${runDay()}`, null);
  flowRunView.crmFilled = !!(night && night.satisfied_at);
  flowRunView.crmKind = night ? night.kind : null;
  renderFlowRun();
}

function initHub() {
  const hub = document.getElementById('hub-overlay');
  // Tapping anywhere else closes the read-out — the backdrop is transparent and
  // covers the screen, so the day stays visible behind what is describing it.
  document.getElementById('gate-pop-backdrop')
    .addEventListener('click', closeGatePop);
  hub.addEventListener('click', e => { if (e.target === hub) hub.classList.add('hidden'); });
  document.querySelectorAll('.m-close').forEach(btn => {
    btn.addEventListener('click', () => closeM(btn.dataset.close));
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // The clarify sheet is the innermost layer wherever it was opened from —
    // initEngage's handler peels it. This listener is registered first, so
    // without this bail it would close the overlay out from under it.
    if (clarifyView.open) return;
    flushOpenNotes();
    // The gate read-out is the innermost layer wherever it is open (a popup
    // beside its pill, over the calendar), so it peels before anything else.
    if (gatePop.nodeId != null) { closeGatePop(); return; }
    if (!hub.classList.contains('hidden')) { hub.classList.add('hidden'); return; }
    // (MAP's rows open the clarify sheet, and the bail above lets the sheet
    // peel first; its filter menu peels just above, before the overlay loop.)
    // Settings peels the way it navigates (11a): sheet, then section, then the
    // panel itself — so Esc is Back, not Close, until there is nothing left.
    if (seSheet.kind) { closeSeSheet(); return; }
    // MAP's filter menu is a transient layer again (23a) — it peels before the
    // MAP overlay in the loop below, the way every sheet peels before what
    // opened it.
    if (closeMapFilter()) return;
    // A photo fills the screen over the logs overlay, so it peels first — before
    // that overlay's own filter menu, the way every raised layer does.
    if (logsView.photo != null) { closeLogPhoto(); return; }
    if (closeLogsFilter()) return;
    // The occasion sheet peels before whatever it was opened from — and that is
    // Settings as often as it is the day, so it has to sit ABOVE the overlay
    // loop below or Esc would close Settings out from under an open sheet.
    if (occasionView.open) { closeOccasionSheet(); return; }
    // Legacy modal overlays first (they sit above the m-overlays), innermost
    // wins; the person-detail/bucket/add trio stack over People.
    // Innermost first, and the order here IS the z-order: Settings (155) sits
    // above map/logs (150) and the .m-overlay band (140) because it opens over
    // whatever you already had up, so it peels before them.
    for (const id of ['person-add-overlay', 'bucket-mgr-overlay', 'person-detail-overlay',
                      'modal-overlay', 'map-overlay', 'logs-overlay']) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) {
        if (id === 'logs-overlay') closeLogsView();
        else if (id === 'modal-overlay' && settingsView.section) backToSettingsIndex();
        else el.classList.add('hidden');
        return;
      }
    }
    if (ctxSheet.tag) { closeCtxSheet(); return; }
    // The new-event sheet peels before the Calendar overlay it opened from
    // (the focused-input case stopPropagates and never reaches here).
    if (evSheet.open) { closeEvSheet(); return; }
    // The entry sheet likewise peels before whatever surface opened it.
    if (entrySheet.open) { closeEntrySheet(); return; }
    // The ending sheet, the same way — it opens over the routine runner,
    // Tracking and the weekly review, and peels before all three.
    if (endSheet.open) { closeEndSheet(); return; }
    // A dangerous-writing session swallows Esc entirely — its own keydown
    // handler treats Esc as the abort, and nothing underneath may act on it.
    if (dwView.open) return;
    // A step's settings sheet peels before the editor it opened from.
    if (stepSheet.id != null) {
      closeStepSheet();
      return;
    }
    // …except the CRM the runner itself raised above it: innermost first, so
    // Esc puts the People surface back down before it touches the routine.
    if (document.body.classList.contains('crm-over-runner')) {
      closeM('tab-people');
      return;
    }
    // The routine runner peels before anything under it.
    if (flowRunView.open) {
      closeFlowRun();
      return;
    }
    // Lists peels an open list / flow editor back one LEVEL first — a nested
    // list goes to its parent, everything else to the index.
    const refEl = document.getElementById('tab-lists');
    if (refEl && !refEl.classList.contains('hidden')
        && (refView.open != null || refView.openFlow != null)) {
      const openList = refView.lists.find(l => l.id === refView.open);
      refView.open = (openList && openList.parent_id) || null;
      refView.openFlow = null;
      renderRef();
      return;
    }
    // Social peels an open spec/log form before the overlay closes (the
    // focused-input case stopPropagates and never reaches here).
    const soEl = document.getElementById('tab-social');
    if (soEl && !soEl.classList.contains('hidden') && socialView.form) {
      socialView.form = null;
      renderSocial();
      return;
    }
    const open = [...document.querySelectorAll('.m-overlay:not(.hidden)')].pop();
    if (open) closeM(open.id);
  });
  document.querySelectorAll('.hub-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      hub.classList.add('hidden');
      const dest = btn.dataset.hub;
      if (dest === 'calendar') { openM('cal-overlay'); renderTimeline(); renderSheetsInbox(); }
      else if (dest === 'lists') {
        refView.open = null;
        refView.openFlow = null;
        openM('tab-lists');
        refreshRef();
      }
      else if (dest === 'map') { openMap(); }
      else if (dest === 'people') { openM('tab-people'); openPeopleSurface(); }
      else if (dest === 'tracking') { openM('tab-tracking'); openTracking(); }
      else if (dest === 'social') { socialView.form = null; openM('tab-social'); refreshSocial(); }
      else if (dest === 'logs') {
        logsView.logs = await fetch('/api/logs').then(r => r.json());
        logsView.open = null;
        // Unhide FIRST: renderLogs repaints the global bar, and the bar
        // derives its ✎ log mode from this overlay being visible.
        document.getElementById('logs-overlay').classList.remove('hidden');
        renderLogs();
      }
      else if (dest === 'settings') { openBlockEditor(); }
    });
  });
}


// ── Logs ─────────────────────────────────────────────────────

const logsView = { logs: [], open: null, content: '', dirty: false, saveTimer: null,
                   // Newest first: a log list is read from the top, and the
                   // one you want is nearly always the one you just wrote.
                   desc: true, tags: new Set(), menuOpen: false,
                   q: '', hits: null, qTimer: null,
                   // The open log's photos, in the order the markdown links
                   // them, and which one is being LOOKED at (null = none).
                   photos: [], photo: null };

// CHRONOLOGICAL, by the date parsed out of the filename — not by the filename.
// Sorting the name as text put November before August and 26-8-11 before
// 26-8-2, because the old names are unpadded, and the comment here used to
// claim name order WAS date order. It never was.
//
// An undated file (hand-made, or named something else entirely) sorts by when
// it was last touched, which is the only date it has.
function logDate(l) {
  return l.created || (l.updated_at || '').slice(0, 10);
}

function sortedLogs() {
  const rows = (logsView.hits || logsView.logs).filter(l =>
    [...logsView.tags].every(t => (l.tags || []).includes(t)));
  rows.sort((a, b) => logDate(a).localeCompare(logDate(b))
    || a.title.localeCompare(b.title));
  return logsView.desc ? rows.reverse() : rows;
}

// The vocabulary is whatever the corpus actually carries, plus anything already
// required — narrowing to a tag must never make its own chip vanish.
function logTagVocab() {
  return [...new Set([...logsView.logs.flatMap(l => l.tags || []), ...logsView.tags])].sort();
}

function closeLogsFilter() {
  if (!logsView.menuOpen) return false;
  logsView.menuOpen = false;
  renderLogsFilter();
  return true;
}

// Mirrors renderMapFilter: the pill NAMES what is showing, the menu is one tap
// away and shows exactly what is on.
function renderLogsFilter() {
  const pill = document.getElementById('logs-filter');
  const menu = document.getElementById('logs-filter-menu');
  if (!pill || !menu) return;
  const on = logsView.tags.size;
  pill.classList.toggle('hidden', !!logsView.open);
  pill.textContent = `${on ? `${on} tag${on === 1 ? '' : 's'}` : 'All logs'} ▾`;
  pill.classList.toggle('map-filter-on', !!on);
  pill.title = 'What the list is showing';

  menu.classList.toggle('hidden', !logsView.menuOpen);
  if (!logsView.menuOpen) { menu.innerHTML = ''; return; }
  const vocab = logTagVocab();
  menu.innerHTML = `
    <div class="map-filter-sec">Tags — every selected one required</div>
    <div class="map-filter-chips">
      ${vocab.length ? vocab.map(t => {
        const sel = logsView.tags.has(t);
        return `<button class="ctx-chip ${sel ? 'ctx-req' : 'ctx-off'}" data-logtag="${escHtml(t)}"
          title="${sel ? 'required — click to clear' : 'click to require'}"
          >${sel ? '∧' : ''}${escHtml(t)}</button>`;
      }).join('') : '<span class="cl-hint">no tags on any log yet</span>'}
    </div>
    <div class="map-filter-sec">Order</div>
    <div class="map-filter-chips">
      <button class="ctx-chip ${logsView.desc ? 'ctx-req' : 'ctx-off'}" data-logdesc="1">newest first</button>
      <button class="ctx-chip ${logsView.desc ? 'ctx-off' : 'ctx-req'}" data-logdesc="">oldest first</button>
    </div>
    ${on ? `<div class="map-filter-foot">
      <button class="ctx-chip" id="logs-filter-clear">⟳ show everything</button>
    </div>` : ''}`;
  // stopPropagation for the same reason MAP's menu does it: these handlers
  // re-render the menu, so the click would bubble to a target that no longer
  // exists and the menu would put itself away on its own chips.
  const stay = (el, fn) => el.addEventListener('click', e => {
    e.stopPropagation();
    fn();
    renderLogs();
  });
  menu.querySelectorAll('[data-logtag]').forEach(b => stay(b, () => {
    const t = b.dataset.logtag;
    if (logsView.tags.has(t)) logsView.tags.delete(t);
    else logsView.tags.add(t);
  }));
  menu.querySelectorAll('[data-logdesc]').forEach(b =>
    stay(b, () => { logsView.desc = !!b.dataset.logdesc; }));
  const clear = menu.querySelector('#logs-filter-clear');
  if (clear) stay(clear, () => logsView.tags.clear());
}

function initLogsView() {
  const overlay = document.getElementById('logs-overlay');
  document.getElementById('logs-close').addEventListener('click', closeLogsView);
  document.getElementById('logs-filter').addEventListener('click', e => {
    e.stopPropagation();
    logsView.menuOpen = !logsView.menuOpen;
    renderLogsFilter();
  });
  document.getElementById('logs-modal').addEventListener('click', e => {
    if (!e.target.closest('#logs-filter-menu, #logs-filter')) closeLogsFilter();
  });
  // A rotation or window resize changes the textarea's content width, which
  // would desync the highlight until the next keystroke. Registered once —
  // updateLogHighlight no-ops when the editor isn't open.
  window.addEventListener('resize', updateLogHighlight);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeLogsView();
  });
}

async function closeLogsView() {
  await flushLogSave();
  document.getElementById('logs-overlay').classList.add('hidden');
  logsView.open = null;
  renderBar();
  // No sync call on close: the PUT already wrote the file on the server, which
  // is the single copy every device reads. Logs used to be git-pushed from
  // here, which is what put personal writing under version control.
}

// ── Reference lists — GTD's non-actionable keeps ──────────────
//
// Books, movies, gifts, places: kept because they might matter, never
// actionable, so they live OUTSIDE the inbox_item inventory — no MAP row, no
// availability predicate, no review count. Two levels (index → one list),
// both written through the global bar's derived modes; the clarify sheet's
// Reference exit files an inbox item's text here (the missing half of GTD's
// non-actionable keep, next to Someday/Maybe).
const refView = { lists: [], open: null,
                  // Interactive routines (flows) share this surface: a
                  // ROUTINES section on the index, openFlow = the step editor.
                  flows: [], openFlow: null };

// 0=Mon..6=Sun, matching storage.step_due_on and every other days_of_week in
// the app. Empty = every day.
function stepDueToday(s, d) {
  // The server already answered this for the date it was asked about — the
  // weekday rule, the routine's PERIOD (a weekly one is not asked which weekday
  // its steps fall on) and pawning, all in storage.get_flows. Trust it where it
  // is there; the weekday fallback is for a step not fetched with a date.
  if (!d && s.due !== undefined) return !!s.due;
  const dow = jsDateToDayOfWeek(d || new Date());
  return !s.days_of_week || String(s.days_of_week).includes(String(dow));
}

async function refreshRef() {
  const today = wallDay();
  const [lists, flows, schedules] = await Promise.all([
    apiGet('/api/ref', refView.lists),
    apiGet(`/api/flows?date=${today}`, refView.flows),
    // A routine's own window resolves through here (flowWindow); unnamed=1
    // because a routine's hours, like a gate's, are private to it.
    fetch(`/api/schedules?date=${today}&unnamed=1`).then(r => r.json())
      .catch(() => state.schedules),
  ]);
  refView.lists = lists;
  refView.flows = flows;
  if (Array.isArray(schedules)) state.schedules = schedules;
  renderRef();
}

// A flow's deadline in display minutes, resolved from its linked gate the same
// way Engage resolves hairlines (today_override > weekly window > defaults),
// plus the ±offset — or the "before gate Y" anchor's deadline.
// A routine's OWN window for today: {open, due} in view minutes, or null when it
// has none and the gate-derived deadline is still the answer. The interval comes
// from /api/schedules?date=, which is where every other consumer reads a
// source's wall-clock answer — no second expander on the client.
// READ, never derived. This used to take (src.intervals || [])[0], but
// day_intervals is CLIPPED and sorted by start, so a 23:00→07:00 routine's
// from_previous tail sorts FIRST — the window read as 00:00–07:00 and the
// routine showed overdue all day while the judge charged against 07:00 the
// next morning. The server ships the same answer the judge uses.
function flowWindow(f) {
  if (!f || f.window_open_min == null || f.due_min == null) return null;
  return { open: f.window_open_min, due: f.due_min };
}

function flowWindowLabel(f) {
  const w = flowWindow(f);
  if (!w) return null;
  return `${clockHHMM(w.open)}–${clockHHMM(w.due)}`;
}

// Its own window where set, else the gate it is anchored to plus offset_min —
// all of it decided server-side by qr_judge.routine_deadline, the function that
// charges for it. Minutes from midnight of the flow's DATE, so a value over
// 1440 means the deadline is tomorrow morning; that is the case the client's
// own arithmetic used to lose.
function flowDueMin(f) {
  return f && f.due_min != null ? f.due_min : null;
}

// One list row, used by the index (root lists) and by an open list (its
// children): name, open-items count, a ▸n marker when it holds sublists.
function refListRow(l) {
  const subs = refView.lists.filter(x => x.parent_id === l.id).length;
  return `<div class="ref-row" data-id="${l.id}">
    <span class="ref-name" title="Tap to open · double-click to rename">${escHtml(l.name)}</span>
    ${subs ? `<span class="map-count" title="${subs} list${subs === 1 ? '' : 's'} inside">▸${subs}</span>` : ''}
    <span class="map-count">${l.items.filter(i => !i.done).length}</span>
    <button class="ref-del" data-id="${l.id}" title="Delete list">×</button>
  </div>`;
}

function renderRef() {
  const body = document.getElementById('ref-body');
  const title = document.getElementById('ref-title');
  if (!body) return;

  // The weekly review sits at the INDEX only — drilling into a list or a
  // routine is a different job, and the fold-out would be a second thing
  // competing for the top of a surface you came to read one list on.
  const atIndex = refView.openFlow == null && refView.open == null;
  const head = document.getElementById('gtd-review-head');
  if (head) head.classList.toggle('hidden', !atIndex);
  if (!atIndex) document.getElementById('review-panel').classList.add('hidden');

  const openFlow = refView.flows.find(f => f.id === refView.openFlow);
  if (openFlow) { renderFlowEditor(body, title, openFlow); return; }

  const open = refView.lists.find(l => l.id === refView.open);
  if (!open) {
    title.textContent = 'Lists';
    const flowRow = f => {
      const due = flowDueMin(f);
      const done = f.run && f.run.completed_at;
      // The count is TODAY's steps, not the routine's whole length — it is
      // read as "how much is left tonight", and a Sunday-only step would
      // otherwise inflate every other day of the week.
      // `day_steps` is the server's one composition of today's run (pawns
      // included); the fallback is for a flow fetched without a date.
      const todaySteps = (f.day_steps || f.steps.filter(s => stepDueToday(s))).length;
      return `<div class="ref-row" data-flow="${f.id}">
        <span class="ref-name" title="Tap to edit steps · double-click to rename">${escHtml(f.name)}</span>
        ${due != null ? `<span class="fr-due">${done ? '✓ done'
          : (flowWindowLabel(f) || 'due ' + clockHHMM(due))}</span>`
          : done ? '<span class="fr-due">✓ done</span>' : ''}
        <span class="map-count" title="${todaySteps} of ${f.steps.length} steps run today">${todaySteps}${
          todaySteps === f.steps.length ? '' : `<span class="fr-of">/${f.steps.length}</span>`}</span>
        <button class="fr-play" data-flow="${f.id}" title="Run this routine">${playMark()}</button>
        <button class="ref-del" data-flow-del="${f.id}" title="Delete routine">×</button>
      </div>`;
    };
    // The index shows lists at the ROOT; nested lists live inside their
    // parent (2026-08-11), the same split-at-the-root MAP's someday pile uses.
    const rootLists = refView.lists.filter(l => !l.parent_id);
    body.innerHTML = `
      <div class="gtd-section-head">Routines</div>
      <div class="ref-list">${refView.flows.map(flowRow).join('')
        || '<div class="gtd-empty">No routines yet.</div>'}
      <button id="fr-new" class="map-add-btn">+ routine</button></div>
      <div class="gtd-section-head">Reference</div>
      <div class="ref-list">${rootLists.map(l => refListRow(l)).join('')
      || '<div class="gtd-empty">No lists yet.</div>'}
      <button id="ref-new" class="map-add-btn">+ list</button></div>`;

    // Routine rows: tap = step editor, double-click = rename, ▶ = runner,
    // × = delete (undo replays). The single click waits out the double-click
    // window, exactly like MAP's rows and the reference lists below.
    body.querySelectorAll('.ref-row[data-flow] .ref-name').forEach(span => {
      let t = null;
      const id = parseInt(span.closest('.ref-row').dataset.flow);
      span.addEventListener('click', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          refView.openFlow = id;
          renderRef();
        }, 220);
      });
      span.addEventListener('dblclick', () => {
        clearTimeout(t);
        const was = span.textContent;
        refRenameEl(span, async name => {
          await apiSend(`/api/flows/${id}`, 'PATCH', { name });
          pushUndo(`renamed routine to "${name}"`, async () => {
            await apiSend(`/api/flows/${id}`, 'PATCH', { name: was });
            await refreshAfterUndo();
          });
          await refreshRef();
        });
      });
    });
    body.querySelectorAll('.fr-play').forEach(b => b.addEventListener('click', () => {
      openFlowRun(parseInt(b.dataset.flow));
    }));
    const frNew = body.querySelector('#fr-new');
    if (frNew) frNew.addEventListener('click', async () => {
      const created = await apiSend('/api/flows', 'POST', { name: 'New routine' }).then(r => r.json());
      pushUndo(`created routine "${created.name}"`, async () => {
        await apiSend(`/api/flows/${created.id}`, 'DELETE');
        await refreshAfterUndo();
      });
      refView.openFlow = created.id;
      await refreshRef();
    });
    const refNew = body.querySelector('#ref-new');
    if (refNew) refNew.addEventListener('click', () => openEntrySheet({
      title: 'New list', placeholder: 'Name the list…', button: 'Create',
      closeOnAdd: true,
      add: async name => {
        const created = await apiSend('/api/ref/lists', 'POST', { name }).then(r => r.json());
        pushUndo(`created list "${name}"`, async () => {
          await apiSend(`/api/ref/lists/${created.id}`, 'DELETE');
          await refreshAfterUndo();
        });
        refView.open = created.id;
        await refreshRef();
      },
    }));
    body.querySelectorAll('[data-flow-del]').forEach(b => b.addEventListener('click', async () => {
      const id = parseInt(b.dataset.flowDel);
      const f = refView.flows.find(x => x.id === id);
      const res = await apiSend(`/api/flows/${id}`, 'DELETE')
        .then(r => (r.status === 204 ? {} : r.json())).catch(() => ({}));
      if (res.pending) {
        // A GATED routine eases on the 24h delay, so the row is still there
        // and the undo is the CANCEL — not a re-create, which would come back
        // without the gate link, the period or its steps' days.
        pushUndo(`scheduled removal of routine "${f.name}"`, async () => {
          await apiSend(`/api/flows/${id}/pending?field=delete`, 'DELETE');
          await refreshAfterUndo();
        });
        toast('A gated routine eases on a 24h delay — removal is scheduled');
      } else {
        pushUndo(`deleted routine "${f.name}"`, async () => {
          const nf = await apiSend('/api/flows', 'POST', { name: f.name }).then(r => r.json());
          for (const s of f.steps) {
            await apiSend(`/api/flows/${nf.id}/steps`, 'POST', { content: s.content, kind: s.kind, requirement: s.requirement });
          }
          await refreshAfterUndo();
        });
      }
      await refreshRef();
    }));

    // [data-id] scopes this to REFERENCE LIST rows — routine rows carry
    // data-flow and got their own pair above; an unscoped .ref-name here used
    // to fire on both, opening the editor and then racing a NaN list open.
    body.querySelectorAll('.ref-row[data-id] .ref-name').forEach(span => {
      let t = null;
      span.addEventListener('click', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          refView.open = parseInt(span.closest('.ref-row').dataset.id);
          renderRef();
        }, 220);
      });
      span.addEventListener('dblclick', () => {
        clearTimeout(t);
        refRename(span, id => name =>
          apiSend(`/api/ref/lists/${id}`, 'PATCH', { name }));
      });
    });
    // [data-id] again: the routine rows' × carries data-flow-del and is wired
    // above — unscoped, this handler also fired there and tried to DELETE
    // /api/ref/lists/NaN.
    body.querySelectorAll('.ref-del[data-id]').forEach(b => b.addEventListener('click', async () => {
      const id = parseInt(b.dataset.id);
      const l = refView.lists.find(x => x.id === id);
      await apiSend(`/api/ref/lists/${id}`, 'DELETE');
      // Recreate replays name + items; new ids are fine — nothing references
      // a ref id from outside (unlike inbox restore).
      pushUndo(`deleted list "${l.name}"`, async () => {
        const nl = await apiSend('/api/ref/lists', 'POST', { name: l.name }).then(r => r.json());
        for (const it of l.items) {
          await apiSend('/api/ref/items', 'POST', { list_id: nl.id, content: it.content, done: it.done });
        }
        await refreshAfterUndo();
      });
      await refreshRef();
    }));
    return;
  }

  title.textContent = open.name;
  const parent = open.parent_id ? refView.lists.find(l => l.id === open.parent_id) : null;
  const children = refView.lists.filter(l => l.parent_id === open.id);
  body.innerHTML = `
    <button id="ref-back" class="log-back-btn">‹ ${parent ? escHtml(parent.name) : 'All lists'}</button>
    ${children.length ? `<div class="ref-list ref-sublists">${
      children.map(l => refListRow(l)).join('')}</div>` : ''}
    <div class="ref-list">${open.items.map(i => `
      <div class="ref-row" data-item="${i.id}">
        <span class="eg-check ref-check${i.done ? ' ref-checked' : ''}" data-item="${i.id}"
          title="${i.done ? 'Uncheck' : 'Check off'}">${i.done ? '✓' : ''}</span>
        <span class="ref-text${i.done ? ' ref-done' : ''}" title="Double-click to rewrite">${escHtml(i.content)}</span>
        <button class="ref-del" data-item="${i.id}" title="Remove">×</button>
      </div>`).join('')
      || (children.length ? '' : '<div class="gtd-empty">Empty.</div>')}
    <button id="ref-add-item" class="map-add-btn">+ item</button>
    <button id="ref-add-sub" class="map-add-btn">+ list inside</button></div>`;

  // Back peels one LEVEL, not to the index — nesting made "up" and "out"
  // different things.
  document.getElementById('ref-back').addEventListener('click', () => {
    refView.open = open.parent_id || null;
    renderRef();
  });
  document.getElementById('ref-add-item').addEventListener('click', () => openEntrySheet({
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
  document.getElementById('ref-add-sub').addEventListener('click', () => openEntrySheet({
    title: `List inside ${open.name}`, placeholder: 'Name the list…', button: 'Create',
    closeOnAdd: true,
    add: async name => {
      const created = await apiSend('/api/ref/lists', 'POST', { name, parent_id: open.id }).then(r => r.json());
      pushUndo(`created list "${name}" in ${open.name}`, async () => {
        await apiSend(`/api/ref/lists/${created.id}`, 'DELETE');
        await refreshAfterUndo();
      });
      refView.open = created.id;
      await refreshRef();
    },
  }));
  // Child-list rows: same gestures as the index rows.
  body.querySelectorAll('.ref-row[data-id] .ref-name').forEach(span => {
    let t = null;
    span.addEventListener('click', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        refView.open = parseInt(span.closest('.ref-row').dataset.id);
        renderRef();
      }, 220);
    });
    span.addEventListener('dblclick', () => {
      clearTimeout(t);
      refRename(span, id => name =>
        apiSend(`/api/ref/lists/${id}`, 'PATCH', { name }));
    });
  });
  body.querySelectorAll('.ref-del[data-id]').forEach(b => b.addEventListener('click', async () => {
    const id = parseInt(b.dataset.id);
    const l = refView.lists.find(x => x.id === id);
    await apiSend(`/api/ref/lists/${id}`, 'DELETE');
    pushUndo(`deleted list "${l.name}"`, async () => {
      const nl = await apiSend('/api/ref/lists', 'POST', { name: l.name, parent_id: l.parent_id }).then(r => r.json());
      for (const it of l.items) {
        await apiSend('/api/ref/items', 'POST', { list_id: nl.id, content: it.content, done: it.done });
      }
      await refreshAfterUndo();
    });
    await refreshRef();
  }));
  body.querySelectorAll('.ref-check').forEach(c => c.addEventListener('click', async () => {
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
  body.querySelectorAll('.ref-row[data-item] .ref-text').forEach(span => {
    span.addEventListener('dblclick', () => {
      const id = parseInt(span.closest('.ref-row').dataset.item);
      refRenameEl(span, async content => {
        await apiSend(`/api/ref/items/${id}`, 'PATCH', { content });
        await refreshRef();
      });
    });
  });
  body.querySelectorAll('.ref-del[data-item]').forEach(b => b.addEventListener('click', async () => {
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

// The step editor for one routine: reorder (↑↓), kind picker, soft/hard
// toggle, rename, delete — plus the gate link (deadline anchor + judgment gate).
// social_spec and social_dose are the app's TWO SOCIAL LINES, and they are
// deliberately separate step kinds (2026-08-11): spec is the MORNING question
// (is an intended rep planned that clears D) and dose is the EVENING one (did
// today's logged reps actually sum to D). A night routine that gates on the
// spec asks whether you made a plan, which a gate with money behind it must
// not mistake for having done the thing.
const FLOW_KINDS = { text: 'text', checklist: 'checklist',
                     daily_contexts: 'today’s contexts',
                     metrics: 'metrics',
                     social_spec: 'social spec (planned)',
                     social_dose: 'social dose (done)',
                     journal_night: 'nightly journal', crm_fill: 'CRM fill' };

// FLOW_KINDS is the PICKABLE set — what the Type chips offer. A review step's
// kind is not pickable (it is the binding to a review surface, minted with the
// routine), so it needs a label without joining the chip row.
function stepKindLabel(s) {
  return FLOW_KINDS[s.kind] || (REVIEW_KINDS[s.kind] ? 'review step' : s.kind);
}

// A step reads as its own WORDING where it has wording to read: a text step and
// a review step both do (both are renamable). The ⚙ kind label is for the
// feature pages that carry no text of their own.
function stepShowsText(s) {
  return s.kind === 'text' || s.kind === 'daily_contexts' || !!REVIEW_KINDS[s.kind];
}

// How long until a pending easing lands, in whole hours (ceil — "1h" until
// it is genuinely under an hour away).
function pendingHours(p) {
  return Math.max(0, Math.ceil((new Date(p.apply_at) - Date.now()) / 3600000));
}

// Pendings are PER FIELD and there can be several counting down at once, so
// the store is a list. The one-slot object still reads — old rows keep working.
function stepPendings(s) {
  if (!s || !s.pending) return [];
  let p;
  try { p = typeof s.pending === 'string' ? JSON.parse(s.pending) : s.pending; }
  catch { return []; }
  if (Array.isArray(p)) return p.filter(x => x && x.field);
  return p && p.field ? [p] : [];
}

// The soonest one, for the surfaces that state a single line.
function stepPending(s, field) {
  const all = stepPendings(s).filter(p => !field || p.field === field);
  return all.sort((a, b) => String(a.apply_at).localeCompare(String(b.apply_at)))[0] || null;
}

function renderFlowEditor(body, title, f) {
  title.textContent = f.name;
  const nodes = (state.accountabilityNodes || []).filter(n => n.active);
  const nodeOpts = sel => `<option value="">—</option>` + nodes.map(n =>
    `<option value="${n.id}"${n.id === sel ? ' selected' : ''}>${escHtml(n.label)}</option>`).join('');
  body.innerHTML = `
    <button id="ref-back" class="log-back-btn">‹ All lists</button>
    <div class="fr-link">
      <span class="cl-label">Gate</span>
      <select id="fr-qr" class="map-area">${nodeOpts(f.qr_node_id)}</select>
      <input type="number" id="fr-offset" class="fr-offset" placeholder="±min"
        title="Minutes relative to the gate deadline (negative = before)" value="${f.offset_min ?? ''}">
      <span class="cl-label">or before</span>
      <select id="fr-before" class="map-area">${nodeOpts(f.before_node_id)}</select>
    </div>
    <div class="fr-link-hint">Linked gates judge ✗ unless this routine completes for the day.</div>
    ${/* THE ROUTINE'S OWN WINDOW (2026-08-12). A gate has an open and a due
          time; a routine had only a deadline, derived from its gate's. So
          "open at 7, due at a time I choose" could not be said. Its window is
          a schedule source like everything else, which is what makes it
          followable: pick "the work scan (gate)" in the picker's Follows row
          and the routine's window is derived from that gate's hours. */''}
    <div class="fr-link">
      <span class="cl-label">Window</span>
      <button class="cl-pill${f.source_uid ? ' cl-pill-on' : ''}" id="fr-window">${
        f.source_uid ? escHtml(flowWindowLabel(f) || 'set') : 'set open + due…'}</button>
      ${f.source_uid ? '<button class="cl-x" id="fr-window-x" title="Back to the gate\'s deadline">✕</button>' : ''}
    </div>
    <div class="fr-link-hint">${f.source_uid
      ? 'Its own hours. Clear it to fall back to the gate deadline ± offset.'
      : 'No window of its own — the deadline above is the gate\'s, ± the offset.'}</div>
    ${/* ALSO A TASK (2026-08-16). Running a routine was only reachable from
          here or the GTD fold-out's ▶, so a routine you do weekly was invisible
          on the day you were meant to do it. This seeds an ordinary next action
          on the days it runs — same pool, same clarify sheet, same undo as any
          other action — and the action's sheet has the ▶ back into the runner.
          Being a task and gating a QR are independent: a routine can be both. */''}
    <div class="fr-link">
      <span class="cl-label">Also a task</span>
      <button class="cl-pill${f.as_task ? ' cl-pill-on' : ''}" id="fr-astask">${
        f.as_task ? 'in the pool' : 'off'}</button>
      ${f.as_task ? `<span class="cl-label">in</span>
      <select id="fr-task-area" class="map-area">${
        (state.areas || []).filter(a => a.active && a.type === 'standard').map(a =>
          `<option value="${a.id}"${a.id === f.area_id ? ' selected' : ''}>${
            escHtml(a.name)}</option>`).join('')}</select>` : ''}
    </div>
    ${f.as_task ? `
    <div class="fr-link fr-sheet-days">
      <span class="cl-label">On</span>
      ${DAY_LETTERS.map((d, n) => `<button class="fr-day${
        (f.days_of_week || '').includes(String(n)) ? ' fr-day-on' : ''}"
        data-taskdow="${n}" title="${DAY_NAMES[n]}">${d}</button>`).join('')}
      <span class="cl-hint">${f.days_of_week ? 'only the lit days' : 'every day'}</span>
    </div>
    <div class="fr-link-hint">One action per ${
      (f.period || 'day') === 'week' ? 'week' : 'day'} — ticking it off is the
      end of it until the next one, and finishing the routine takes it away.</div>` : ''}
    <div class="ref-list">${(() => {
      // A HEADER is a label, not a step: storage drops it from `day_steps`, so
      // it is never run, never credited and never counted. It carries no
      // number for the same reason — the numbering is of the WORK, and a
      // divider that consumed a number would make the routine read as one step
      // longer than it is.
      let n = 0;
      return f.steps.map(s => {
        if (s.kind === 'header') return `
      <div class="ref-row fr-step-header" data-step="${s.id}">
        <span class="gtd-section-head">${escHtml(s.content)}</span>
        <button class="fr-up" data-step="${s.id}" title="Move up">↑</button>
        <button class="fr-down" data-step="${s.id}" title="Move down">↓</button>
        <button class="fr-open" data-step="${s.id}" title="Settings for this header">›</button>
      </div>`;
        n += 1;
        return `
      <div class="ref-row${stepDueToday(s) ? '' : ' fr-step-off'}" data-step="${s.id}">
        <span class="cl-chain-n">${n}</span>
        <span class="ref-text${stepShowsText(s) ? '' : ' fr-feature'}"
          title="${stepShowsText(s) ? 'Double-click to rewrite' : stepKindLabel(s)}">${
          stepShowsText(s) ? escHtml(s.content) : '⚙ ' + stepKindLabel(s)}</span>
        ${stepBadges(s)}
        <button class="fr-up" data-step="${s.id}" title="Move up">↑</button>
        <button class="fr-down" data-step="${s.id}" title="Move down">↓</button>
        <button class="fr-open" data-step="${s.id}" title="Settings for this step">›</button>
      </div>`;
      }).join('');
    })()
      || '<div class="gtd-empty">No steps yet.</div>'}
    ${(() => {
      // What the routine adds up to TODAY — `day_steps`, so a step pawned away
      // stops counting against this routine and one pawned in starts. A total
      // across every step would be wrong for anything with per-weekday steps.
      // NOT `.filter(stepDueToday)`: filter passes the INDEX as the second
      // argument, which stepDueToday reads as a Date and blows up on.
      const t = stepsMinutes(f.day_steps || f.steps.filter(s => stepDueToday(s)));
      if (!t.total) return '';
      return `<div class="fr-total">${humanMinutes(t.total)} today${
        t.unknown ? ` · ${t.unknown} step${t.unknown === 1 ? '' : 's'} unestimated` : ''}</div>`;
    })()}
    <button id="fr-add-step" class="map-add-btn">+ step</button>
    <button id="fr-add-header" class="map-add-btn">+ header</button></div>
    <button class="fr-play fr-play-big" data-flow="${f.id}">${playMark()} Run</button>`;

  const patchFlow = async body2 => {
    await apiSend(`/api/flows/${f.id}`, 'PATCH', body2);
    await refreshRef();
    // The pool is what seeds and retires the action, so the day has to re-read
    // or the toggle looks like it did nothing.
    await refreshEngage();
  };
  body.querySelector('#fr-astask').addEventListener('click', () =>
    patchFlow({ as_task: f.as_task ? 0 : 1 }));
  const taskArea = body.querySelector('#fr-task-area');
  if (taskArea) taskArea.addEventListener('change', e =>
    patchFlow({ area_id: parseInt(e.target.value) || null }));
  body.querySelectorAll('[data-taskdow]').forEach(b => b.addEventListener('click', () => {
    const n = b.dataset.taskdow;
    const cur = new Set([...(f.days_of_week || '')]);
    if (cur.has(n)) cur.delete(n); else cur.add(n);
    patchFlow({ days_of_week: [...cur].sort().join('') });
  }));

  body.querySelector('#fr-add-step').addEventListener('click', () => openEntrySheet({
    title: `${f.name} · add step`, placeholder: 'What is the step?',
    add: async raw => {
      const created = await apiSend(`/api/flows/${f.id}/steps`, 'POST', { content: raw }).then(r => r.json());
      pushUndo(`added step "${raw}"`, async () => {
        await apiSend(`/api/flow-steps/${created.id}`, 'DELETE');
        await refreshAfterUndo();
      });
      await refreshRef();
    },
  }));

  // Same sheet, same shape as + step — a header is added where the steps are
  // added, not through a second grammar. It lands at the END like any step and
  // is dragged up with ↑ to sit above the ones it names.
  body.querySelector('#fr-add-header').addEventListener('click', () => openEntrySheet({
    title: `${f.name} · add header`, placeholder: 'Name this section…',
    add: async raw => {
      const created = await apiSend(`/api/flows/${f.id}/steps`, 'POST',
                                    { content: raw, kind: 'header' }).then(r => r.json());
      pushUndo(`added header "${raw}"`, async () => {
        await apiSend(`/api/flow-steps/${created.id}`, 'DELETE');
        await refreshAfterUndo();
      });
      await refreshRef();
    },
  }));

  body.querySelector('#ref-back').addEventListener('click', () => {
    refView.openFlow = null;
    renderRef();
  });
  const linkPatch = async patch => {
    await apiSend(`/api/flows/${f.id}`, 'PATCH', patch);
    await refreshRef();
  };
  body.querySelector('#fr-qr').addEventListener('change', e =>
    linkPatch({ qr_node_id: e.target.value ? parseInt(e.target.value) : null }));
  body.querySelector('#fr-offset').addEventListener('change', e =>
    linkPatch({ offset_min: e.target.value === '' ? null : parseInt(e.target.value) }));
  body.querySelector('#fr-before').addEventListener('change', e =>
    linkPatch({ before_node_id: e.target.value ? parseInt(e.target.value) : null }));
  // Consumer mode: the picker hands back a uid and the routine holds it. Follows
  // is ALLOWED here (unlike a gate's picker) — a routine deriving its hours from
  // the gate it serves is the point, and the gate's own window keeps the 24h
  // protection whatever derives from it.
  body.querySelector('#fr-window').addEventListener('click', () => openPicker({
    sourceUid: f.source_uid || null,
    onSaved: async uid => { await linkPatch({ source_uid: uid }); },
  }));
  const winX = body.querySelector('#fr-window-x');
  if (winX) winX.addEventListener('click', () => linkPatch({ source_uid: null }));

  // Every SETTING is decided in the step sheet now (see openStepSheet) — the
  // row keeps only what a list alone can do: its order.
  body.querySelectorAll('.fr-open').forEach(b => b.addEventListener('click', () =>
    openStepSheet(parseInt(b.dataset.step))));
  const swap = async (id, dir) => {
    const i = f.steps.findIndex(x => x.id === id);
    const j = i + dir;
    if (j < 0 || j >= f.steps.length) return;
    const a = f.steps[i], b = f.steps[j];
    pushUndo(`reordered "${f.name}"`, async () => {
      await apiSend(`/api/flow-steps/${a.id}`, 'PATCH', { position: a.position });
      await apiSend(`/api/flow-steps/${b.id}`, 'PATCH', { position: b.position });
      await refreshAfterUndo();
    });
    await apiSend(`/api/flow-steps/${a.id}`, 'PATCH', { position: b.position });
    await apiSend(`/api/flow-steps/${b.id}`, 'PATCH', { position: a.position });
    await refreshRef();
  };
  body.querySelectorAll('.fr-up').forEach(b =>
    b.addEventListener('click', () => swap(parseInt(b.dataset.step), -1)));
  body.querySelectorAll('.fr-down').forEach(b =>
    b.addEventListener('click', () => swap(parseInt(b.dataset.step), 1)));
  body.querySelectorAll('.ref-row[data-step] .ref-text:not(.fr-feature)').forEach(span => {
    span.addEventListener('dblclick', () => {
      const id = parseInt(span.closest('.ref-row').dataset.step);
      refRenameEl(span, async v => {
        await apiSend(`/api/flow-steps/${id}`, 'PATCH', { content: v });
        await refreshRef();
      });
    });
  });
  body.querySelectorAll('.fr-play').forEach(b => b.addEventListener('click', () => {
    openFlowRun(f.id);
  }));
}


// ── One routine step's settings, in a clarify-shaped sheet ────
//
// THE DIRECTION for list datatypes (CLAUDE.md): a row on a list is its text,
// its badges and ONE control — `›` — and everything that DECIDES something is
// taken in a sheet. This is MAP's 2026-08-07 lesson applied to routine steps,
// which had grown a kind select, a soft/hard toggle, a 7-button day picker and
// a delete, all on a 430px row: four grammars saying what one sheet says once.
// What stays on the row is what only a LIST can do — its order (↑↓), the way
// only a tree could do MAP's nesting.
// Chips for the common answers, a box for everything else — the same shape the
// dangerous-writing goal uses. Tapping the lit chip CLEARS it, the idiom the
// day-context answers already established.
const STEP_MINUTES = [2, 5, 10, 15, 20, 30, 45, 60];

function humanMinutes(m) {
  if (!m) return '';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} hr ${r}` : `${h} hr`;
}

// What the DUE steps of a routine add up to, and what is left in a run. Steps
// with no duration contribute nothing and are counted separately, so the runner
// can say "25 min + 2 unestimated" rather than quietly under-reporting.
function stepsMinutes(steps) {
  let total = 0, unknown = 0;
  (steps || []).forEach(s => { if (s.duration_min) total += s.duration_min; else unknown += 1; });
  return { total, unknown };
}

// The metric DEFINITIONS, held once: the step sheet needs them to say what a
// step asks, and Settings needs them to edit. Entries are never cached here —
// those are per day and per step, and live on flowRunView.
const metricsView = { all: [] };

async function loadMetrics() {
  metricsView.all = await apiGet('/api/metrics', metricsView.all);
  return metricsView.all;
}

const METRIC_KIND_LABELS = { scale: 'likert scale', count: 'count',
                             yesno: 'yes / no', text: 'text' };

const stepSheet = { id: null };

// Badges say what the settings decided, in the order you scan for them. Only
// the non-default states earn one: a daily hard text step is unremarkable and
// renders none.
function stepBadges(s) {
  const out = [];
  if (s.days_of_week) {
    const days = String(s.days_of_week).split('').sort()
      .map(d => DAY_LETTERS[Number(d)]).join('');
    out.push(`<span class="fr-badge" title="Runs ${String(s.days_of_week).split('').sort()
      .map(d => DAY_NAMES[Number(d)]).join(', ')}">${days}</span>`);
  }
  if (s.duration_min) {
    out.push(`<span class="fr-badge" title="About how long this step takes">${
      humanMinutes(s.duration_min)}</span>`);
  }
  if (s.requirement === 'soft') out.push('<span class="fr-badge">soft</span>');
  if (s.kind === 'checklist') out.push('<span class="fr-badge">☰</span>');
  // A pawn is TODAY only. On the routine list — which is the global thing — it
  // is a badge saying where the step went, never a change to the list itself.
  if (s.pawned_out) {
    out.push(`<span class="fr-badge" title="Pawned onto ${escHtml(
      flowName(s.pawn_to_flow_id))} for today only — the routine is unchanged"
      >→ ${escHtml(flowName(s.pawn_to_flow_id))} today</span>`);
  }
  // One badge PER queued easing — several can be counting down at once, and a
  // single badge would say one of them was the only thing coming.
  for (const p of stepPendings(s)) {
    out.push(`<span class="fr-badge fr-badge-pending" title="A gated routine eases on a 24h delay">${
      p.field === 'delete' ? 'removes' : p.field === 'requirement' ? 'soft' : 'days'} in ${pendingHours(p)}h</span>`);
  }
  return out.join('');
}

function stepSheetFind() {
  for (const f of refView.flows) {
    const s = (f.steps || []).find(x => x.id === stepSheet.id);
    if (s) return { f, s };
  }
  return null;
}

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
      : 'not asked anywhere yet — put it on a routine step',
    subClass: (m.steps || []).length ? '' : 'be-row-warn',
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
  return [...dow].sort().map(d => DAY_LETTERS[parseInt(d)]).join('');
}

async function refreshMetricsSettings() {
  await loadMetrics();
  renderMetricsSettings();
  if (settingsView.section == null) renderSettingsIndex();
}

function openStepSheet(id) {
  stepSheet.id = id;
  renderStepSheet();
}

function closeStepSheet() {
  stepSheet.id = null;
  document.getElementById('fr-sheet').classList.add('hidden');
  document.getElementById('fr-sheet-backdrop').classList.add('hidden');
}

async function stepSheetPatch(patch, label) {
  const found = stepSheetFind();
  if (!found) return;
  const { s } = found;
  const prev = {};
  Object.keys(patch).forEach(k => { prev[k] = s[k] ?? null; });
  pushUndo(label, async () => {
    await apiSend(`/api/flow-steps/${s.id}`, 'PATCH', prev);
    await refreshAfterUndo();
  });
  await apiSend(`/api/flow-steps/${s.id}`, 'PATCH', patch);
  await refreshRef();
  renderStepSheet();
}

function renderStepSheet() {
  const sheet = document.getElementById('fr-sheet');
  const back = document.getElementById('fr-sheet-backdrop');
  if (!sheet) return;
  const found = stepSheet.id != null ? stepSheetFind() : null;
  if (!found) { closeStepSheet(); return; }
  const { f, s } = found;
  sheet.classList.remove('hidden');
  back.classList.remove('hidden');

  const lit = n => !s.days_of_week || String(s.days_of_week).includes(String(n));
  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">step · ${escHtml(f.name)}</span>
      <span class="cl-spacer"></span>
      <button class="modal-close-btn" id="fr-sheet-close">✕</button>
    </div>
    <div class="cl-action-wrap">
      ${stepShowsText(s)
        ? `<input type="text" class="cl-action" id="fr-sheet-text" value="${escHtml(s.content)}"
             placeholder="What is the step?">`
        : `<span class="cl-title fr-feature">⚙ ${stepKindLabel(s)}</span>`}
    </div>

    ${REVIEW_KINDS[s.kind] ? `
    <div class="cl-sec"><span class="cl-label">Type</span></div>
    <div class="cl-row"><span class="cl-hint">a step of the weekly review — its type
      is the surface it opens, and is not yours to change. The wording is.</span></div>`
    : `
    <div class="cl-sec"><span class="cl-label">Type</span></div>
    <div class="cl-chips">${Object.keys(FLOW_KINDS).map(k =>
      `<button class="cl-chip${s.kind === k ? ' cl-chip-on' : ''}" data-kind="${k}">${
        FLOW_KINDS[k]}</button>`).join('')}</div>`}

    ${s.kind === 'checklist' ? `
    <div class="cl-sec"><span class="cl-label">Checklist</span></div>
    <div class="cl-row">
      <select id="fr-sheet-list" class="map-area">
        <option value="">— pick a list —</option>
        ${refView.lists.map(l => `<option value="${l.id}"${
          l.id === s.ref_list_id ? ' selected' : ''}>${escHtml(l.name)}</option>`).join('')}
      </select>
      <span class="cl-hint">the runner walks its items, unchecked each run</span>
    </div>` : ''}
    <div class="cl-sec"><span class="cl-label">Counts as done</span></div>
    <div class="cl-chips">
      <button class="cl-chip${s.requirement === 'hard' ? ' cl-chip-on' : ''}" data-req="hard"
        title="The real thing or nothing">hard</button>
      <button class="cl-chip${s.requirement === 'soft' ? ' cl-chip-on' : ''}" data-req="soft"
        title="A smaller version still credits">soft</button>
      <span class="cl-hint">${s.requirement === 'soft'
        ? 'a smaller version still credits' : 'the real thing, or it does not count'}</span>
    </div>
    ${s.requirement === 'soft' || stepPending(s, 'requirement') ? `
    <div class="cl-row">
      <input type="text" class="cl-action" id="fr-sheet-soft"
        placeholder="Name the smaller version (optional)"
        value="${escHtml(s.soft_content || '')}"
        title="Shown on the runner's soft button, so 'a smaller version' is a decision made now, not at 11pm">
    </div>` : ''}
    ${stepPendings(s).length ? `
    <div class="cl-row fr-pending-row">
      <span class="cl-hint">⏳ ${stepPendings(s).map(p => `${
        p.field === 'delete' ? 'removal lands' : p.field === 'requirement' ? 'goes soft'
          : 'day change lands'} in ${pendingHours(p)}h`).join(', ')
        } — a gated routine eases on a 24h delay</span>
      <button class="cl-pill" id="fr-sheet-unpend">Cancel</button>
    </div>` : ''}

    <div class="cl-sec"><span class="cl-label">Runs on</span></div>
    <div class="cl-chips fr-sheet-days">
      ${DAY_LETTERS.map((d, n) => `<button class="fr-day${lit(n) ? ' fr-day-on' : ''}"
        data-dow="${n}" title="${DAY_NAMES[n]}">${d}</button>`).join('')}
      <span class="cl-hint">${s.days_of_week
        ? 'only the lit days' : 'every day'}</span>
    </div>

    ${s.kind === 'metrics' ? `
    <div class="cl-sec"><span class="cl-label">Asks</span></div>
    <div class="cl-chips">
      ${(metricsView.all || []).filter(m => m.active).map(m =>
        `<button class="cl-chip${(m.step_ids || []).includes(s.id) ? ' cl-chip-on' : ''}"
          data-askm="${m.id}">${escHtml(m.name)}</button>`).join('')
        || '<span class="cl-hint">no metrics yet — add them in Settings → Metrics</span>'}
      ${(metricsView.all || []).some(m => m.active) ? `<span class="cl-hint">${
        (metricsView.all || []).filter(m => (m.step_ids || []).includes(s.id)).length
      } asked here — a metric can be asked by a morning step AND a night one</span>` : ''}
    </div>` : ''}

    <div class="cl-sec"><span class="cl-label">Takes</span></div>
    <div class="cl-chips">
      ${STEP_MINUTES.map(m => `<button class="cl-chip${s.duration_min === m ? ' cl-chip-on' : ''}"
        data-dur="${m}" title="${s.duration_min === m ? 'Tap again to clear' : ''}">${m} min</button>`).join('')}
      <input type="number" min="0" class="fr-pawn-min" id="fr-sheet-dur" placeholder="min"
        value="${s.duration_min && !STEP_MINUTES.includes(s.duration_min) ? s.duration_min : ''}">
      <span class="cl-hint">${s.duration_min
        ? `about ${humanMinutes(s.duration_min)} — the runner counts down what is left`
        : 'optional — how long this takes'}</span>
    </div>

    <div class="cl-sec"><span class="cl-label">Can be pawned to</span></div>
    <div class="cl-chips">
      <select class="fr-pawn-sel" id="fr-pawn-to">
        <option value=""${s.pawn_to_flow_id ? '' : ' selected'}>— not pawnable —</option>
        ${(refView.flows || []).filter(x => x.id !== f.id).map(x =>
          `<option value="${x.id}"${String(s.pawn_to_flow_id) === String(x.id) ? ' selected' : ''}>${
            escHtml(x.name)}</option>`).join('')}
      </select>
      ${s.pawn_to_flow_id ? `<input type="number" min="0" class="fr-pawn-min" id="fr-pawn-min"
        value="${s.pawn_minutes || ''}" placeholder="min">
        <span class="cl-hint">minutes it takes — the receiving routine's gate closes
        that much earlier on a day you pawn it</span>`
        : '<span class="cl-hint">a pawnable step can be pushed onto a later routine for the day</span>'}
    </div>

    <div class="cl-row">
      <button class="cl-pill fr-sheet-del" id="fr-sheet-del">Remove step</button>
    </div>`;

  sheet.querySelector('#fr-sheet-close').addEventListener('click', closeStepSheet);
  // Which metrics this step asks. The write is to the METRIC (its step list),
  // because a metric is the thing that exists across routines — the step is
  // just one of the places it gets asked.
  sheet.querySelectorAll('[data-askm]').forEach(b => b.addEventListener('click', async () => {
    const mid = parseInt(b.dataset.askm);
    const m = (metricsView.all || []).find(x => x.id === mid);
    if (!m) return;
    const has = (m.step_ids || []).includes(s.id);
    const next = has ? m.step_ids.filter(x => x !== s.id) : [...(m.step_ids || []), s.id];
    await fetch(`/api/metrics/${mid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step_ids: next }),
    }).catch(() => null);
    await loadMetrics();
    renderStepSheet();
  }));
  sheet.querySelectorAll('[data-dur]').forEach(b => b.addEventListener('click', () => {
    const m = parseInt(b.dataset.dur);
    // Tapping the one already chosen clears it — an estimate you no longer
    // stand behind should be removable without a second control.
    stepSheetPatch({ duration_min: s.duration_min === m ? null : m },
      `set how long "${s.content || stepKindLabel(s)}" takes`);
  }));
  const durIn = sheet.querySelector('#fr-sheet-dur');
  if (durIn) durIn.addEventListener('change', () => {
    stepSheetPatch({ duration_min: parseInt(durIn.value) || null },
      `set how long "${s.content || stepKindLabel(s)}" takes`);
  });
  sheet.querySelector('#fr-pawn-to').addEventListener('change', e => {
    stepSheetPatch({ pawn_to_flow_id: e.target.value ? parseInt(e.target.value) : null },
      `changed where "${s.content || stepKindLabel(s)}" can be pawned`);
  });
  const pawnMin = sheet.querySelector('#fr-pawn-min');
  if (pawnMin) {
    pawnMin.addEventListener('change', () => {
      stepSheetPatch({ pawn_minutes: parseInt(pawnMin.value) || null },
        `changed what "${s.content || stepKindLabel(s)}" costs to pawn`);
    });
  }
  sheet.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.kind === s.kind) return;
    stepSheetPatch({ kind: b.dataset.kind }, `changed a step in "${f.name}"`);
  }));
  sheet.querySelectorAll('[data-req]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.req === s.requirement) return;
    if (b.dataset.req === 'soft' && s.requirement === 'hard' && f.qr_node_id) {
      toast('A gated routine eases on a 24h delay — soft lands tomorrow');
    }
    stepSheetPatch({ requirement: b.dataset.req },
      `made "${s.content || stepKindLabel(s)}" ${b.dataset.req}`);
  }));
  const listSel = sheet.querySelector('#fr-sheet-list');
  if (listSel) listSel.addEventListener('change', () => stepSheetPatch(
    { ref_list_id: listSel.value ? parseInt(listSel.value) : null },
    `linked a checklist to "${s.content || 'the step'}"`));
  const softTxt = sheet.querySelector('#fr-sheet-soft');
  if (softTxt) softTxt.addEventListener('change', () => stepSheetPatch(
    { soft_content: softTxt.value },
    `named the smaller version of "${s.content || stepKindLabel(s)}"`));
  const unpend = sheet.querySelector('#fr-sheet-unpend');
  if (unpend) unpend.addEventListener('click', async () => {
    await apiSend(`/api/flow-steps/${s.id}/pending`, 'DELETE');
    await refreshRef();
    renderStepSheet();
  });
  // A step with NO days runs every day, so the picker starts all lit — turning
  // one off from there has to mean "every day EXCEPT this", not "no days",
  // which is why the empty value is expanded to the full week before the digit
  // comes out. Lighting the last one back collapses to NULL, so "daily" stays
  // one state rather than two that look alike.
  sheet.querySelectorAll('.fr-day').forEach(b => b.addEventListener('click', () => {
    const cur = new Set((s.days_of_week || '0123456').split(''));
    const d = b.dataset.dow;
    if (cur.has(d)) cur.delete(d); else cur.add(d);
    const next = [...cur].sort().join('');
    // Empty reads as NULL reads as daily, so there is no way to store "never"
    // — and a step that runs on no day is a step you would delete.
    if (!next) { toast('A step needs at least one day — remove it instead'); return; }
    stepSheetPatch({ days_of_week: next.length === 7 ? null : next },
      `changed the days of "${s.content || stepKindLabel(s)}"`);
  }));
  const txt = sheet.querySelector('#fr-sheet-text');
  if (txt) {
    // Enter commits and closes; blur commits quietly. Same guarantee as the
    // notes editors — leaving the field may never lose what was typed.
    const save = async () => {
      const v = txt.value.trim();
      if (!v || v === s.content) return;
      await stepSheetPatch({ content: v }, `reworded a step in "${f.name}"`);
    };
    txt.addEventListener('blur', save);
    txt.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      txt.blur();
    });
  }
  sheet.querySelector('#fr-sheet-del').addEventListener('click', async () => {
    const res = await apiSend(`/api/flow-steps/${s.id}`, 'DELETE')
      .then(r => r.json()).catch(() => ({}));
    if (res.pending) {
      // The 24h easing gate deferred it — the undo is the CANCEL, and the
      // sheet stays open showing the pending state.
      pushUndo(`scheduled removal of "${s.content || stepKindLabel(s)}"`, async () => {
        await apiSend(`/api/flow-steps/${s.id}/pending`, 'DELETE');
        await refreshAfterUndo();
      });
      toast('A gated routine eases on a 24h delay — removal is scheduled');
      await refreshRef();
      renderStepSheet();
      return;
    }
    pushUndo(`removed "${s.content || stepKindLabel(s)}"`, async () => {
      await apiSend(`/api/flows/${f.id}/steps`, 'POST', { content: s.content, kind: s.kind,
                               requirement: s.requirement, days_of_week: s.days_of_week });
      await refreshAfterUndo();
    });
    closeStepSheet();
    await refreshRef();
  });
  back.onclick = closeStepSheet;
}

// Same inline-rename gesture with a plain save callback (flow steps).
function refRenameEl(span, save) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 's2-rename-input';
  input.value = span.textContent;
  span.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async ok2 => {
    if (settled) return;
    settled = true;
    const v = input.value.trim();
    if (ok2 && v && v !== span.textContent) await save(v);
    else await refreshRef();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
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
  document.getElementById('ev-sheet').classList.add('hidden');
  document.getElementById('ev-sheet-backdrop').classList.add('hidden');
}

// Re-read the local mirror and repaint both surfaces that draw it.
async function reloadGcal() {
  state.gcalEvents = await fetch('/api/gcal').then(r => r.json())
    .catch(() => state.gcalEvents);
  renderTimeline();
  renderEngage();
}

function renderEvSheet() {
  const sheet = document.getElementById('ev-sheet');
  const back = document.getElementById('ev-sheet-backdrop');
  sheet.classList.remove('hidden');
  back.classList.remove('hidden');
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
        return `<button class="cl-chip" data-evtime="${escHtml(t)}">${
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
  back.addEventListener('click', closeEvSheet);
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
  document.getElementById('oc-sheet').classList.add('hidden');
  document.getElementById('oc-sheet-backdrop').classList.add('hidden');
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

function renderOccasionSheet() {
  const sheet = document.getElementById('oc-sheet');
  const back = document.getElementById('oc-sheet-backdrop');
  sheet.classList.remove('hidden');
  back.classList.remove('hidden');
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
    <div class="cl-row">
      <button class="cl-pill${o.active ? ' cl-pill-on' : ''}" data-ocstate="1">Active</button>
      <button class="cl-pill${o.active ? '' : ' cl-pill-on'}" data-ocstate="0">Paused</button>
    </div>
    <div class="cl-sec"><span class="cl-label">Every time</span>
      <span class="cl-hint">${o.items.length} action${o.items.length === 1 ? '' : 's'}</span></div>
    ${o.items.map(it => `
      <div class="oc-item">
        <span class="oc-item-text">${escHtml(it.content)}</span>
        <span class="oc-item-meta">${escHtml(areaName(it.area_id))}</span>
        <button class="oc-item-go" data-ocitem="${it.id}" title="Clarify this action">›</button>
      </div>`).join('')}
    <div class="cl-row"><button class="cl-pill" id="oc-add">+ action</button></div>
    <div class="cl-foot">
      <span class="cl-then">Already-placed actions stay put</span>
      <button class="cl-pill oc-del" id="oc-delete">Delete occasion</button>
    </div>`}`;

  sheet.querySelector('#oc-close').addEventListener('click', closeOccasionSheet);
  back.onclick = closeOccasionSheet;

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
  renderEntrySheet();
}

function closeEntrySheet() {
  entrySheet.open = false;
  entrySheet.spec = null;
  document.getElementById('en-sheet').classList.add('hidden');
  document.getElementById('en-sheet-backdrop').classList.add('hidden');
}

function renderEntrySheet() {
  const sheet = document.getElementById('en-sheet');
  const back = document.getElementById('en-sheet-backdrop');
  const spec = entrySheet.spec;
  sheet.classList.remove('hidden');
  back.classList.remove('hidden');
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
    ${spec.tags ? `
    <div class="cl-sec"><span class="cl-label">Tags</span></div>
    <div class="cl-chips" id="en-tag-chips">
      ${[...new Set([...(spec.tagVocab || []), ...entrySheet.tags])].sort().map(t => {
        const on = entrySheet.tags.has(t);
        return `<button class="ctx-chip ${on ? 'ctx-req' : 'ctx-off'}" data-entag="${escHtml(t)}"
          >${on ? '∧' : ''}${escHtml(t)}</button>`;
      }).join('')}
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
        const t = b.dataset.entag;
        if (entrySheet.tags.has(t)) entrySheet.tags.delete(t);
        else entrySheet.tags.add(t);
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
  back.addEventListener('click', closeEntrySheet);
  input.focus();
}

// THE NIGHT'S ENTRY, SAVED WITHOUT CREDITING THE STEP. The journal page holds
// four fields and an experiment lifecycle beside them, and every act in that
// lifecycle repaints the page — so the typed night is written to its own store
// first, the way wireNotesAutosave flushes before anything can take the screen.
// Crediting the step is a different statement (`#fr-done` makes it, and only
// after the habit marks it demands), which is why this is not it.
async function saveJournalDraft(el) {
  const bottleneck = el.querySelector('#fr-jn-bottleneck');
  if (!bottleneck) return;                       // not the journal page
  // The 1-7 group only — `.fr-rate-on` alone would find a habit's mark once the
  // rating is unanswered, and parseInt('good') is not a rating.
  const rate = el.querySelector('[data-rate].fr-rate-on');
  const entry = {
    bottleneck: bottleneck.value,
    problem: el.querySelector('#fr-jn-problem').value,
    active_experiment: el.querySelector('#fr-jn-exp').value,
    rating: rate ? parseInt(rate.dataset.rate) : null,
  };
  // The RUN's day, not the clock's — the night belongs to the night even when it
  // is written after midnight (same rule as creditFlowStep).
  await apiSend(`/api/journal/${runDay()}`, 'PATCH', entry);
  // So the repaint under it shows what was typed rather than what was loaded.
  flowRunView.journal = Object.assign({}, flowRunView.journal || {}, entry);
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
  document.getElementById('ex-sheet').classList.add('hidden');
  document.getElementById('ex-sheet-backdrop').classList.add('hidden');
}

function renderEndSheet() {
  const sheet = document.getElementById('ex-sheet');
  const back = document.getElementById('ex-sheet-backdrop');
  const spec = endSheet.spec;
  sheet.classList.remove('hidden');
  back.classList.remove('hidden');
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
  back.addEventListener('click', closeEndSheet);
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

// ── The routine RUNNER: one step per page ─────────────────────
//
// Pages credit into flowRunView.steps ({step_id: 'done'|'soft'}); every
// credit saves the partial run so a half-finished routine resumes, and the
// last credit completes the run — the server then notifies the linked gate's
// Worker gate. Feature pages are the real forms: the nightly journal PATCHes
// journal_day, CRM fill posts the same 'entries' satisfy the People flow
// sends, the social page reads the day's spec status.
const flowRunView = { open: false, flow: null, idx: 0, steps: {}, day: null,
                      journal: null, crmFilled: false,
                      // Checklist steps: per-RUN ticks ({step_id: {item_id:
                      // true}}), session-local — the ref list is a reusable
                      // template and its own done flags stay untouched.
                      refLists: [], checks: {},
                      // Steps pushed to the back of THIS run. Session-local and
                      // deliberately so: it is the order you are meeting them
                      // in, not a fact about the day, and flow_run.steps is a
                      // map of CREDITS that the judge reads — writing anything
                      // else into it would look like one.
                      skipped: {} };

// MIDNIGHT RESUME. The run-day pin lived only in the memory of the session
// that opened it, so a night routine half-done at 23:58 and reopened at 00:05
// came back as a NEW day: every step uncredited, every metric unanswered
// (their entries are dated yesterday), credits filed under the new date — and
// yesterday's run never completed, so the judge charged 'routine_incomplete'
// for a routine actually finished at 00:07.
//
// Yesterday's run is resumed when it was started, is unfinished, and its
// DEADLINE has not passed — the served one (due_min), not a re-derived guess.
// A routine due 23:00 is not resumed after midnight: that night is already
// judged and lost. One with a 07:00 deadline is, which is the whole case.
async function flowRunDate(flowId, today) {
  const yday = formatDateYMD(new Date(new Date(`${today}T00:00`).getTime() - 86400000));
  const yflows = await apiGet(`/api/flows?date=${yday}`, []);
  const yf = yflows.find(f => f.id === flowId);
  if (!yf || !yf.run || yf.run.completed_at || yf.due_min == null) return today;
  const deadline = new Date(`${yday}T00:00`).getTime() + yf.due_min * 60000;
  return Date.now() < deadline ? yday : today;
}

async function openFlowRun(flowId) {
  const today = await flowRunDate(flowId, wallDay());
  const [flows, day, journal, habits, refLists, crmNight] = await Promise.all([
    apiGet(`/api/flows?date=${today}`, []),
    apiGet(`/api/social/day?date=${today}`, null),
    apiGet('/api/journal', null),
    apiGet('/api/habits', null),
    apiGet('/api/ref', []),
    apiGet(`/api/people/night?date=${today}`, null),
  ]);
  flowRunView.refLists = refLists;
  flowRunView.checks = {};
  flowRunView.skipped = {};
  const flow = flows.find(f => f.id === flowId);
  if (!flow) return;
  // THE RUN IS TODAY'S STEPS, and the server composed that list once
  // (storage.get_flows: `day_steps` — due today, minus what was pawned away,
  // plus what was pawned in, carried debt first). Reading the field rather than
  // re-deriving the rule is what stops the runner and the routine editor
  // disagreeing about what a pawn did.
  //
  // Narrowing the flow HERE rather than at each use means resume, progress and
  // above all COMPLETION are about today: a Sunday-only step must not hold a
  // Tuesday's gate open.
  const steps = flow.day_steps || flow.steps.filter(s => s.due);
  if (!steps.length) {
    toast(flow.steps.length ? 'Nothing in this routine today' : 'No steps in this routine');
    return;
  }
  flowRunView.flow = { ...flow, steps };
  // A metrics step asks a set the SERVER decides (paused metrics drop out), so
  // it is fetched per step rather than derived from a global list. Prefetched
  // for today's metrics steps — usually one — so renderFlowRun stays sync.
  flowRunView.metrics = {};
  for (const st of steps.filter(x => x.kind === 'metrics')) {
    flowRunView.metrics[st.id] = await apiGet(`/api/metrics/step/${st.id}?date=${today}`,
      { date: today, metrics: [], complete: false });
  }
  // The review steps read the SAME live counts the fold-out reads — one
  // endpoint that already exists, prefetched like the metrics above so
  // renderFlowRun stays sync. Fetched only when a review step is actually in
  // today's run, so an ordinary routine pays nothing for it.
  flowRunView.review = steps.some(x => REVIEW_KINDS[x.kind])
    ? await apiGet('/api/gtd-review', null) : null;
  flowRunView.steps = flow.run ? JSON.parse(flow.run.steps || '{}') : {};
  // Resume at the first uncredited step.
  const idx = steps.findIndex(s => !flowRunView.steps[s.id]);
  flowRunView.idx = idx === -1 ? 0 : idx;
  flowRunView.day = day;
  flowRunView.journal = journal && journal.days
    ? journal.days.find(x => x.date === today) || null : null;
  // Not an attestation any more: the CRM step reads the night it is asking
  // about, so re-entering the routine after filling shows it filled.
  flowRunView.crmFilled = !!(crmNight && crmNight.satisfied_at);
  flowRunView.crmKind = crmNight ? crmNight.kind : null;
  flowRunView.habits = habits;
  // The day this run belongs to, pinned. Everything below files against it,
  // never against the wall clock — see creditFlowStep.
  flowRunView.date = today;
  flowRunView.open = true;
  renderFlowRun();
}

function closeFlowRun() {
  flowRunView.open = false;
  document.getElementById('flow-run').classList.add('hidden');
  refreshRef();
}

async function creditFlowStep(step, how) {
  // The day the run was OPENED on, not the clock now. A night routine ticked
  // at 00:05 belongs to the night it started: crediting it to the calendar day
  // would both lose the night's completion (the gate it holds open judges that
  // day) and hand the new day a routine already half done. checkDayRollover
  // starts the NEXT day's routines over; this keeps this one whole.
  const today = runDay();
  flowRunView.steps[step.id] = how;
  const complete = flowRunView.flow.steps.every(s => flowRunView.steps[s.id]);
  await apiSend(`/api/flows/${flowRunView.flow.id}/run`, 'PUT', { date: today, steps: flowRunView.steps, completed: complete });
  if (complete) {
    toast(`${flowRunView.flow.name} complete ✓`);
    closeFlowRun();
    return;
  }
  const next = flowRunView.flow.steps.findIndex(s => !flowRunView.steps[s.id]);
  flowRunView.idx = next === -1 ? flowRunView.idx : next;
  renderFlowRun();
}

// SKIP IT FOR NOW, and meet it at the end (2026-08-22, Quentin's instruction).
// A step you cannot do at this minute used to leave two options: credit it
// dishonestly, or abandon the run — and on a gated routine the second one costs
// money. Skipping moves the step to the BACK of what is left; it does not
// credit it, does not remove it, and does not change what completion requires.
//
// It is ORDER ONLY, which is what keeps it off the money path: `day_steps` is
// the server's composition of what today owes and put_flow_run re-checks it, so
// re-ordering the same set can neither add a step nor let one go unmet. That is
// also why the skip is not a pawn — a pawn moves work to ANOTHER routine and
// shortens that routine's gate, a decision with a price. This one is free.
//
// AND IT REFUSES WHEN IT IS THE LAST THING LEFT. "Come back at the end" needs
// an end to come back to; with one step remaining, skipping would put it back
// in front of you, which reads as a broken button. Being told that is the point
// — the last step is the one the routine is actually asking for.
function skipFlowStep() {
  const steps = flowRunView.flow.steps;
  const step = steps[flowRunView.idx];
  const left = steps.filter(x => !flowRunView.steps[x.id]);
  if (left.length <= 1) {
    // A refusal that only renders in the foot reads as a dead button on a
    // phone, where the keyboard sits there. Say it where it will be seen.
    toast('Last one left — there is nothing to come back from.');
    return;
  }
  steps.splice(flowRunView.idx, 1);
  steps.push(step);
  flowRunView.skipped[step.id] = true;
  // The next thing still owed, in the order that now stands. Never idx + 1:
  // the step that WAS next has just slid into this index.
  const next = steps.findIndex(x => !flowRunView.steps[x.id]);
  flowRunView.idx = next === -1 ? flowRunView.idx : next;
  renderFlowRun();
}

function flowName(flowId) {
  const f = (engageView.flows || []).find(x => x.id === flowId)
    || (refView.flows || []).find(x => x.id === flowId);
  return f ? f.name : 'the later routine';
}

// A pool/day row seeded by a ROUTINE (flow.as_task). Its one control is ▶, not
// a tick: ticking it off would retire the seed without the routine ever having
// been run, which is the one thing the seed exists to prevent. Clarify has said
// "▶ Run it" since the seed was built; this is the same door on the row itself.
function itemFlow(i) {
  return i && i.flow_id
    ? (engageView.flows || []).find(f => f.id === i.flow_id) || null : null;
}

// How long the routine is ON THE DAY BEING LOOKED AT. `day_steps` is the
// server's composition for that date (due today, pawns applied), so this only
// SUMS a list someone else decided — it does not re-derive which steps count.
// Unestimated steps contribute nothing, so the chip under-promises rather than
// inventing a number.
function flowTaskMinutes(i) {
  const f = itemFlow(i);
  return f ? stepsMinutes(f.day_steps || f.steps || []).total : 0;
}

// The row's control, for the two Engage row shapes. One place, so the pool and
// the day cannot offer different verbs for the same item.
function egRowControl(i, started, title) {
  if (i && i.flow_id) {
    return `<span class="eg-run" data-run="${i.flow_id}" data-id="${i.id}"
      title="Run this routine — ticking it off is not how it gets done">${playMark(8)}</span>`;
  }
  return `<span class="eg-check${started ? ' eg-check-started' : ''}" data-id="${i.id}"
    title="${title}">${started ? '◐' : ''}</span>`;
}

// The length chip. It rides where the estimate tags ride and looks like them,
// but it is DERIVED, never stored: EST_TAGS is a closed vocabulary (5m/15m/30m/
// 90m) and a routine's real length is whatever its steps add up to. Writing it
// as a tag would either lie or break that vocabulary.
function flowLenChip(i) {
  const m = flowTaskMinutes(i);
  return m
    ? `<span class="eg-tag eg-tag-len" title="What this routine's steps add up to today">${
        escHtml(humanMinutes(m))}</span>`
    : '';
}

// Pawning is a DAY-level act: the step leaves today's routine, joins the later
// one, and takes its minutes with it — so that routine's gate closes earlier. It
// is deliberately not undoable through the undo stack (the config surfaces are
// not either); taking it back is the same button on the other side.
async function pawnStep(step) {
  const res = await apiSend(`/api/flow-steps/${step.id}/pawn`, 'POST',
                            { date: flowRunView.date });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'Could not pawn that step');
    return;
  }
  const to = flowName(step.pawn_to_flow_id);
  toast(step.pawn_minutes
    ? `Pawned to ${to} — its gate closes ${step.pawn_minutes} min earlier`
    : `Pawned to ${to}`);
  await afterPawnChange();
}

async function unpawnStep(step) {
  await apiSend(`/api/flow-steps/${step.id}/pawn?date=${flowRunView.date || ''}`, 'DELETE');
  toast('Taken back — the gate is its full length again');
  await afterPawnChange();
}

// A pawn changes two things the client caches separately: which routine owns the
// step today, and the receiving GATE's window. `refreshEngage` re-reads the
// routines but NOT state.accountabilityNodes, whose day_windows carry the
// shortened deadline — so without this the hairline keeps yesterday's answer and
// only a full reload corrects it.
async function afterPawnChange() {
  closeFlowRun();
  state.accountabilityNodes = await fetch('/api/accountability/nodes')
    .then(r => r.json()).catch(() => state.accountabilityNodes);
  await refreshEngage();
  const lists = document.getElementById('tab-lists');
  if (lists && !lists.classList.contains('hidden')) await refreshRef();
}

function renderFlowRun() {
  const el = document.getElementById('flow-run');
  if (!el || !flowRunView.open) return;
  const f = flowRunView.flow;
  const s = f.steps[flowRunView.idx];
  const day = flowRunView.day || {};
  const due = flowDueMin(f);
  const credited = flowRunView.steps[s.id];
  // What is LEFT: the uncredited steps only. f.steps is already narrowed to
  // what is due today, so this is the run's remaining work, not the routine's
  // whole length. Steps with no estimate are counted apart (+2?) rather than
  // folded in as zero — under-reporting the time left is the one thing a
  // number like this must not do.
  const left = stepsMinutes(f.steps.filter(x => !flowRunView.steps[x.id]));
  const steps_left = f.steps.filter(x => !flowRunView.steps[x.id]).length;

  let page = '';
  if (s.kind === 'text') {
    page = `<div class="fr-step-big">${escHtml(s.content)}</div>
      ${s.requirement === 'soft'
        ? `<div class="fr-note">soft — ${s.soft_content
            ? `“${escHtml(s.soft_content)}” still counts`
            : 'a smaller version still counts'}</div>`
        : '<div class="fr-note fr-note-hard">hard — the real thing</div>'}`;
  } else if (s.kind === 'checklist') {
    const list = (flowRunView.refLists || []).find(l => l.id === s.ref_list_id);
    const checks = flowRunView.checks[s.id] || {};
    page = `<div class="fr-step-big">${escHtml(s.content || (list ? list.name : 'Checklist'))}</div>
      ${list ? `<div class="ref-list">${list.items.map(i => `
        <div class="ref-row">
          <span class="eg-check ref-check${checks[i.id] ? ' ref-checked' : ''}"
            data-chk="${i.id}">${checks[i.id] ? '✓' : ''}</span>
          <span class="ref-text${checks[i.id] ? ' ref-done' : ''}">${escHtml(i.content)}</span>
        </div>`).join('') || '<div class="gtd-empty">The linked list is empty.</div>'}</div>`
        : '<div class="fr-note">No list linked — pick one in the step\'s settings (›).</div>'}
      ${s.requirement === 'soft'
        ? '<div class="fr-note">soft — a partial pass still counts</div>'
        : '<div class="fr-note fr-note-hard">hard — every item, or it does not count</div>'}`;
  } else if (s.kind === 'journal_night') {
    const j = flowRunView.journal || {};
    const hb = flowRunView.habits || {};
    const marks = hb.marks_today || {};
    const running = hb.experiments && hb.experiments.running;
    // Two different questions, deliberately separated (2026-08-11): the 1-7 is
    // the EXPERIMENT's instrument — is this change worth keeping? — because
    // value is what an experiment exists to decide. A habit's value was
    // settled before it became one, so each forming habit asks only the two
    // formation questions: mark (adherence — did it happen) and effort
    // (automaticity — did it run on its own). No 1-7 on habits, ever: keeping
    // one would invite re-litigating nightly what the experiment already
    // answered.
    page = `<div class="fr-step-big">Nightly journal</div>
      <textarea id="fr-jn-bottleneck" class="cl-notes" rows="2"
        placeholder="What interesting way did you subconsciously overreact today?">${escHtml(j.bottleneck || '')}</textarea>
      <textarea id="fr-jn-problem" class="cl-notes" rows="2"
        placeholder="What is a formulation of a problem you have that you can explicitly solve?">${escHtml(j.problem || '')}</textarea>
      ${running ? `<div class="fr-note">experiment: ${escHtml(running.content)}
        <span class="fr-of">since ${escHtml(running.started_on)}</span> — how did it feel today?</div>` : ''}
      <textarea id="fr-jn-exp" class="cl-notes" rows="2"
        placeholder="${running ? 'Observations on the experiment…' : 'Active experiment…'}">${escHtml(j.active_experiment || '')}</textarea>
      <div class="fr-rating">${[1, 2, 3, 4, 5, 6, 7].map(n =>
        `<button class="fr-rate${j.rating === n ? ' fr-rate-on' : ''}" data-rate="${n}">${n}</button>`).join('')}</div>

      ${/* THE NEXT EXPERIMENT, decided here (2026-08-12). Starting, rewording
            and ending one lived only in the Journal OVERLAY, which is not the
            surface this gets done on — the nightly routine is. So the page that
            asks how the experiment felt is also the page that decides whether it
            continues: keep it (do nothing), reword it, or end it. Ending asks
            which end it was, because "graduate" and "drop" are different claims:
            graduate hands it to the weekly review to judge, drop closes it now
            and never queues it. Both ends, the line the review judges, and
            TOMORROW'S experiment are one sheet (2026-08-19) — the same sheet
            Tracking and the review open, and ending one no longer costs you
            the half-written night underneath. */''}
      <div class="fr-exp">
        <div class="fr-exp-head">${running ? 'Tomorrow’s experiment' : 'Start an experiment'}</div>
        ${running ? `
          <input type="text" id="fr-exp-edit" class="cl-action" value="${escHtml(running.content)}"
            title="Reword it and press keep — same variable, said better">
          <div class="cl-row">
            <button class="cl-pill" id="fr-exp-keep">Keep it running</button>
            <button class="cl-pill" id="fr-exp-end">End it…</button>
          </div>
          <div class="fr-note fr-exp-hint">Keeping it is the default — you can just carry on.</div>`
        : `
          <input type="text" id="fr-exp-new" class="cl-action"
            placeholder="change one cue, one cost, or one reward">
          <div class="cl-row"><button class="cl-pill" id="fr-exp-start">Start it</button></div>`}
        ${(((flowRunView.habits || {}).experiments || {}).awaiting || []).length
          ? `<div class="fr-note fr-exp-hint">${
              ((flowRunView.habits.experiments.awaiting) || []).length} waiting for the weekly review</div>`
          : ''}
      </div>
      ${(hb.forming || []).map(h => {
        const m = marks[h.id] || {};
        return `<div class="fr-habit" data-habit="${h.id}">
          <div class="fr-habit-name">${escHtml(h.content)}</div>
          <div class="fr-rating fr-hb-mark">${['ehh', 'good', 'great'].map(v =>
            `<button class="fr-rate${m.mark === v ? ' fr-rate-on' : ''}" data-mark="${v}">${v}</button>`).join('')}</div>
          <div class="fr-rating fr-hb-effort">${[['auto', 'ran on its own'], ['deliberate', 'took effort']].map(([v, t]) =>
            `<button class="fr-rate${m.effort === v ? ' fr-rate-on' : ''}" data-effort="${v}">${t}</button>`).join('')}</div>
        </div>`;
      }).join('')}`;
  } else if (s.kind === 'crm_fill') {
    // Running the step IS the fill (2026-08-15). It used to offer only "mark
    // filled" — an attestation about work you had no way of doing from here,
    // since the People surface is read-only until a fill session is open. The
    // step now opens one: reaching this page in tonight's routine is the same
    // intent the sleep scan was proof of. The CRM opens OVER the runner, so
    // closing it drops you back on this page.
    page = `<div class="fr-step-big">CRM nightly fill</div>
      <div class="fr-note">${flowRunView.crmFilled
        ? `filled tonight ✓${flowRunView.crmKind === 'nothing' ? ' — nothing to log' : ''}`
        : 'log tonight\'s people entries'}</div>
      <div class="cl-row">
        <button id="fr-crm-open" class="cl-pill">Open the CRM${
          flowRunView.crmFilled ? '' : ' — 10 minutes'}</button>
        ${flowRunView.crmFilled ? ''
          : '<button id="fr-crm-fill" class="cl-pill">Mark filled (entries made)</button>'}
      </div>`;
  } else if (s.kind === 'daily_contexts') {
    // WHICH CONTEXTS APPLY TODAY. Answering "no" hides that tag's pool items
    // for the day and is counted on the pool header; leaving one unanswered
    // excludes nothing, so this step can be skipped without consequence.
    const dTags = ((state.tagDaily || {}).tags || []);
    const dAns = ((state.tagDaily || {}).answers || {});
    const unanswered = dTags.filter(t => dAns[t] === undefined).length;
    page = `<div class="fr-step-big">${escHtml(s.content || 'Today’s contexts')}</div>
      ${dTags.length ? `<div class="ref-list">${dTags.map(t => `
        <div class="ref-row" data-dtag="${escHtml(t)}">
          <span class="ref-text">${escHtml(t)}</span>
          <div class="fr-rating">
            <button class="fr-rate${dAns[t] === true ? ' fr-rate-on' : ''}" data-dset="yes">today</button>
            <button class="fr-rate${dAns[t] === false ? ' fr-rate-on' : ''}" data-dset="no">not today</button>
          </div>
        </div>`).join('')}</div>
        <div class="fr-note">${unanswered
          ? `${unanswered} unanswered — those stay visible`
          : 'all answered'}</div>`
      : `<div class="fr-note">No tags are asked about yet. Long-press a tag in the
         context picker and turn on “ask each day”.</div>`}`;
  } else if (s.kind === 'social_spec') {
    const okSpec = day.specOk === true;
    page = `<div class="fr-step-big">Social spec</div>
      <div class="fr-note">${(day.specs || []).length
        ? `${(day.specs || []).length} planned · ${day.specTotal ?? 0}/${day.d ?? '—'}`
        : 'no spec yet'}${
        okSpec ? ' — the plan clears D ✓' : ' — plan enough in ≡ Social'}</div>`;
  } else if (s.kind === 'social_dose') {
    const okDose = day.doseCleared === true;
    page = `<div class="fr-step-big">Social dose</div>
      <div class="fr-note">${day.total ?? 0} / ${day.d ?? '—'} point${(day.total ?? 0) === 1 ? '' : 's'}${
        okDose ? ' — the day is clear ✓' : ' — log what you actually did in ≡ Social'}</div>`;
  } else if (s.kind === 'metrics') {
    // Self-monitoring. Every metric this step asks, on one page — the runner is
    // one step per page and these are one question each, not one step each.
    // DISPLAY ONLY: nothing here judges, and no value drives money. What can
    // gate is this STEP, through the ordinary hard rule below.
    const pack = flowRunView.metrics[s.id] || { metrics: [], complete: false };
    page = `<div class="fr-step-big">${escHtml(s.content || 'Metrics')}</div>
      ${pack.metrics.length ? `<div class="mt-list">${pack.metrics.map(m => {
        const e = m.entry || {};
        const num = e.value_num;
        return `<div class="mt-row" data-metric="${m.id}">
          <div class="mt-name">${escHtml(m.name)}${m.unit
            ? ` <span class="mt-unit">${escHtml(m.unit)}</span>` : ''}</div>
          ${m.prompt ? `<div class="mt-prompt">${escHtml(m.prompt)}</div>` : ''}
          ${m.kind === 'scale' ? `<div class="mt-chips">${
            Array.from({ length: Math.max(1, m.scale_max - m.scale_min + 1) }, (_, i) => {
              const v = m.scale_min + i;
              return `<button class="mt-chip${num === v ? ' mt-chip-on' : ''}"
                data-metric="${m.id}" data-val="${v}"
                title="${num === v ? 'Tap again to clear' : ''}">${v}</button>`;
            }).join('')}</div>` : ''}
          ${m.kind === 'yesno' ? `<div class="mt-chips">
            <button class="mt-chip${num === 1 ? ' mt-chip-on' : ''}" data-metric="${m.id}" data-val="1">yes</button>
            <button class="mt-chip${num === 0 ? ' mt-chip-on' : ''}" data-metric="${m.id}" data-val="0">no</button>
          </div>` : ''}
          ${m.kind === 'count' ? `<input type="number" class="mt-input" data-metric="${m.id}"
            inputmode="numeric" value="${num == null ? '' : num}" placeholder="how many">` : ''}
          ${m.kind === 'tags' ? `<div class="mt-chips">${
            (m.options || '').split(' ').filter(Boolean).map(t => {
              // Selected is membership in the answer, not equality: this is the
              // one kind where several answers are true at once.
              const on = ((e.value_text || '').split(' ').filter(Boolean)).includes(t);
              return `<button class="mt-chip${on ? ' mt-chip-on' : ''}"
                data-mtag="${m.id}" data-tag="${escHtml(t)}">${escHtml(t)}</button>`;
            }).join('')}
            <button class="mt-chip mt-chip-add" data-mtagadd="${m.id}"
              title="Add a new tag to this question's vocabulary">+</button>
          </div>` : ''}
          ${m.kind === 'text' ? `<input type="text" class="mt-input" data-metric="${m.id}"
            value="${escHtml(e.value_text || '')}" placeholder="a line">` : ''}
        </div>`;
      }).join('')}</div>
      <div class="fr-note${pack.complete ? ' fr-note-hard' : ''}">${pack.complete
        ? 'all answered ✓'
        : `${pack.metrics.filter(m => !m.entry).length} still unanswered`}</div>`
      : `<div class="fr-note">No metrics on this step yet — add them in Settings → Metrics.</div>`}`;
  } else if (REVIEW_KINDS[s.kind]) {
    // A REVIEW STEP, with the surface it needs to be DONE from here rather than
    // only stated and ticked (2026-08-17). The bindings are the fold-out's own
    // — same `REVIEW_KINDS` entry, same `/api/gtd-review` counts, same
    // renderers — so the two views cannot tell you different things. Nothing
    // new is invented: `act` opens a surface the app already has (MAP at one of
    // its own lenses, the calendar pass, clarify, the sweep).
    const meta = REVIEW_KINDS[s.kind];
    const rv = flowRunView.review || {};
    const counts = rv.counts || {};
    const n = state.inbox.length;
    page = `<div class="fr-step-big">${escHtml(s.content)}</div>
      ${meta.hint ? `<div class="fr-note">${escHtml(meta.hint)}</div>` : ''}
      ${s.kind === 'review_in_zero'
        ? `<div class="fr-note${n ? '' : ' fr-note-hard'}">${n
            ? `${n} item${n === 1 ? '' : 's'} still in "in"`
            : '"in" is empty ✓'}</div>
           ${n ? '<button id="fr-rv-clarify" class="cl-pill">Clarify ' + n + ' →</button>' : ''}`
        : ''}
      ${s.kind === 'review_sweep'
        ? '<button id="fr-rv-sweep" class="cl-pill">' + playMark(9) + ' 5-minute sweep</button>'
        : ''}
      ${meta.projects ? reviewProjectsHtml(counts) : ''}
      ${meta.waiting && (counts.waiting_list || []).length
        ? `<ul class="gr-list">${counts.waiting_list.map(r =>
            `<li><span>${escHtml(r.content)}</span><span class="gr-list-meta">${
              escHtml(r.area_name || '—')} · since ${
              escHtml((r.captured_at || '').slice(0, 10))}</span></li>`).join('')}</ul>`
        : ''}
      ${meta.pushed && (counts.pushed_list || []).length
        ? `<ul class="gr-list">${counts.pushed_list.map(r =>
            `<li><span>${escHtml(r.content)}</span><span class="gr-list-meta">${
              escHtml(r.area_name || '—')} · pushed ${r.pushed}x</span></li>`).join('')}</ul>`
        : ''}
      ${meta.count === 'someday'
        ? `<div class="fr-note">${counts.someday || 0} in someday / maybe</div>` : ''}
      ${meta.habits ? habitReviewHtml(flowRunView.habits || {}) : ''}
      ${meta.act && meta.act !== 'clarify' && meta.act !== 'sweep'
        ? `<button class="fr-rv-act cl-pill" data-act="${meta.act}">${
            FR_ACT_LABELS[meta.act] || 'Open'}</button>` : ''}
      ${s.kind === 'review_someday'
        ? '<button class="fr-rv-act cl-pill" data-act="map_someday">' + playMark(9) + ' Open MAP · Someday</button>' : ''}
      ${s.kind === 'review_waiting'
        ? '<button class="fr-rv-act cl-pill" data-act="map_waiting">' + playMark(9) + ' Open MAP · Waiting</button>' : ''}`;
  } else {
    // An unknown kind must still be a page you can get past — a blank one would
    // strand the run (and, on a gated routine, the gate).
    page = `<div class="fr-step-big">${escHtml(s.content || stepKindLabel(s))}</div>`;
  }

  el.innerHTML = `
    <div class="fr-head">
      <span class="fr-title">${escHtml(f.name)}</span>
      <span class="fr-meta">${flowRunView.idx + 1}/${f.steps.length}${left.total
        ? ` · ${humanMinutes(left.total)} left${left.unknown ? ` +${left.unknown}?` : ''}` : ''}${
        due != null ? ` · due ${clockHHMM(due)}` : ''}</span>
      <button class="modal-close-btn" id="fr-close">✕</button>
    </div>
    <div class="fr-page">${page}${credited ? '<div class="fr-note">✓ already credited</div>' : ''}
      ${flowRunView.skipped[s.id] && !credited
        ? `<div class="fr-note">skipped earlier — ${steps_left <= 1
            ? 'and it is the last thing left, so this is where the routine ends'
            : 'it comes round again at the end'}</div>` : ''}
      ${s.pawned_in ? `<div class="fr-note fr-pawned-in">pawned here from ${
        escHtml(flowName(s.from_flow_id))} — it costs this routine ${
        s.pawn_minutes || 0} min, so tonight's gate closes that much earlier</div>` : ''}</div>
    <div class="fr-foot">
      <button id="fr-back" ${flowRunView.idx === 0 ? 'disabled' : ''}>‹ back</button>
      ${(s.kind === 'text' || s.kind === 'checklist') && s.requirement === 'soft'
        ? `<button id="fr-soft" class="cl-pill">${s.soft_content
            ? escHtml(s.soft_content) : 'Did a smaller version'}</button>` : ''}
      ${/* PAWN: push this step onto a later routine for today only. Offered only
            where the step's own setting says it may go somewhere, never on a step
            already credited, and never on one that is already sitting here
            because it was pawned in — a step is passed on once. */''}
      ${s.pawn_to_flow_id && !credited && !s.pawned_in
        ? `<button id="fr-pawn" class="cl-pill" title="Do it in ${
          escHtml(flowName(s.pawn_to_flow_id))} instead — that routine's gate closes ${
          s.pawn_minutes || 0} min earlier">→ ${escHtml(flowName(s.pawn_to_flow_id))}</button>` : ''}
      ${s.pawned_in && !credited
        ? `<button id="fr-unpawn" class="cl-pill" title="Send it back to ${
          escHtml(flowName(s.from_flow_id))} — this gate returns to its full length">← ${
          escHtml(flowName(s.from_flow_id))}</button>` : ''}
      ${/* Not now, but still tonight. Hidden once the step is credited (there
            is nothing to come back for) and never shown on the only step left
            — see skipFlowStep, which refuses that case in words. */''}
      ${!credited ? `<button id="fr-skip" class="cl-pill" title="${
        steps_left <= 1 ? 'This is the last one left'
          : 'Move it to the end of tonight\u2019s run'}">skip for now</button>` : ''}
      <button id="fr-done" class="cl-pill cl-pill-on"${
        s.requirement !== 'soft'
          && ((s.kind === 'social_spec' && day.specOk !== true)
              || (s.kind === 'social_dose' && day.doseCleared !== true)
              // A HARD metrics step demands every metric it asks, exactly as a
              // hard checklist demands every item and refuses to credit an
              // empty or unlinked one. The gate behind it therefore asks
              // whether you ANSWERED, never what you answered.
              || (s.kind === 'metrics' && !(flowRunView.metrics[s.id] || {}).complete))
          ? ' disabled' : ''}>Done ✓</button>
    </div>`;
  el.classList.remove('hidden');

  el.querySelector('#fr-close').addEventListener('click', closeFlowRun);
  el.querySelector('#fr-back').addEventListener('click', () => {
    if (flowRunView.idx > 0) { flowRunView.idx--; renderFlowRun(); }
  });
  const skip = el.querySelector('#fr-skip');
  if (skip) skip.addEventListener('click', skipFlowStep);
  const soft = el.querySelector('#fr-soft');
  if (soft) soft.addEventListener('click', () => creditFlowStep(s, 'soft'));
  // Per-RUN ticks: they live in flowRunView.checks, never on ref_item — the
  // list is a template you run again tomorrow, so writing its own `done`
  // (which is PERMANENT, unlike routine_item's daily flag) would consume it.
  el.querySelectorAll('[data-chk]').forEach(c => c.addEventListener('click', () => {
    const marks = flowRunView.checks[s.id] = flowRunView.checks[s.id] || {};
    const id = parseInt(c.dataset.chk);
    if (marks[id]) delete marks[id]; else marks[id] = true;
    renderFlowRun();
  }));
  // Metric answers. Each write is its own small commit — the routine is often
  // half-done and interrupted, so an answer given at 07:02 must survive the
  // page never being "finished".
  const saveMetric = async (metricId, value) => {
    const date = (flowRunView.metrics[s.id] || {}).date || runDay();
    const prev = ((flowRunView.metrics[s.id] || {}).metrics || [])
      .find(m => m.id === metricId) || {};
    const before = prev.entry
      ? (['text', 'tags'].includes(prev.kind) ? prev.entry.value_text : prev.entry.value_num) : null;
    const res = await fetch('/api/metrics/entry', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, metric_id: metricId, step_id: s.id, value }),
    }).catch(() => null);
    if (!res || !res.ok) { toast('Could not save that answer'); return; }
    flowRunView.metrics[s.id] = await apiGet(`/api/metrics/step/${s.id}?date=${date}`,
      flowRunView.metrics[s.id]);
    pushUndo(`answered "${prev.name || 'metric'}"`, async () => {
      await fetch('/api/metrics/entry', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, metric_id: metricId, step_id: s.id, value: before }),
      });
      flowRunView.metrics[s.id] = await apiGet(`/api/metrics/step/${s.id}?date=${date}`,
        flowRunView.metrics[s.id]);
      if (flowRunView.open) renderFlowRun();
    });
    renderFlowRun();
  };
  el.querySelectorAll('.mt-chip').forEach(b => b.addEventListener('click', () => {
    const mid = parseInt(b.dataset.metric);
    const v = Number(b.dataset.val);
    const m = ((flowRunView.metrics[s.id] || {}).metrics || []).find(x => x.id === mid) || {};
    const cur = m.entry ? m.entry.value_num : null;
    // Tapping the answer you already gave clears it — the day-context idiom.
    saveMetric(mid, cur === v ? null : v);
  }));
  // A TAGS answer is a SET, so a tap toggles one member and rewrites the whole
  // string. Clearing every tag stores null, not '' — no row means no data, and
  // an empty string would read as "answered nothing" rather than "not asked".
  // That is why the vocabulary should carry a 'none' tag: it is how a night
  // with no interventions is said OUT LOUD, which a hard step can then credit.
  el.querySelectorAll('[data-mtag]').forEach(b => b.addEventListener('click', () => {
    const mid = parseInt(b.dataset.mtag);
    const tag = b.dataset.tag;
    const m = ((flowRunView.metrics[s.id] || {}).metrics || []).find(x => x.id === mid) || {};
    const cur = ((m.entry && m.entry.value_text) || '').split(' ').filter(Boolean);
    const next = cur.includes(tag) ? cur.filter(t => t !== tag) : cur.concat([tag]);
    saveMetric(mid, next.length ? next.join(' ') : null);
  }));
  // The vocabulary grows WHERE IT IS USED: starting a new intervention should
  // not mean a trip to Settings at 7am. Appending is a PATCH to the metric, so
  // the tag is there tomorrow too.
  el.querySelectorAll('[data-mtagadd]').forEach(b => b.addEventListener('click', async () => {
    const mid = parseInt(b.dataset.mtagadd);
    const raw = (prompt('New tag (one word, same spelling every night)') || '').trim();
    const tag = raw.split(/\s+/)[0];
    if (!tag) return;
    const m = ((flowRunView.metrics[s.id] || {}).metrics || []).find(x => x.id === mid) || {};
    const opts = ((m.options || '').split(' ').filter(Boolean));
    if (!opts.includes(tag)) {
      const res = await apiSend(`/api/metrics/${mid}`, 'PATCH',
                                { options: opts.concat([tag]).join(' ') });
      if (!res.ok) { toast('Could not add that tag'); return; }
    }
    const cur = ((m.entry && m.entry.value_text) || '').split(' ').filter(Boolean);
    saveMetric(mid, cur.concat([tag]).join(' '));
  }));
  el.querySelectorAll('.mt-input').forEach(inp => inp.addEventListener('change', () => {
    saveMetric(parseInt(inp.dataset.metric), inp.value.trim() === '' ? null : inp.value.trim());
  }));
  const pawn = el.querySelector('#fr-pawn');
  if (pawn) pawn.addEventListener('click', () => pawnStep(s));
  const unpawn = el.querySelector('#fr-unpawn');
  if (unpawn) unpawn.addEventListener('click', () => unpawnStep(s));
  // MAP OVER THE RUN (2026-08-17). Clarify and the sweep below still close the
  // runner first — each takes the whole screen and owns the keyboard — but a
  // lens of MAP is a place you LOOK, and the point of running the review is to
  // fix what you find without losing your place in it. crm_fill already proved
  // the idiom: raise the surface above #flow-run, drop the class when it
  // closes, and you land back on the step. That IS the way back the note on the
  // two acts below said did not exist; it just had to be built.
  //
  // The calendar pass and Lists are NOT here yet on purpose. `cal-overlay` has
  // its own return path (returnToReview) written for the fold-out, and pointing
  // it at the runner as an afterthought is how two surfaces start disagreeing
  // about where "back" is. It gets its own pass.
  el.querySelectorAll('.fr-rv-act').forEach(b => b.addEventListener('click', () => {
    const act = b.dataset.act;
    if (act === 'map_projects') { openMapAtLens('projects', true); return; }
    if (act === 'map_someday') { openMapAtLens('someday', true); return; }
    if (act === 'map_waiting') { openMapAtLens('waiting', true); return; }
    if (act === 'pass_back') { closeFlowRun(); startReviewPass('cal_back'); return; }
    if (act === 'pass_fwd') { closeFlowRun(); startReviewPass('cal_fwd'); return; }
  }));
  // The two review steps that are a DOING, not a ticking — the same two acts
  // the GTD fold-out offers, from the same registry. The runner closes first:
  // both open a full-screen surface of their own, and one over the other would
  // be two layers deep with no way back.
  const rvClarify = el.querySelector('#fr-rv-clarify');
  if (rvClarify) rvClarify.addEventListener('click', () => { closeFlowRun(); openClarify(); });
  const rvSweep = el.querySelector('#fr-rv-sweep');
  if (rvSweep) rvSweep.addEventListener('click', () => {
    const iso = runDay();
    closeFlowRun();
    openDangerousWriting({ goalKind: 'time', goalTime: 5, hardcore: false,
                           logName: `${iso} emptied`, autostart: true });
  });
  el.querySelector('#fr-done').addEventListener('click', async () => {
    // A HARD "get in to empty" means the inbox IS empty. Same rule as a hard
    // checklist: a step that credits with the work still sitting there is
    // checkbox theatre, and this one has a number to check against.
    if (s.kind === 'review_in_zero' && s.requirement !== 'soft' && state.inbox.length) {
      toast(`${state.inbox.length} still in "in" — clarify them, or make the step soft`);
      return;
    }
    // A HARD checklist step means every item — the same rule the nightly
    // journal's habit marks follow, for the same reason: a checklist you can
    // Done through unticked is checkbox theatre.
    if (s.kind === 'checklist' && s.requirement !== 'soft') {
      const list = (flowRunView.refLists || []).find(l => l.id === s.ref_list_id);
      // No list, or an empty one, must NOT credit: a hard step that passes
      // because there was nothing to check is the failure mode this gate
      // exists to prevent, and on a gated routine it would hand you a ✓ for
      // an unconfigured step.
      if (!list || !list.items.length) {
        toast(list ? 'That checklist is empty — add items or make the step soft'
                   : 'No checklist linked — pick a list in the step settings (›)');
        return;
      }
      const marks = flowRunView.checks[s.id] || {};
      const left = list.items.filter(i => !marks[i.id]).length;
      if (left) { toast(`${left} item${left === 1 ? '' : 's'} left on the checklist`); return; }
    }
    if (s.kind === 'journal_night') {
      // Marks land per habit, on habit_day. A hard step demands every forming
      // habit be marked — viewing without answering is checkbox theatre; soft
      // lets a partial night through.
      const rows = [...el.querySelectorAll('.fr-habit')];
      const unmarked = rows.filter(r => !r.querySelector('.fr-hb-mark .fr-rate-on'));
      if (unmarked.length && s.requirement !== 'soft') {
        toast(`Rate ${unmarked.length} habit${unmarked.length === 1 ? '' : 's'} first`);
        return;
      }
      for (const r of rows) {
        const mark = r.querySelector('.fr-hb-mark .fr-rate-on');
        const eff = r.querySelector('.fr-hb-effort .fr-rate-on');
        if (!mark && !eff) continue;
        // The RUN's day. Marked after midnight, these used to land on the new
        // day: yesterday's habits stayed unmarked forever (the daybook writes a
        // past day once) and today started pre-marked.
        const body = { date: runDay() };
        if (mark) body.mark = mark.dataset.mark;
        if (eff) body.effort = eff.dataset.effort;
        await apiSend(`/api/habits/${r.dataset.habit}/mark`, 'POST', body);
      }
    }
    if (s.kind === 'journal_night') await saveJournalDraft(el);
    creditFlowStep(s, 'done');
  });
  el.querySelectorAll('.fr-rate').forEach(b => b.addEventListener('click', () => {
    // Exclusive within the GROUP, not the page — the ledger page holds two
    // independent questions, and answering one must not clear the other.
    b.parentElement.querySelectorAll('.fr-rate').forEach(x => x.classList.remove('fr-rate-on'));
    b.classList.add('fr-rate-on');
  }));
  // The experiment lifecycle, on the page that asks about it. Each of these
  // re-reads /api/habits and repaints, so the page always shows what the server
  // now believes rather than an optimistic guess.
  // `running` above is scoped to the page-building branch; the handlers run out
  // here, so the experiment is re-read from the view state they share.
  const expRunning = ((flowRunView.habits || {}).experiments || {}).running || null;
  // HALF-TYPED TEXT IS DATA, here too: every one of these repaints the page,
  // and the page holds the night you were in the middle of writing. So the
  // draft is written to its own store first — which is not the same thing as
  // CREDITING the step: ending an experiment and starting the next must not
  // require finishing the journal, and finishing the journal is what #fr-done
  // is for.
  const expRefresh = async () => {
    await saveJournalDraft(el);
    flowRunView.habits = await fetch('/api/habits').then(r => r.json())
      .catch(() => flowRunView.habits);
    renderFlowRun();
  };
  const expStart = el.querySelector('#fr-exp-start');
  if (expStart) expStart.addEventListener('click', async () => {
    const content = el.querySelector('#fr-exp-new').value.trim();
    if (!content) { toast('Name the experiment first'); return; }
    const res = await apiSend('/api/habit-experiments', 'POST', { content });
    if (!res.ok) { toast((await res.json()).error || 'could not start it'); return; }
    const made = await res.json();
    pushUndo(`started the experiment "${content}"`, async () => {
      // Undoing a start closes it outright rather than queueing it: it never
      // ran, so there is nothing for the review to judge.
      await apiSend(`/api/habit-experiments/${made.id}`, 'PATCH', { resolution: 'undone', outcome: 'drop' });
      await expRefresh();
    });
    toast(`running: ${content}`);
    await expRefresh();
  });
  const expKeep = el.querySelector('#fr-exp-keep');
  if (expKeep) expKeep.addEventListener('click', async () => {
    const next = el.querySelector('#fr-exp-edit').value.trim();
    if (!next) { toast('An experiment needs a name'); return; }
    if (next === expRunning.content) { toast('Still running — unchanged'); return; }
    const was = expRunning.content;
    await apiSend(`/api/habit-experiments/${expRunning.id}`, 'PATCH', { content: next });
    pushUndo(`reworded the experiment`, async () => {
      await apiSend(`/api/habit-experiments/${expRunning.id}`, 'PATCH', { content: was });
      await expRefresh();
    });
    toast('reworded — still running');
    await expRefresh();
  });
  // Both ends live in the one sheet, which also asks for tomorrow's experiment
  // — the night you end one is the night you decide the next.
  const expEnd = el.querySelector('#fr-exp-end');
  if (expEnd) expEnd.addEventListener('click', async () => {
    await saveJournalDraft(el);           // before the sheet takes the screen
    // The RUN's day, so a night finished after midnight resolves the night.
    endExperimentSheet(expRunning, runDay(), expRefresh);
  });

  el.querySelectorAll('[data-dset]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('[data-dtag]');
    const tag = row.dataset.dtag;
    const want = b.dataset.dset === 'yes';
    const prev = ((state.tagDaily || {}).answers || {})[tag];
    // Tapping the answer you already gave clears it — back to unanswered, which
    // excludes nothing. That is the only way to undo a "not today" in place.
    const applies = prev === want ? null : want;
    const date = runDay();
    const answers = await apiSend('/api/tag-daily/answer', 'POST', { tag, applies, date }).then(r => r.json()).catch(() => null);
    if (answers) state.tagDaily = { ...state.tagDaily, answers };
    pushUndo(`set ${tag} ${applies === null ? 'unanswered' : applies ? 'today' : 'not today'}`,
      async () => {
        const back = await apiSend('/api/tag-daily/answer', 'POST', { tag, applies: prev === undefined ? null : prev, date }).then(r => r.json()).catch(() => null);
        if (back) state.tagDaily = { ...state.tagDaily, answers: back };
        renderFlowRun();
        renderEngage();
      });
    renderFlowRun();
    renderEngage();   // the pool and its 👤 count follow immediately
  }));

  const crmOpen = el.querySelector('#fr-crm-open');
  if (crmOpen) crmOpen.addEventListener('click', () => {
    openM('tab-people');
    // Over the runner (165) for as long as the routine holds it open; the class
    // comes off in closeM, so the z-ladder is back to normal the moment you
    // leave. Nothing else moves.
    document.body.classList.add('crm-over-runner');
    openPeopleSurface();
    startPeopleSession({ force: true });
  });

  const crm = el.querySelector('#fr-crm-fill');
  if (crm) crm.addEventListener('click', async () => {
    const today = runDay();
    await apiSend('/api/people/night', 'POST', { kind: 'entries', date: today });
    flowRunView.crmFilled = true;
    renderFlowRun();
  });
}

// Shared inline rename for ref rows — same gesture as MAP's, same Esc rule
// (stopPropagation, or the keydown peels the overlay behind the editor).
function refRename(span, patchFor) {
  const id = parseInt(span.closest('.ref-row').dataset.id);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 's2-rename-input';
  input.value = span.textContent;
  span.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async save => {
    if (settled) return;
    settled = true;
    const v = input.value.trim();
    if (save && v && v !== span.textContent) await patchFor(id)(v);
    await refreshRef();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function flushLogSave() {
  clearTimeout(logsView.saveTimer);
  if (!logsView.open || !logsView.dirty) return;
  const ta = document.getElementById('log-editor');
  if (!ta) return;
  logsView.dirty = false;
  await apiSend(`/api/logs/${encodeURIComponent(logsView.open)}`, 'PUT', { content: ta.value });
  const status = document.getElementById('log-save-status');
  if (status) status.textContent = 'Saved';
}

// ── Dangerous writing ────────────────────────────────────────
//
// A timed session where pausing DESTROYS the draft. Three things in this app
// would each have neutralised that, and all three fixes invert a rule the
// codebase otherwise enforces — see design-specs/spec-dangerous-writing.md:
//
//   1. The log editor autosaves 1s after input, so a 5s wipe would delete
//      text that reached the server four seconds earlier. So a session NEVER
//      touches /api/logs: the draft lives in dwView.text and nowhere else,
//      and the first write happens on success. Failure is honest because
//      nothing was ever stored.
//   2. The markdown suite routes every mutation through execCommand so the
//      browser's Ctrl+Z survives. Obey that here and Ctrl+Z resurrects the
//      draft. The wipe is therefore the one sanctioned `ta.value = ''` —
//      killing the native undo stack is the FEATURE here, not the bug that
//      rule exists to prevent. Do not "fix" it.
//   3. The global bar is reachable everywhere and its Esc stops typing for
//      free. So this overlay sits ABOVE the bar (z 240), the only surface
//      that takes capture away.
//
// The threat is total on purpose: a partial penalty is a cost you negotiate
// with, which is the thing being designed against.
// `let`, not `const`: the headless test hook, same as panel.js's
// ACK_GRACE_MIN — a suite cannot spend 5 real seconds per assertion.
let DW_IDLE_MS = 5000;

const dwView = {
  open: false, phase: 'setup',       // setup | writing | releasing
  goalKind: 'time', goalTime: 10, goalWords: 500,
  hardcore: false,
  text: '', startedAt: 0, logName: null,
  idleTimer: null, warnTimer: null, tick: null,
};

function dwWordCount(s) {
  return (s.trim().match(/\S+/g) || []).length;
}

// opts lets another surface prescribe the session — the weekly review's mind
// sweep is "five minutes, no stopping", not a form to fill in. `logName` fixes
// the resulting log's name instead of deriving it from the first line, so the
// sweep is findable next week as `YYYY-MM-DD emptied`.
function openDangerousWriting(opts) {
  const o = opts || {};
  dwView.open = true;
  dwView.phase = 'setup';
  dwView.text = '';
  dwView.logName = o.logName || null;
  if (o.goalKind) dwView.goalKind = o.goalKind;
  if (o.goalTime) dwView.goalTime = o.goalTime;
  if (o.goalWords) dwView.goalWords = o.goalWords;
  if (o.hardcore != null) dwView.hardcore = o.hardcore;
  renderDangerous();
  // Prescribed sessions skip the setup card: the point is to start writing,
  // and a confirmation step is a place to not start.
  if (o.autostart) dwBegin();
}

function closeDangerousWriting() {
  dwStopTimers();
  dwView.open = false;
  dwView.phase = 'setup';
  dwView.text = '';
  dwView.logName = null;
  document.getElementById('dw-session').classList.add('hidden');
}

function dwStopTimers() {
  clearTimeout(dwView.idleTimer);
  clearTimeout(dwView.warnTimer);
  clearInterval(dwView.tick);
  dwView.idleTimer = null;
  dwView.warnTimer = null;
  dwView.tick = null;
}

// Failure. The buffer is dropped and nothing is written — there is no
// recovery path by construction, not by policy.
function dwFail() {
  dwStopTimers();
  dwView.text = '';
  dwView.phase = 'setup';
  renderDangerous();
}

// Success: hand the text to the ordinary Logs machinery and get out of the
// way. Everything after this line is the app that already exists.
async function dwSucceed() {
  // Synchronous re-entry guard, set BEFORE the first await. The word goal is
  // tested on every keystroke, so without this each key past the goal starts
  // another release — it wrote one log per character.
  if (dwView.phase !== 'writing') return;
  dwView.phase = 'releasing';
  dwStopTimers();
  const text = dwView.text;
  const d = new Date();
  const stamp = `${d.getFullYear() % 100}-${d.getMonth() + 1}-${d.getDate()}`;
  const first = text.replace(/\s+/g, ' ').trim().slice(0, 48).replace(/[\\/:*?"<>|]/g, '');
  const name = dwView.logName || `${stamp} ${first || 'writing'}`;
  const log = await apiSend('/api/logs', 'POST', { name }).then(r => r.json());
  const body = text;
  await apiSend(`/api/logs/${encodeURIComponent(log.name)}`, 'PUT', { content: body });
  closeDangerousWriting();
  openM('logs-overlay');
  logsView.logs = await fetch('/api/logs').then(r => r.json());
  await openLog(log.name);
  toast('Released — it is yours to edit now');
}

function dwArm() {
  clearTimeout(dwView.idleTimer);
  clearTimeout(dwView.warnTimer);
  const el = document.getElementById('dw-session');
  if (el) el.classList.remove('dw-danger');
  // At 2/3 of the window the surface goes red. This is a WARNING, not a
  // countdown — a number to watch is a thing to do instead of writing, but
  // silent deletion with no tell reads as a bug rather than a rule.
  dwView.warnTimer = setTimeout(() => {
    const e = document.getElementById('dw-session');
    if (e) e.classList.add('dw-danger');
  }, Math.round(DW_IDLE_MS * 2 / 3));
  dwView.idleTimer = setTimeout(dwFail, DW_IDLE_MS);
}

function dwBegin() {
  dwView.phase = 'writing';
  dwView.text = '';
  dwView.startedAt = Date.now();
  renderDangerous();
  dwArm();
  // The clock is checked on a tick rather than a single timeout so the
  // progress readout and the time goal share one source of truth.
  dwView.tick = setInterval(() => {
    if (dwView.phase !== 'writing') return;
    if (dwView.goalKind === 'time'
        && Date.now() - dwView.startedAt >= dwView.goalTime * 60000) {
      dwSucceed();
      return;
    }
    dwPaintProgress();
  }, 1000);
}

function dwPaintProgress() {
  const el = document.getElementById('dw-progress');
  if (!el) return;
  if (dwView.goalKind === 'time') {
    const left = Math.max(0, dwView.goalTime * 60000 - (Date.now() - dwView.startedAt));
    el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')} left`;
  } else {
    el.textContent = `${dwWordCount(dwView.text)} / ${dwView.goalWords} words`;
  }
}

function renderDangerous() {
  const el = document.getElementById('dw-session');
  if (!el) return;
  el.classList.toggle('hidden', !dwView.open);
  if (!dwView.open) return;

  if (dwView.phase === 'setup') {
    const PRESETS = [5, 10, 20];
    const WORD_PRESETS = [250, 500, 1000];
    const goalChips = dwView.goalKind === 'time'
      ? PRESETS.map(m => `<button class="cl-chip${dwView.goalTime === m ? ' cl-chip-on' : ''}"
          data-time="${m}">${m} min</button>`).join('')
        + `<input type="number" id="dw-time-custom" class="cl-chip-input dw-custom"
             min="1" max="240" placeholder="min"
             value="${PRESETS.includes(dwView.goalTime) ? '' : dwView.goalTime}">`
      : WORD_PRESETS.map(w => `<button class="cl-chip${dwView.goalWords === w ? ' cl-chip-on' : ''}"
          data-words="${w}">${w} words</button>`).join('')
        + `<input type="number" id="dw-words-custom" class="cl-chip-input dw-custom"
             min="1" max="10000" placeholder="words"
             value="${WORD_PRESETS.includes(dwView.goalWords) ? '' : dwView.goalWords}">`;
    el.innerHTML = `
      <div class="dw-wrap">
        <div class="dw-title">Dangerous writing</div>
        <div class="dw-warn">Stop typing for ${DW_IDLE_MS / 1000} seconds and everything you have written is destroyed. There is no recovery. Finish the goal and it is yours.</div>

        <div class="cl-sec"><span class="cl-label">Goal</span></div>
        <div class="cl-chips">
          <button class="cl-chip${dwView.goalKind === 'time' ? ' cl-chip-on' : ''}" data-kind="time">Time</button>
          <button class="cl-chip${dwView.goalKind === 'words' ? ' cl-chip-on' : ''}" data-kind="words">Words</button>
        </div>
        <div class="cl-chips">${goalChips}</div>

        <div class="cl-sec"><span class="cl-label">Hardcore</span></div>
        <div class="cl-chips">
          <button class="cl-chip${dwView.hardcore ? ' cl-chip-on' : ''}" data-hard="1">${dwView.hardcore ? 'On' : 'Off'}</button>
          <span class="cl-hint">hides the text and disables backspace</span>
        </div>

        <div class="dw-actions">
          <button id="dw-begin" class="dw-begin">Begin</button>
          <button id="dw-quit" class="cl-pill">Not now</button>
        </div>
      </div>`;

    el.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
      dwView.goalKind = b.dataset.kind;
      renderDangerous();
    }));
    el.querySelectorAll('[data-time]').forEach(b => b.addEventListener('click', () => {
      dwView.goalTime = parseInt(b.dataset.time);
      renderDangerous();
    }));
    const custom = el.querySelector('#dw-time-custom');
    if (custom) custom.addEventListener('input', () => {
      const n = parseInt(custom.value);
      if (!n || n < 1) return;
      dwView.goalTime = Math.min(240, n);
      // Repaint the chips by hand rather than re-rendering: a re-render here
      // would take the field you are typing in with it.
      el.querySelectorAll('[data-time]').forEach(c =>
        c.classList.toggle('cl-chip-on', parseInt(c.dataset.time) === dwView.goalTime));
    });
    el.querySelectorAll('[data-words]').forEach(b => b.addEventListener('click', () => {
      dwView.goalWords = parseInt(b.dataset.words);
      renderDangerous();
    }));
    const customW = el.querySelector('#dw-words-custom');
    if (customW) customW.addEventListener('input', () => {
      const n = parseInt(customW.value);
      if (!n || n < 1) return;
      dwView.goalWords = Math.min(10000, n);
      el.querySelectorAll('[data-words]').forEach(c =>
        c.classList.toggle('cl-chip-on', parseInt(c.dataset.words) === dwView.goalWords));
    });
    el.querySelector('[data-hard]').addEventListener('click', () => {
      dwView.hardcore = !dwView.hardcore;
      renderDangerous();
    });
    el.querySelector('#dw-begin').addEventListener('click', dwBegin);
    el.querySelector('#dw-quit').addEventListener('click', closeDangerousWriting);
    return;
  }

  // Writing. No idle countdown is shown on purpose — a visible timer is
  // something to watch instead of write, and the threat reads stronger
  // unquantified. Only progress toward the GOAL is displayed.
  el.innerHTML = `
    <div class="dw-wrap dw-writing">
      <textarea id="dw-editor" class="dw-editor${dwView.hardcore ? ' dw-blind' : ''}"
        spellcheck="false" placeholder="Start. Don't stop."></textarea>
      <div class="dw-foot">
        <span id="dw-progress" class="dw-progress"></span>
        <span class="cl-hint">${dwView.hardcore ? 'hardcore — no backspace, no reading back' : 'esc abandons it'}</span>
      </div>
    </div>`;

  const ta = el.querySelector('#dw-editor');
  ta.value = dwView.text;
  ta.focus();
  dwPaintProgress();

  ta.addEventListener('input', () => {
    dwView.text = ta.value;
    dwArm();
    if (dwView.goalKind === 'words' && dwWordCount(dwView.text) >= dwView.goalWords) {
      dwSucceed();
      return;
    }
    dwPaintProgress();
  });
  ta.addEventListener('keydown', e => {
    // Hardcore: no going back. Cut/undo are the same escape by another name.
    if (dwView.hardcore
        && (e.key === 'Backspace' || e.key === 'Delete'
            || ((e.metaKey || e.ctrlKey) && ['z', 'y', 'x'].includes(e.key.toLowerCase())))) {
      e.preventDefault();
      return;
    }
    // Esc is the ABORT, not a peel — and it costs exactly what pausing costs.
    // stopPropagation so initHub's handler doesn't also close the overlay
    // underneath.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dwFail();
    }
  });
  // Leaving counts as stopping. wireNotesAutosave uses these same hooks to
  // SAVE; here they do the opposite, which is the point and not a bug.
  ta.addEventListener('blur', () => { if (dwView.phase === 'writing') dwArm(); });
}

async function openLog(name) {
  const log = await fetch(`/api/logs/${encodeURIComponent(name)}`).then(r => r.json());
  logsView.open = log.name;
  logsView.content = log.content;
  logsView.dirty = false;
  renderLogs();
}

// Markdown source highlighting (VS Code style): raw text stays visible,
// tokens get color/weight via a highlight layer under a transparent textarea.
// Mono font only — bold/italic keep advance width so the layers stay aligned.

function mdInline(esc) {
  return esc.split(/(`[^`\n]+`)/g).map(seg => {
    if (/^`[^`\n]+`$/.test(seg)) return `<span class="md-code">${seg}</span>`;
    return seg.replace(
      /(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)|(\[[^\]\n]*\]\([^)\n]*\))/g,
      (m, bold, strike, star, under, link) => {
        if (bold) return `<span class="md-bold">${bold}</span>`;
        if (strike) return `<span class="md-strike">${strike}</span>`;
        if (star || under) return `<span class="md-italic">${star || under}</span>`;
        return `<span class="md-link">${link}</span>`;
      }
    );
  }).join('');
}

function mdHighlight(text) {
  if (text.endsWith('\n')) text += ' ';
  const out = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    const esc = escHtml(line);
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(`<span class="md-codeblock">${esc}</span>`);
    } else if (inFence) {
      out.push(`<span class="md-codeblock">${esc}</span>`);
    } else if (/^#{1,6}(\s|$)/.test(line)) {
      out.push(`<span class="md-heading">${mdInline(esc)}</span>`);
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(`<span class="md-hr">${esc}</span>`);
    } else if (/^\s*>/.test(line)) {
      out.push(`<span class="md-quote">${mdInline(esc)}</span>`);
    } else {
      const m = line.match(/^(\s*)([-*+]|\d+\.)( \[[ xX]\])?(\s)/);
      if (m) {
        out.push(`<span class="md-marker">${escHtml(m[0])}</span>` + mdInline(escHtml(line.slice(m[0].length))));
      } else {
        out.push(mdInline(esc));
      }
    }
  }
  return out.join('\n');
}

// The two layers must wrap IDENTICALLY or the caret stops matching the text
// you see: the textarea lays out the real lines, the highlight paints the
// visible ones, and one row of divergence anywhere above the click point
// shifts everything below it. CSS alone can't guarantee equal width —
// scrollbar-gutter is honored on the textarea but not on the overflow:hidden
// highlight in WebKit — so pin the highlight to the textarea's own content
// width. Cheap, and it re-runs on every input, when the scrollbar's
// appearance could change that width.
function syncLogHighlightWidth(ta, hl) {
  hl.style.width = ta.clientWidth + 'px';
}

function updateLogHighlight() {
  const ta = document.getElementById('log-editor');
  const hl = document.getElementById('log-highlight');
  if (!ta || !hl) return;
  syncLogHighlightWidth(ta, hl);
  hl.innerHTML = mdHighlight(ta.value);
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
}

// ── Log editor: markdown shortcuts + editing gestures ────────
//
// Every mutation goes through document.execCommand('insertText') instead of
// assigning ta.value. Assigning wipes the textarea's native undo stack, and
// inside a text field the BROWSER's Ctrl+Z is deliberately the one that wins
// (see Undo: the app stack ignores keystrokes in text fields). Selecting the
// range first and letting insertText do the write is the whole reason a log
// stays undoable one step at a time. insertText also fires `input`, so the
// highlight repaint and the autosave timer come along for free — no handler
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
    // (wireNotesAutosave stamps __flushNotes); the log editor keeps its path.
    case 's': e.preventDefault(); if (ta.__flushNotes) ta.__flushNotes(); else flushLogSave(); break;
  }
}

// The whole suite for any markdown-capable textarea. The log editor's engine
// (logKeydown/logPaste and every log* helper above) is textarea-agnostic —
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
// intercepting, and the gesture that makes citing a source in a log free.
function logPaste(e) {
  const ta = e.currentTarget;
  if (ta.selectionStart === ta.selectionEnd || !e.clipboardData) return;
  const url = (e.clipboardData.getData('text') || '').trim();
  if (!/^(https?:\/\/|mailto:)\S+$/.test(url)) return;
  e.preventDefault();
  const s = ta.selectionStart, en = ta.selectionEnd;
  const out = `[${ta.value.slice(s, en)}](${url})`;
  logEdit(ta, s, en, out, s + out.length);
}

// A photo is stored BESIDE the log and referenced from it — the file lands in
// logs/media/ and the markdown link is the whole feature. The app never renders
// it: the editor is raw markdown, and the log is meant to be read by anything
// that can read markdown, which is where the picture shows up.
//
// The insertion goes through logEdit like every other mutation, so the
// browser's Ctrl+Z takes the link back. That undoes the TEXT only; the file
// stays in media/. An unreferenced photo on disk is cheaper than a link with
// no file behind it, and cheaper than breaking the native undo stack.
async function uploadLogPhoto(file) {
  const ta = document.getElementById('log-editor');
  if (!file || !ta || !logsView.open) return;
  const status = document.getElementById('log-save-status');
  if (status) status.textContent = 'Uploading…';
  let path = null;
  try {
    const fd = new FormData();
    fd.append('photo', file);
    const r = await fetch(`/api/logs/${encodeURIComponent(logsView.open)}/photo`,
                          { method: 'POST', body: fd });
    if (r.ok) path = (await r.json()).path;
  } catch (e) { /* offline: mutations are deliberately not queued, so it fails */ }
  if (!path) {
    if (status) status.textContent = '';
    // A refusal has to be visible on a phone — the bar's status line is a
    // whisper next to the keyboard covering half the screen.
    toast('Photo did not upload');
    return;
  }
  ta.focus();
  const s = ta.selectionStart, e = ta.selectionEnd;
  const out = (s === logLineStart(ta.value, s) ? '' : '\n') + `![](${path})\n`;
  logEdit(ta, s, e, out, s + out.length);
  await flushLogSave();
}

// ── Seeing them (2026-08-19) ──────────────────────────────────
//
// Uploading a photo and never being able to look at it was half a feature: the
// markdown link is the durable record, and it renders in any markdown viewer,
// but the app is what is in your hand when you want to see what you wrote down.
// So the LINKS are the gallery — parsed out of the text, never a second list to
// keep in step — and the file is fetched through the route that already serves
// media to the phone.
//
// Only `media/` paths, deliberately: those are the photos this app stored, so
// the strip never fires a request at a host the log happens to mention, and an
// offline log shows its own pictures.
const LOG_PHOTO_RE = /!\[[^\]]*\]\((media\/[^)\s]+)\)/g;

function logPhotoPaths(text) {
  const out = [];
  for (const m of String(text || '').matchAll(LOG_PHOTO_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);   // linked twice, shown once
  }
  return out;
}

function logPhotoUrl(rel) {
  return '/api/logs/media/' + encodeURIComponent(rel.replace(/^media\//, ''));
}

// The strip under the editor bar. Rebuilt only when the SET of links changes:
// re-rendering on every keystroke would restart every image load, which on a
// phone is a flicker and a bill.
function renderLogPhotos() {
  const strip = document.getElementById('log-photos');
  if (!strip) return;
  const ta = document.getElementById('log-editor');
  const paths = logPhotoPaths(ta ? ta.value : logsView.content);
  logsView.photos = paths;
  const key = paths.join('|');
  if (strip.dataset.paths === key) return;
  strip.dataset.paths = key;
  strip.classList.toggle('hidden', !paths.length);
  strip.innerHTML = paths.map((rel, i) => `
    <button class="log-thumb" data-i="${i}" title="${escHtml(rel)}">
      <img src="${escHtml(logPhotoUrl(rel))}" alt="${escHtml(rel)}" loading="lazy">
      <span class="log-thumb-fallback hidden">${escHtml(
        rel.split('.').pop().toLowerCase())}</span>
    </button>`).join('');
  strip.querySelectorAll('.log-thumb').forEach(b => {
    // A HEIC straight off an iPhone is a real file this browser cannot draw, so
    // the tile says which kind it is instead of going quietly blank.
    const img = b.querySelector('img');
    img.addEventListener('error', () => {
      img.classList.add('hidden');
      b.querySelector('.log-thumb-fallback').classList.remove('hidden');
    });
    b.addEventListener('click', () => openLogPhoto(parseInt(b.dataset.i)));
  });
}

function openLogPhoto(i) {
  if (!logsView.photos.length) return;
  logsView.photo = Math.max(0, Math.min(logsView.photos.length - 1, i));
  paintLogPhoto();
}

function closeLogPhoto() {
  logsView.photo = null;
  const el = document.getElementById('log-photo-view');
  if (!el) return;
  el.classList.add('hidden');
  el.innerHTML = '';                 // stop decoding a picture nobody is on
}

// Clamped, not wrapping: the strip is short and in view, so running off the end
// silently landing you at the other end is a worse answer than nothing moving.
function stepLogPhoto(d) {
  if (logsView.photo == null) return;
  const next = logsView.photo + d;
  if (next < 0 || next >= logsView.photos.length) return;
  logsView.photo = next;
  paintLogPhoto();
}

function paintLogPhoto() {
  const el = document.getElementById('log-photo-view');
  if (!el || logsView.photo == null) return;
  const rel = logsView.photos[logsView.photo];
  const n = logsView.photos.length;
  el.innerHTML = `
    <div class="lpv-bar">
      <button class="lpv-close" id="lpv-close">‹ Back</button>
      <span class="lpv-name">${escHtml(rel.replace(/^media\//, ''))}</span>
      <span class="lpv-count">${logsView.photo + 1} / ${n}</span>
    </div>
    <div class="lpv-stage" id="lpv-stage">
      <img src="${escHtml(logPhotoUrl(rel))}" alt="${escHtml(rel)}">
      <div class="lpv-fallback hidden" id="lpv-fallback">This browser cannot
        display a ${escHtml(rel.split('.').pop().toLowerCase())} — the file is
        in logs/media, and any viewer that reads the log will show it.</div>
    </div>
    ${n > 1 ? `<div class="lpv-nav">
      <button class="lpv-step" id="lpv-prev"${logsView.photo ? '' : ' disabled'}>‹</button>
      <button class="lpv-step" id="lpv-next"${
        logsView.photo < n - 1 ? '' : ' disabled'}>›</button>
    </div>` : ''}`;
  el.classList.remove('hidden');
  const img = el.querySelector('.lpv-stage img');
  img.addEventListener('error', () => {
    img.classList.add('hidden');
    el.querySelector('#lpv-fallback').classList.remove('hidden');
  });
  el.querySelector('#lpv-close').addEventListener('click', closeLogPhoto);
  // The STAGE closes on a tap, not the whole surface: the bar and the arrows are
  // in the way of a finger otherwise, which is how a photo viewer starts closing
  // itself every time you try to page through it.
  el.querySelector('#lpv-stage').addEventListener('click', e => {
    if (e.target.id === 'lpv-stage') closeLogPhoto();
  });
  const prev = el.querySelector('#lpv-prev');
  if (prev) prev.addEventListener('click', () => stepLogPhoto(-1));
  const next = el.querySelector('#lpv-next');
  if (next) next.addEventListener('click', () => stepLogPhoto(1));
}

// Marks the matched run inside a hit line, the way MAP's search does for a
// title — reading the hit is the point, and an unmarked line makes you find
// the word again by eye.
function hlLogHit(line, q) {
  const i = q ? line.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return escHtml(line);
  return escHtml(line.slice(0, i)) + '<mark>' + escHtml(line.slice(i, i + q.length))
    + '</mark>' + escHtml(line.slice(i + q.length));
}

async function runLogSearch() {
  const q = logsView.q.trim();
  if (!q) { logsView.hits = null; renderLogs(); return; }
  logsView.hits = await apiGet(`/api/logs?q=${encodeURIComponent(q)}`, []);
  // Another keystroke landed while this was in flight — that answer wins.
  if (logsView.q.trim() !== q) return;
  renderLogs();
}

function renderLogs() {
  const body = document.getElementById('logs-body');
  const title = document.getElementById('logs-title');
  if (!body) return;
  renderLogsFilter();
  if (!logsView.open) {
    title.textContent = 'Logs';
    // The DATE is a column, not part of the name. It still lives in the
    // filename (it is what keeps two logs on one topic from being one file),
    // but nothing here shows it inside the title any more.
    const rows = sortedLogs().map(l => `
      <button class="log-row" data-name="${escHtml(l.name)}">
        <span class="log-row-name">${escHtml(l.title)}${(l.tags || []).map(t =>
          `<span class="log-tag">#${escHtml(t)}</span>`).join('')}</span>
        <span class="log-row-date">${l.created
          ? new Date(l.created + 'T12:00:00').toLocaleDateString(undefined,
              { month: 'short', day: 'numeric' })
          : new Date(l.updated_at).toLocaleDateString(undefined,
              { month: 'short', day: 'numeric' })}</span>
        ${(l.hits || []).filter(Boolean).map(h =>
          `<span class="log-hit">${hlLogHit(h, logsView.q)}</span>`).join('')}
      </button>`).join('');
    const shown = sortedLogs().length;
    const hidden = logsView.logs.length - shown;
    body.innerHTML = `
      <div id="logs-search-wrap">
        <input type="text" id="logs-q" placeholder="⌕ search what you wrote"
          autocomplete="off" value="${escHtml(logsView.q)}">
      </div>
      <div class="log-list">${rows || `<div class="log-empty">${
        logsView.q ? `Nothing in the logs says “${escHtml(logsView.q)}”`
        : logsView.logs.length ? 'No log carries every tag you asked for'
        : 'No logs yet'}</div>`}</div>
      ${hidden > 0 ? `<div class="log-hidden-note">${hidden} more ${
        logsView.q ? 'not matching' : 'behind the filter'}</div>` : ''}
      <button id="log-new" class="map-add-btn">+ log</button>
      <button id="log-dangerous" class="dw-entry" title="Stop typing and the draft is destroyed">⚡ Dangerous writing</button>`;
    body.querySelectorAll('.log-row').forEach(row => {
      row.addEventListener('click', () => openLog(row.dataset.name));
    });
    const q = document.getElementById('logs-q');
    q.addEventListener('input', e => {
      logsView.q = e.target.value;
      clearTimeout(logsView.qTimer);
      // Debounced: each keystroke would otherwise read every file on the box.
      logsView.qTimer = setTimeout(runLogSearch, 180);
    });
    q.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !logsView.q) return;
      e.stopPropagation();                     // peel the query, not the overlay
      logsView.q = '';
      logsView.hits = null;
      renderLogs();
    });
    if (logsView.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    document.getElementById('log-dangerous')
      .addEventListener('click', openDangerousWriting);
    // Name and tags, and NO date to type — the server stamps today. Typing
    // '26-8-17' in front of every log was a filing convention the app can keep
    // for you, and getting it subtly wrong is what made the list unsortable.
    document.getElementById('log-new').addEventListener('click', () => openEntrySheet({
      title: 'New log',
      placeholder: 'what is this log about…',
      hint: 'Dated today. Tags are optional, and live in the file itself.',
      button: 'Create', closeOnAdd: true, tags: true, tagVocab: logTagVocab(),
      add: async (raw, tags) => {
        const log = await apiSend('/api/logs', 'POST',
          { name: raw, tags }).then(r => r.json());
        logsView.logs = await apiGet('/api/logs', logsView.logs);
        logsView.open = log.name;
        logsView.content = log.content;
        logsView.dirty = false;
        renderLogs();
      },
    }));
    return;
  }

  // The header names the log, not the file: the date prefix is identity on
  // disk and noise on screen.
  const openMeta = logsView.logs.find(l => l.name === logsView.open);
  title.textContent = (openMeta && openMeta.title) || logsView.open;
  body.innerHTML = `
    <div class="log-editor-bar">
      <button id="log-back" class="log-back-btn">‹ All logs</button>
      <button id="log-photo" class="log-photo-btn">+ photo</button>
      <input type="file" id="log-photo-input" accept="image/*" hidden>
      <span id="log-save-status" class="log-save-status"></span>
    </div>
    <div id="log-photos" class="log-photos hidden"></div>
    <div class="log-editor-wrap">
      <div id="log-highlight" class="log-highlight" aria-hidden="true"></div>
      <textarea id="log-editor" class="log-editor" spellcheck="false"></textarea>
    </div>`;
  const ta = document.getElementById('log-editor');
  ta.value = logsView.content;
  updateLogHighlight();
  renderLogPhotos();
  ta.addEventListener('input', () => {
    updateLogHighlight();
    renderLogPhotos();      // a pasted or uploaded link joins the strip at once
    logsView.dirty = true;
    document.getElementById('log-save-status').textContent = '·';
    clearTimeout(logsView.saveTimer);
    logsView.saveTimer = setTimeout(flushLogSave, 1000);
  });
  ta.addEventListener('scroll', () => {
    const hl = document.getElementById('log-highlight');
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  });
  ta.addEventListener('keydown', logKeydown);
  ta.addEventListener('paste', logPaste);
  ta.addEventListener('blur', flushLogSave);
  const photoInput = document.getElementById('log-photo-input');
  document.getElementById('log-photo').addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', () => {
    const f = photoInput.files[0];
    // Cleared BEFORE the upload: picking the same photo twice fires no change
    // event while the input still holds it, which reads as a dead button.
    photoInput.value = '';
    uploadLogPhoto(f);
  });
  document.getElementById('log-back').addEventListener('click', async () => {
    await flushLogSave();
    logsView.open = null;
    logsView.logs = await fetch('/api/logs').then(r => r.json());
    renderLogs();
  });
  ta.focus();
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

const socialView = { config: null, day: null, cues: '', form: null, calOpen: false };

async function refreshSocialDot() {
  socialView.day = await apiGet('/api/social/day', socialView.day);
  paintSocialDot();
}

function paintSocialDot() {
  const btn = document.getElementById('hub-social-btn');
  const day = socialView.day;
  if (!btn) return;
  // Gold dot = calibrated and a line is still open today. Uncalibrated stays
  // quiet — the feature doesn't nag before it exists.
  btn.classList.toggle('has-due', !!(day && day.d != null && !(day.specOk && day.doseCleared)));
}

async function refreshSocial() {
  const [config, day, engage] = await Promise.all([
    apiGet('/api/social', socialView.config),
    apiGet('/api/social/day', socialView.day),
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
    `<button class="cl-chip so-lvl${sel === l.id ? ' cl-chip-on' : ''}" data-axis="${axis}" data-id="${l.id}">
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
            <button class="cl-chip so-fam${f.family === 'directed' ? ' cl-chip-on' : ''}" data-fam="directed">directed</button>
            <button class="cl-chip so-fam${f.family === 'broadcast' ? ' cl-chip-on' : ''}" data-fam="broadcast">broadcast</button>
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
          return `<button class="cl-chip so-micro" data-id="${l.id}" ${l.rating == null ? 'disabled title="rate this in calibration first"' : ''}>
            ${escHtml(socialShortLabel(l.id))}${l.rating != null ? ` <span class="so-rating">${l.rating}</span>` : ''}${n ? ` ×${n}` : ''}</button>`;
        }).join('')}
        ${f ? '' : '<button class="cl-chip" id="so-log-open">+ log a rep…</button>'}</div></div>`;

    if (socialView.cues) main += `<div class="so-cues cl-hint" title="The evening tally's retrieval cue">walk the day: ${escHtml(socialView.cues)}</div>`;

    main += `<div class="so-reps">${(day.reps || []).map(r => `
      <div class="so-rep" data-id="${r.id}">
        <span class="so-price">${r.price}</span>
        <span class="so-rep-text">${escHtml(socialRepDesc(r))}</span>
        ${r.planned ? '<span class="so-planned" title="spec’d in advance">◆</span>' : ''}
        ${r.pre_rating != null ? `<span class="cl-hint">felt ${r.pre_rating}</span>` : ''}
        <button class="so-del" data-id="${r.id}" title="Remove">×</button>
      </div>`).join('') || '<div class="gtd-empty">Nothing logged today.</div>'}</div>`;
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
                                 person: f.person, opener: f.opener }).then(r => r.json());
        if (spec.error) return;
        if (prev) await apiSend(`/api/social/specs/${prev.id}`, 'DELETE');
        pushUndo(prev ? 'replaced a planned interaction' : 'planned an interaction', async () => {
          await apiSend(`/api/social/specs/${spec.id}`, 'DELETE');
          if (prev) await respec(prev);
          await refreshSocialIfOpen();
        });
      } else {
        const rep = await apiSend('/api/social/reps', 'POST', { family: f.family, levels: f.levels, person: f.person,
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
    const rep = await apiSend('/api/social/reps', 'POST', { family: 'micro', levels: { micro: parseInt(b.dataset.id) } }).then(r => r.json());
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
function initVisibleHeight() {
  const vv = window.visualViewport;
  const set = () => {
    document.documentElement.style.setProperty(
      '--vvh', Math.round(vv ? vv.height : window.innerHeight) + 'px');
  };
  set();
  if (vv) {
    vv.addEventListener('resize', set);
    // The URL bar sliding away is a visual-viewport SCROLL, not a resize.
    vv.addEventListener('scroll', set);
  }
  window.addEventListener('resize', set);
  // The rotation fires before the new size is settled, hence the beat.
  window.addEventListener('orientationchange', () => setTimeout(set, 80));
}

document.addEventListener('DOMContentLoaded', () => {
  initVisibleHeight();          // before anything is measured or sized
  initThemeToggle();
  initPanelToggle();
  initBlockEditor();
  initTimeline();
  initGtdReviewFold();
  initLogsView();
  initPeopleModals();
  initHub();
  initSwipe();
  initUndo();
  renderBar();
  initGeo();
  initEngage();
  // Engage IS the home screen (9c): the day renders once everything is loaded.
  // Last line of defence for unsaved notes and log text. visibilitychange is
  // the one that actually lands — it fires while the page is still allowed to
  // run fetches, unlike pagehide, which is often too late to finish a PATCH.
  // Note the ASYMMETRY: for notes and logs these hooks SAVE, but a dangerous
  // session is not a document — leaving it is stopping, and stopping is what
  // the mechanic punishes. Same event, opposite meaning, on purpose.
  document.addEventListener('visibilitychange', () => {
    // Coming BACK is when a sleeping device notices midnight happened.
    if (document.visibilityState !== 'hidden') { checkDayRollover(); return; }
    if (dwView.phase === 'writing') { dwFail(); return; }
    flushOpenNotes();
    flushLogSave();
  });
  window.addEventListener('pagehide', () => {
    if (dwView.phase === 'writing') { dwFail(); return; }
    flushOpenNotes();
    flushLogSave();
  });
  loadAll().then(() => { openEngage(); initTimezone(); refreshSocialDot(); });
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
// nothing — which is also why nothing here writes.
const gatePop = { nodeId: null, date: null };

// When a deadline drag last finished. A drag's trailing click must not open the
// read-out, and the flag cannot live on the pill: saving a drag re-renders the
// layer, so the marked element is gone before the click arrives.
let qrDragEndedAt = 0;

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
  // The only thing in here that CHANGES anything, and it changes only what you
  // can SEE: greying the square for this day is a view preference, not a fact
  // about the gate, so it stays session-local like it always was.
  const hide = el.querySelector('#gp-hide');
  if (hide) hide.addEventListener('click', () => {
    const key = `${nodeId}:${date}`;
    if (state.qrDismissed[key]) delete state.qrDismissed[key];
    else state.qrDismissed[key] = true;
    renderQrLayer();
    openGatePop(nodeId, date, anchorEl);
  });
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

function gpRow(k, v, cls) {
  return `<div class="gp-row"><span class="gp-k">${escHtml(k)}</span>`
    + `<span class="gp-v${cls ? ' ' + cls : ''}">${v}</span></div>`;
}

function gatePopHtml(d) {
  const w = d.window;
  const rows = [];

  rows.push(gpRow('Window', `<span class="gp-mono">${escHtml(w.start)}–${escHtml(w.end)}`
    + `${w.offset_days ? ' +1d' : ''}</span>`));
  rows.push(gpRow('Set by', escHtml(w.from)));
  if (!d.applies) rows.push(gpRow('Runs today', '<span class="gp-no">no — its schedule '
    + 'has no occurrence on this day</span>'));
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

  let scans = '<div class="gp-sect">Scans on this day</div>';
  if (!d.scans.length) {
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

  let extra = '';
  if (d.routine) {
    extra += '<div class="gp-sect">The routine it also demands</div>';
    extra += gpRow('Routine', escHtml(d.routine.name));
    extra += gpRow('Due', `<span class="gp-mono">${escHtml(d.routine.deadline || '—')}</span>`);
    extra += gpRow('Done', d.routine.completed_at
      ? `<span class="gp-ok">${escHtml(String(d.routine.completed_at).slice(11, 16))}</span>`
      : '<span class="gp-no">not yet</span>');
  }

  // The pawn is the one input that moves the deadline without writing anything
  // down, so it is invisible everywhere else — which is exactly why it is here.
  if (d.pawn && d.pawn.minutes) {
    extra += '<div class="gp-sect">Pawned onto this routine</div>';
    extra += d.pawn.steps.map(st => gpRow(`${st.minutes}m`,
      `${escHtml(st.content || 'a step')}${st.from_routine
        ? ' · from ' + escHtml(st.from_routine) : ''}`)).join('');
    extra += `<div class="gp-note">${d.pawn.applied
      ? `The deadline is ${d.pawn.minutes} minutes earlier than the schedule says,`
        + ' because that time arrived here. Un-pawning restores it by itself.'
      : 'This day has a window of its own, and a window set for one day stands as'
        + ' written — so these minutes do not shorten it.'}</div>`;
  }

  const cr = d.credit || {};
  let verdict = '<div class="gp-sect">The verdict</div>';
  // THE TWO HALVES, each worth half the stake. Shown as the two statements
  // they are, so a day that cost $1.00 says which half it lost.
  if (cr.splits) {
    verdict += gpRow('Scan half', cr.scan_half
      ? '<span class="gp-ok">met — scanned inside the window</span>'
      : '<span class="gp-no">not met — no scan counted in the window</span>');
    verdict += gpRow('Routine half', cr.routine_half
      ? (cr.reason === 'routine_late'
          ? '<span class="gp-no">done, but after its deadline</span>'
          : '<span class="gp-ok">met — the routine was done</span>')
      : '<span class="gp-no">not met — the routine has not been done</span>');
  }
  if (d.judged) {
    verdict += gpRow('Judged', d.judged.failure_reason
      ? `<span class="gp-no">${escHtml(gateReason(d.judged.failure_reason))}</span>`
      : '<span class="gp-ok">satisfied</span>');
    verdict += gpRow('Charge', escHtml(gateStatus(d.judged.charge_status))
      + (d.judged.amount_cents ? ` · $${(d.judged.amount_cents / 100).toFixed(2)}` : ''));
  } else if (!w.closed) {
    verdict += `<div class="gp-note">Still open. It is judged when the window closes at`
      + ` ${escHtml(w.end)}${w.offset_days ? ' tomorrow' : ''}${cr.splits
        ? ', and not before the day ends — the routine can still earn its half' : ''}.</div>`;
  } else if (cr.splits) {
    verdict += '<div class="gp-note">The window has closed, but the day has not:'
      + ' finishing the routine still earns half the stake back, right up to'
      + ' midnight.</div>';
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

  const greyed = !!state.qrDismissed[`${d.node_id}:${d.date}`];
  const foot = `<div class="gp-foot"><button id="gp-hide" class="se-inline-act">${
    greyed ? 'Show it again' : 'Grey it out for this day'}</button></div>`;
  return `<div class="gp-head">
      <span class="gp-title">${escHtml(d.label)}</span>
      <button class="gp-close" title="Close">✕</button>
    </div>
    <div class="gp-date">${escHtml(d.date)}</div>
    ${rows.join('')}${out}${scans}${extra}${verdict}${foot}`;
}

function renderQrLayer() {
  const layer = document.getElementById('tl-qr-layer');
  if (!layer) return;
  layer.innerHTML = '';
  const nodes = (state.accountabilityNodes || []).filter(n => n.active);
  if (!nodes.length) return;

  const body = document.getElementById('tl-body');
  const pageDate = viewDay();
  const viewingToday = isToday(state.currentDate);
  const pageDow = String(jsDateToDayOfWeek(state.currentDate));

  nodes.forEach(node => {
    if (!gateAppliesOnDate(node, pageDate)) return;
    // today_override from the API is only for the Worker's local today.
    // For other dates, use the client-side cache populated by drag saves.
    const cacheKey = `${node.id}:${pageDate}`;
    if (state.tlHidden.qr[cacheKey]) return;
    const ov = viewingToday ? node.today_override : (state.qrPageOverrides[cacheKey] || null);
    const def = nodeWindowForDate(node, pageDate);
    const windowStart = ov ? ov.window_start : def.window_start;
    const windowEnd = ov ? ov.window_end : def.window_end;
    const offsetDays = ov ? ov.window_end_offset_days : def.window_end_offset_days;

    // ±12h drag bounds in semantic minutes: a +1d deadline counts as end + 1440,
    // so dragging preserves the offset and can cross midnight in either direction
    const originalMinutes = windowEndMin(windowEnd, offsetDays);
    // Never above the window's OPENING: a deadline before its own start is an
    // empty window, which judges absent every day. The server refuses it too.
    const minMinutes = Math.max(timeToMinutes(windowStart), originalMinutes - 720);
    const maxMinutes = Math.min(originalMinutes + 720, 2875);

    const pct = minutesToViewPercent(originalMinutes);
    if (pct < -0.01 || pct > 100.01) return;
    // 🔒 locked: deadline within now + 24h — line is inert (no drag, no ✕)
    const endDate = offsetDays ? localDatePlusDays(pageDate, 1) : pageDate;
    const windowEndMs = new Date(`${endDate}T${windowEnd}:00`).getTime();
    const locked = windowEndMs <= Date.now() + 24 * 60 * 60 * 1000;
    // GREYING IS A VIEW PREFERENCE, so a locked gate can be greyed too. The
    // `!locked` here was incidental: the ✕ was only ever rendered on unlocked
    // pills, so the question never came up. Now that the verb lives in the
    // read-out — which opens on every gate, locked included — leaving it in
    // made the button dead on exactly the gates you look at most.
    const dismissed = !!state.qrDismissed[cacheKey];

    const line = document.createElement('div');
    // outcome colors the pill for judged (closed) windows: green/red
    const outcome = state.qrOutcomes[cacheKey];
    // ONE VOCABULARY FOR EVERY GATE: grey still to do, green met, red missed,
    // amber the half-met day the 50/50 split created. Wake and sleep are not
    // special-cased any more — they were briefly drawn as coloured bookend
    // bands, which meant the two most important gates were the two that did
    // NOT say how their day went.
    line.className = 'tl-qr-line' + (locked ? ' tl-qr-locked' : '') + (dismissed ? ' tl-qr-dismissed' : '')
      + (outcome ? ` tl-qr-${outcome}` : '');
    line.style.top = `${pct}%`;

    const label = document.createElement('span');
    label.className = 'tl-qr-label';
    const labelText = document.createElement('span');
    labelText.textContent = QR_GLYPH;
    label.title = qrPillTitle(node, windowEnd, offsetDays, locked, outcome);

    // THE TIME, ONLY WHILE YOU ARE MOVING IT (2026-08-22, Quentin's
    // instruction). The square says nothing about when — that is what its
    // position against the hour gutter is for — but a deadline being DRAGGED
    // is the one moment the exact minute matters and the gutter is too coarse
    // to read it off. So a small readout appears to the left of the square for
    // the duration of the drag and is not in the document's way otherwise.
    const timeTag = document.createElement('span');
    timeTag.className = 'tl-qr-time';
    line.appendChild(timeTag);
    label.appendChild(labelText);
    line.appendChild(label);
    layer.appendChild(line);

    // pills center on their time; near the top/bottom edge that would clip
    function setLabelEdge(p) {
      if (p >= 98.5) label.style.top = '-18px';
      else if (p <= 1.5) label.style.top = '0px';
      else label.style.top = '';
    }
    setLabelEdge(pct);

    line.addEventListener('contextmenu', e => e.preventDefault());

    // TAP TO READ IT — the FINGER's path, and a locked pill's only one. A tap
    // never enters onPointerDrag (that needs a 550ms hold), so no re-render
    // eats the click. An unlocked pill under a MOUSE is served from the drag's
    // own no-movement branch instead; see the note there. Wired ABOVE the
    // locked bail on purpose: a
    // locked gate cannot be dragged, and it is the one you most want to ask
    // about. The click that TRAILS a drag is turned away by qrDragEndedAt —
    // see the note where that is set.
    label.addEventListener('click', e => {
      if (e.target.closest('.tl-qr-x')) return;
      if (Date.now() - qrDragEndedAt < 500) return;   // the tail of a drag
      e.stopPropagation();
      openGatePop(node.id, pageDate, label);
    });

    if (locked) return;

    // NO ✕ ON THE SQUARE. It does not fit an 18px target, and a second control
    // inside the one you are trying to tap is how a mis-tap happens. Greying a
    // gate for the day moves to the read-out, which is where every other verb
    // about one gate already lives — reachable by tap, unlike the right-click
    // that was the mouse's way in.

    let dragging = false;
    let dragStartY = 0;

    // Either mouse button drags the deadline; a finger does it after a 550ms
    // hold. Hiding for the day is the pill's ✕ on touch, which is why only the
    // drag needed a touch path.
    onPointerDrag(label, { start(e) {
      if (dismissed) return null;
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return null;
      dragging = true;
      dragStartY = e.clientY;
      line.classList.add('tl-qr-dragging');
      document.body.style.cursor = 'ns-resize';
      if (e.pointerType !== 'mouse') label.dataset.lpDragged = '1';
      return { move: onMove, end: onUp };
    } });

    function calcMinutes(clientY) {
      const bodyRect = body.getBoundingClientRect();
      const { start, end } = state.view;
      const rawMinutes = start + ((clientY - bodyRect.top) / bodyRect.height) * (end - start);
      const clamped = Math.min(maxMinutes, Math.max(minMinutes, rawMinutes));
      return Math.round(clamped / 5) * 5;
    }

    function onMove(clientY) {
      if (!dragging) return;
      const mins = calcMinutes(clientY);
      const displayPct = Math.min(100, Math.max(0, minutesToViewPercent(mins)));
      line.style.top = `${displayPct}%`;
      setLabelEdge(displayPct);
      // Was written into the square's own label, which stopped existing when
      // the square became a glyph — qrPillText went with it, so this line was
      // a ReferenceError waiting for the next drag.
      timeTag.textContent = `${clockHHMM(mins)}${mins >= DAY_MIN ? ' +1d' : ''}`;
    }

    async function onUp(clientY, e) {
      if (!dragging) return;
      dragging = false;
      line.classList.remove('tl-qr-dragging');
      document.body.style.cursor = '';
      // Right-button release fires a contextmenu event — swallow it
      document.addEventListener('contextmenu', ev => ev.preventDefault(), { once: true, capture: true });

      // A click without real movement is not a drag — never post from it
      // (a +1d line is pinned at the bottom edge, so its position doesn't
      // round-trip through calcMinutes and would otherwise save a change).
      // A right-click without movement hides the pill for the day instead.
      // A FINGER has no such no-op press to guard against: it already committed
      // by holding still for 550ms, so any movement it makes is deliberate.
      const touch = e && e.pointerType !== 'mouse';
      const moved = Math.abs(clientY - dragStartY) >= (touch ? 1 : 5);
      // A drag ends in a click on the label, and that click would open the
      // read-out on top of the deadline you just moved. onPointerDrag's own
      // suppressor cannot carry this one: it marks the ELEMENT, and saving a
      // drag re-renders the whole layer, so by the time the click lands the
      // marked pill has been replaced by a fresh one. The guard therefore
      // lives outside the DOM. A finger is already covered — its tap never
      // arms a drag at all — but a mouse has no such separation.
      if (moved) qrDragEndedAt = Date.now();
      if (!moved) {
        if (e && e.button === 2 && !touch) {
          hideTimelineItem('qr', cacheKey, node.label);
          renderQrLayer();
          return;
        }
        // A press that never moved is a TAP: read the gate out. The rect is
        // taken BEFORE the re-render — a detached element measures as zero, and
        // the popup would open in the top-left corner instead of beside its
        // pill.
        const rect = label.getBoundingClientRect();
        renderQrLayer();
        openGatePop(node.id, pageDate, rect);
        return;
      }

      const mins = calcMinutes(clientY);
      const newOffsetDays = mins >= DAY_MIN ? 1 : 0;
      const newEnd = clockHHMM(mins);

      if (newEnd === windowEnd && newOffsetDays === offsetDays) return;

      const ovBody = {
        date: pageDate,
        window_start: windowStart,
        window_end: newEnd,
        window_end_offset_days: newOffsetDays,
      };
      const res = await apiSend(`/api/accountability/nodes/${node.id}/overrides`, 'POST', ovBody);
      if (res.ok) {
        // Cache the override so non-today pages stay in the right position on re-render
        state.qrPageOverrides[cacheKey] = ovBody;
        if (viewingToday) {
          state.accountabilityNodes = await apiGet('/api/accountability/nodes', state.accountabilityNodes);
        }
      } else {
        // A refused move must SAY so. The pill has already been dragged to the
        // new position on screen, so silence reads as "saved" — and the next
        // re-render silently snaps it back. 403 is the 24h lock, which is the
        // only refusal a hand can produce.
        const msg = await res.json().catch(() => ({}));
        toast(msg.error || `Could not move it (${res.status})`);
      }
      // Moving the wake/sleep deadline moves the view window itself
      const isWindowNode = String(node.id) === String(state.settings.qr_wake_node_id)
        || String(node.id) === String(state.settings.qr_sleep_node_id);
      if (isWindowNode) renderTimeline();
      else renderQrLayer();
    }
  });
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
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
// (DAY_MIN itself is declared at the TOP of this file: `const` does not hoist,
// and state's view window uses it long before this point.)

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

function minutesToHHMM(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
  panel.innerHTML = '<div class="be-empty">Loading…</div>';

  let nodes = null;
  let locations = null;
  try {
    [nodes, locations, state.gateRoutines] = await Promise.all([
      fetch('/api/accountability/nodes').then(r => r.json()),
      fetch('/api/locations').then(r => r.json()),
      apiGet('/api/flows', []),
    ]);
  } catch (e) {
    nodes = null;
  }
  // A Worker error body still parses as JSON, so a failed load arrives here as
  // an object, not a throw. It has to be caught before it reaches state: a
  // non-array there breaks every later nodes.map/find — renderTimeline's
  // included, which took the whole to-do side of the app down with it.
  if (!Array.isArray(nodes)) {
    panel.innerHTML = '<div class="be-empty se-error">Failed to load gates.</div>';
    locPanel.innerHTML = '';
    return;
  }
  state.accountabilityNodes = nodes;
  state.locations = Array.isArray(locations) ? locations : [];
  beCounts.qr = nodes.filter(n => n.active).length;
  beCounts.locations = state.locations.filter(l => l.active !== 0).length;

  const nodeOptions = selectedId => '<option value="">— none —</option>'
    + nodes.filter(n => n.active).map(n =>
      `<option value="${n.id}"${String(n.id) === String(selectedId) ? ' selected' : ''}>${escHtml(n.label)}</option>`
    ).join('');

  panel.innerHTML = gatesTabBar(state.gatesBilling) + (gatesView.tab === 'gates' ? `
    <div class="be-list" id="be-gate-list">
      ${nodes.map(n => beRow(gateRowOpts(n))).join('')}${beAddRow('Add gate')}
    </div>
    ${gatesBoundary(nodes)}`
    : '<div id="be-gates-billing"></div>');

  panel.querySelectorAll('[data-gtab]').forEach(btn => btn.addEventListener('click', () => {
    gatesView.tab = btn.dataset.gtab;
    renderQrManager();
  }));

  if (gatesView.tab === 'system') {
    renderGatesBilling(false);
  } else {
    wireBeList(document.getElementById('be-gate-list'), 'gate', nodes);
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
    // The System tab's dot is a claim about the whole panel, so it is fetched
    // even when that tab is closed — a red dot you only see after opening the
    // thing it warns about is not a warning.
    if (!state.gatesBilling) {
      fetch('/api/gates/billing').then(r => r.json())
        .then(b => { state.gatesBilling = b; paintGatesTabs(); }).catch(() => {});
    }
  }

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

// The judge's vocabulary, said in words. `absent`/`would_fire` are what the
// database stores and what the Worker logged before it; a settings panel is
// not the place to learn them.
const GATE_FIELDS = {
  charge_cents: 'stake', window_start: 'from', window_end: 'to',
  window_end_offset_days: 'crosses midnight', days_of_week: 'days',
  geofence_lat: 'place', geofence_lng: 'place',
  geofence_radius_m: 'radius', weekly_windows: 'per-day times', active: 'state',
  source_uid: 'schedule', __delete__: 'delete gate',
};

// THE FENCE IS ONE DECISION IN THREE COLUMNS. Queued per field like everything
// else — which is right, since a field is the unit a tightening cancels — but
// calling off ONE of them would leave the gate at a latitude from the new
// place and a longitude from the old: a fence in the sea, satisfied by
// nothing. So the sheet shows the three as one row and cancels them together.
const GATE_FENCE = ['geofence_lat', 'geofence_lng', 'geofence_radius_m'];

// Queued changes as DECISIONS rather than columns: the fence's three fields
// collapse into one when they start on the same day, everything else is
// itself. Each carries the fields it would cancel.
function gatePendingGroups(pending) {
  const out = [];
  const fence = pending.filter(p => GATE_FENCE.includes(p.field));
  const days = [...new Set(fence.map(p => p.effective_date))];
  if (fence.length && days.length === 1) {
    const loc = (state.locations || []).find(l =>
      String(l.lat) === String((fence.find(p => p.field === 'geofence_lat') || {}).new_value));
    out.push({ label: 'place', text: loc ? loc.name : 'a new place',
               effective_date: days[0], fields: fence.map(p => p.field) });
  } else {
    fence.forEach(p => out.push({ label: GATE_FIELDS[p.field] || p.field,
                                  text: String(p.new_value),
                                  effective_date: p.effective_date, fields: [p.field] }));
  }
  pending.filter(p => !GATE_FENCE.includes(p.field)).forEach(p => out.push({
    label: p.field === '__delete__' ? '' : (GATE_FIELDS[p.field] || p.field),
    text: p.field === '__delete__' ? 'gate is deleted'
      : p.field === 'charge_cents' ? '$' + ((p.new_value || 0) / 100).toFixed(2)
      : p.field === 'active' ? (falsyFlag(p.new_value) ? 'paused' : 'active')
      : p.new_label || String(p.new_value),
    effective_date: p.effective_date, fields: [p.field],
  }));
  return out;
}

// '0' is a true string here too — the same trap storage.falsy exists for.
function falsyFlag(v) {
  return v === 0 || v === false || v === '0' || v === 'false' || v == null || v === '';
}

const GATE_REASONS = {
  absent: 'no scan',
  no_scan: 'no scan',
  geofence: 'scanned somewhere else',
  geofence_fail: 'scanned somewhere else',
  routine_incomplete: 'routine not done',
  routine_late: 'routine done late',
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
const gatesView = { tab: 'gates', boundary: false, allFailures: false };

// Green only when the whole chain is sound. A money system that shows a green
// light while it is misconfigured is worse than one that shows nothing.
function gatesHealth(b) {
  if (!b) return { cls: '', ok: false };
  if (judgeStale(b.judge_last_run)) return { cls: 'gb-bad', ok: false };
  if (b.live && (!b.has_token || !b.has_user)) return { cls: 'gb-bad', ok: false };
  return { cls: 'gb-good', ok: true };
}

// The judge runs on a timer, so "recently" is the whole test. 30 minutes is
// well over the 5-minute cadence and well under a window's worth of drift.
const JUDGE_STALE_MIN = 30;
function judgeStale(iso) {
  if (!iso) return true;
  return (Date.now() - new Date(iso).getTime()) / 60000 > JUDGE_STALE_MIN;
}

function agoLabel(iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function gatesTabBar(b) {
  const h = gatesHealth(b);
  return `<div class="gb-tabs">
    <button class="gb-tab${gatesView.tab === 'gates' ? ' gb-tab-on' : ''}" data-gtab="gates">Gates</button>
    <button class="gb-tab${gatesView.tab === 'system' ? ' gb-tab-on' : ''}" data-gtab="system">System
      <span class="gb-dot ${h.cls}"></span></button>
  </div>`;
}

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

// The System tab. Rows are the charge pipeline in failure order, so reading
// top-down is the diagnosis: nothing below a ✗ can work.
async function renderGatesBilling(verify) {
  const el = document.getElementById('be-gates-billing');
  if (!el) return;
  if (!el.innerHTML) el.innerHTML = '<div class="be-empty">Loading…</div>';
  const b = await fetch('/api/gates/billing' + (verify ? '?verify=1' : ''))
    .then(r => r.json()).catch(() => null);
  if (!b) { el.innerHTML = '<div class="be-empty se-error">Billing unavailable.</div>'; return; }
  state.gatesBilling = b;
  paintGatesTabs();
  const money = c => '$' + (Number(c || 0) / 100).toFixed(2);
  const pct = b.cap_cents ? Math.min(100, Math.round(b.spent_cents / b.cap_cents * 100)) : 0;
  const mark = ok => `<span class="gb-mark ${ok ? 'gb-good' : 'gb-bad'}">${ok ? '✓' : '✗'}</span>`;
  const idle = '<span class="gb-mark gb-idle">○</span>';

  // The verdict, in one sentence, and never ambiguous about money. Order
  // matters: a dead judge outranks every money question, because nothing is
  // being decided at all.
  let verdict, sub, cls;
  if (judgeStale(b.judge_last_run)) {
    cls = 'gb-bad';
    verdict = 'Judgment isn\'t running.';
    sub = `Nothing has been judged since ${agoLabel(b.judge_last_run)} — gates are not being decided.`;
  } else if (!b.live) {
    cls = 'gb-good';
    verdict = 'Scanning works. No money moves.';
    sub = 'Failures are judged and logged, but charging is off.';
  } else if (!b.has_token || !b.has_user) {
    cls = 'gb-bad';
    verdict = 'Charging is armed but cannot work.';
    sub = `Missing ${!b.has_token ? 'the token' : 'the username'}, so every charge fails instead of billing you.`;
  } else if (b.dryrun) {
    cls = 'gb-good';
    verdict = 'Live, in dry run. No money moves.';
    sub = 'Every failure calls Beeminder with dryrun set — the whole pipeline, minus the money.';
  } else {
    cls = 'gb-live';
    verdict = 'LIVE. Money moves.';
    sub = `A failed gate bills ${escHtml(b.user || '')} up to ${money(b.cap_cents)} a week.`;
  }

  // Failures grouped BY DAY: three gates missed on one day is one fact about
  // that day, not three rows. The dominant reason carries the count.
  const byDate = {};
  (b.recent || []).forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });
  const dates = Object.keys(byDate).sort().reverse();
  const shown = gatesView.allFailures ? dates : dates.slice(0, 3);
  const label = id => (state.accountabilityNodes.find(n => n.id === id) || {}).label || `#${id}`;
  const charged = (b.recent || []).reduce((t, r) =>
    t + (['succeeded', 'unknown'].includes(r.charge_status) ? (r.amount_cents || 0) : 0), 0);

  el.innerHTML = `
    <div class="gb-verdict">
      <div class="gb-vline"><span class="gb-dot ${cls}"></span><span class="gb-vtext">${escHtml(verdict)}</span></div>
      <div class="gb-vsub">${sub}</div>
    </div>

    <div class="be-sub-head">Charge pipeline</div>
    <div class="be-list">
      <div class="be-set-row">
        ${mark(!judgeStale(b.judge_last_run))}
        <span class="be-set-name">Gates judged on the server</span>
        <span class="gb-val">${escHtml(agoLabel(b.judge_last_run))}</span>
      </div>
      <button class="be-set-row gb-rowbtn" data-gbsheet="1">
        ${mark(b.token ? b.token.valid : b.has_token)}
        <span class="be-set-name">Beeminder token</span>
        <span class="gb-val">${b.token
          ? (b.token.valid ? 'valid' : escHtml(b.token.reason || 'invalid'))
          : (b.has_token ? 'set — not checked' : 'not set')}</span>
        <span class="be-chev">›</span>
      </button>
      <div class="be-set-row">
        ${mark(b.has_user)}
        <span class="be-set-name">Bills</span>
        <span class="gb-val">${b.has_user ? escHtml(b.user) : 'unset'}</span>
        <button id="gb-verify" class="be-set-ctl">Check</button>
      </div>
      <div class="be-set-row">
        ${b.live ? mark(true) : idle}
        <span class="be-set-name">Charging</span>
        <div class="gb-seg" id="gb-seg">
          <button data-gmode="off" class="${!b.live ? 'gb-seg-on' : ''}">off</button>
          <button data-gmode="dry" class="${b.live && b.dryrun ? 'gb-seg-on' : ''}">dry run</button>
          <button data-gmode="live" class="${b.live && !b.dryrun ? 'gb-seg-on gb-seg-live' : ''}">live</button>
        </div>
      </div>
      <button class="be-set-row gb-rowbtn" data-gbsheet="1">
        <span class="gb-mark"></span>
        <span class="be-set-name">Stake / weekly cap</span>
        <span class="gb-val">${(b.default_cents / 100).toFixed(2)} / ${(b.cap_cents / 100).toFixed(2)}${
          b.fee_cents ? ` <span class="gb-fee" title="Each stake bills Beeminder the stake minus this card fee">(${
            ((b.default_cents - b.fee_cents) / 100).toFixed(2)} + ${(b.fee_cents / 100).toFixed(2)} fee)</span>` : ''}</span>
        <span class="be-chev">›</span>
      </button>
      <div class="be-set-row">
        <span class="gb-mark"></span>
        <span class="be-set-name">This week</span>
        <span class="gb-val">${money(b.spent_cents)}</span>
        <span class="gb-bar"><i style="width:${pct}%"></i></span>
      </div>
    </div>
    <div class="be-hint">The token lives in config.json on the server, never in the database —
      a credential that can move money has no business in a backup set. Nothing reads it back
      out, this panel included.</div>

    <div class="gb-log-head">
      <span>Judged failures · 7 days</span>
      <span class="gb-val">${(b.recent || []).length} · ${money(charged)} charged</span>
    </div>
    ${dates.length ? `<div class="be-list">${shown.map(d => {
      const rows = byDate[d];
      const reasons = {};
      rows.forEach(r => { reasons[gateReason(r.failure_reason)] = (reasons[gateReason(r.failure_reason)] || 0) + 1; });
      const top = Object.entries(reasons).sort((x, y) => y[1] - x[1])[0];
      const paid = rows.reduce((t, r) => t + (['succeeded', 'unknown'].includes(r.charge_status) ? (r.amount_cents || 0) : 0), 0);
      return `<div class="be-set-row">
        <span class="gb-date">${escHtml(d.slice(5))}</span>
        <span class="be-set-name">${escHtml(rows.map(r => label(r.node_id)).join(' · '))}</span>
        <span class="gb-val">${escHtml(top[0])}${top[1] > 1 ? ` ×${top[1]}` : ''}</span>
        <span class="gb-amt">${paid ? money(paid) : ''}</span>
      </div>`;
    }).join('')}</div>`
      : '<div class="be-hint">No failures judged this week.</div>'}
    ${dates.length > 3 ? `<button class="gb-more" id="gb-more">${gatesView.allFailures
      ? 'Show fewer' : `Show all ${dates.length} days`}</button>` : ''}`;

  el.querySelector('#gb-verify').addEventListener('click', () => renderGatesBilling(true));
  const more = el.querySelector('#gb-more');
  if (more) more.addEventListener('click', () => {
    gatesView.allFailures = !gatesView.allFailures;
    renderGatesBilling(false);
  });
  el.querySelectorAll('[data-gbsheet]').forEach(btn =>
    btn.addEventListener('click', () => openSeSheet('billing', b)));

  // One control for the money state, three states, mutually exclusive — the
  // two independent toggles let you sit in "off but not dry", which reads as
  // safe and is one switch away from real charges.
  el.querySelectorAll('#gb-seg button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.gmode;
      if (mode === 'live' && !confirm('Charge for real? A failed gate will bill '
        + `${b.user || 'your Beeminder account'} immediately, up to `
        + `$${(b.cap_cents / 100).toFixed(2)} a week.`)) return;
      await apiSend('/api/gates/billing', 'PATCH', {
          gate_charging_live: mode !== 'off',
          gate_charge_dryrun: mode !== 'live',
        });
      await renderGatesBilling(false);
    });
  });
}

// The tab strip's dot has to follow the health it reports, and the billing
// fetch is what learns it — so the strip is repainted from there, not rebuilt.
function paintGatesTabs() {
  const bar = document.querySelector('#be-qr-section .gb-tabs');
  if (!bar) return;
  const dot = bar.querySelector('[data-gtab="system"] .gb-dot');
  if (dot) dot.className = `gb-dot ${gatesHealth(state.gatesBilling).cls}`;
}

// A gate's row: the window and days it runs, the place it is pinned to, and a
// badge only for a state that isn't the default one.
function gateRowOpts(n) {
  const nodeDays = (n.days_of_week || '0123456').split('').map(Number);
  const win = `${n.window_start}–${n.window_end}${n.window_end_offset_days ? ' +1d' : ''}`;
  const loc = (state.locations || []).find(l => l.lat === n.geofence_lat && l.lng === n.geofence_lng);
  const geo = n.geofence_lat != null
    ? `${loc ? loc.name : `${n.geofence_lat.toFixed(4)}, ${n.geofence_lng.toFixed(4)}`} (${n.geofence_radius_m}m)`
    : 'no geofence';

  let weekly = {};
  if (n.weekly_windows) { try { weekly = JSON.parse(n.weekly_windows) || {}; } catch (e) { /* stored blank */ } }
  const pendingDisable = (n.pending_changes || []).find(p => p.field === 'active' && String(p.new_value) === '0');
  const otherPending = (n.pending_changes || []).filter(p => p.field !== 'active');

  const pendingDelete = (n.pending_changes || []).find(p => p.field === '__delete__');

  let badge = '';
  if (pendingDelete) badge = 'deleting';
  else if (!n.active) badge = 'paused';
  else if (pendingDisable) badge = 'pausing';
  else if (n.today_override) badge = 'today';
  else if (otherPending.length) badge = 'pending';
  else if (!n.schedule_label && Object.keys(weekly).length) badge = 'per-day';

  // Today's ANSWER where there is one — scanned, or judged and why. A row that
  // only restates its own settings can't tell you the gate is broken.
  // A judgment row no longer means FAILED (2026-08-17): the judge freezes the
  // day it closes, success included, so it is failure_reason that decides.
  const st = n.today_state || {};
  let today = '';
  if (st.judged && st.judged.failure_reason) {
    today = `✗ ${gateReason(st.judged.failure_reason)} · ${gateStatus(st.judged.charge_status)}`;
  } else if (st.scan) {
    today = `✓ scanned ${st.scan.scanned_at.slice(11, 16)}`
      + (st.scan.geofence_pass === 0 ? ' — outside the geofence' : '');
  }

  // Only a NON-default stake is stated: a default is not information, but a
  // gate that costs four times its neighbours is.
  const stake = n.charge_cents != null ? ` · $${(n.charge_cents / 100).toFixed(2)}` : '';

  // The ROUTINE gets its own line, always, and first on it. It is half of what
  // decides ✓/✗ — it cannot be the part that falls off the end of a meta
  // string, and a gate demanding a routine you'd forgotten is the whole reason
  // to look at this list.
  const sub = [n.routine ? `needs ${n.routine}` : null, today]
    .filter(Boolean).join(' · ');

  return {
    id: n.id, name: n.label, dim: !n.active,
    meta: `${n.schedule_label || win + ' · ' + formatDays(nodeDays)} · ${geo}${stake}`,
    sub: sub || null,
    badge,
    subClass: n.routine ? 'be-row-req' : '',
  };
}

async function removeOverride(nodeId, date) {
  const res = await apiSend(`/api/accountability/nodes/${nodeId}/overrides/${date}`, 'DELETE');
  if (!res.ok) toast(`Remove override failed (${res.status}): ${await res.text()}`);
  await renderQrManager();
}

// ── People (CRM) ──────────────────────────────────────────────

const CADENCES = ['none', 'weekly', 'monthly', 'quarterly', 'biannual'];

const peopleView = { table: null, ready: false, pending: null, people: [], buckets: [], detailId: null,
  editable: false, win: { open: false }, sessionEnd: 0, sessionTimer: null, satisfiedDate: null };

// Editing is only allowed during the nightly fill session (window open + started,
// within the 10-min cap). Test hooks: window.__peopleWindow forces the window
// state; window.__peopleCapSecs overrides the 600s cap.
function peopleEditable() { return peopleView.editable; }
const PEOPLE_CAP_SECS = 600;

function peopleBucketOptions() {
  return peopleView.buckets.filter(b => b.active).map(b => ({ value: b.id, label: b.name }));
}

function initPeopleModals() {
  const wire = (overlayId, closeId) => {
    const overlay = document.getElementById(overlayId);
    document.getElementById(closeId).addEventListener('click', () => overlay.classList.add('hidden'));
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
  };
  wire('person-detail-overlay', 'person-detail-close');
  wire('bucket-mgr-overlay', 'bucket-mgr-close');
  wire('person-add-overlay', 'person-add-close');

  document.getElementById('people-add-btn').addEventListener('click', openAddPerson);
  document.getElementById('people-buckets-btn').addEventListener('click', openBucketMgr);
}

// Entered from the hub rail: render the grid once, show the session bar
// immediately, and start the nightly-fill window poll.
function openPeopleSurface() {
  renderPeople();
  renderSessionBar();
  peopleWindowPoll();
  if (!peopleView.pollTimer) peopleView.pollTimer = setInterval(peopleWindowPoll, 20000);
}

async function renderPeople() {
  await loadPeopleData();
}
window.renderPeople = renderPeople;

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
const trackingView = { metrics: [], habits: null, open: null, days: 60 };

async function openTracking() {
  trackingView.open = null;
  await refreshTracking();
}
window.openTracking = openTracking;

async function refreshTracking() {
  const [ov, habits] = await Promise.all([
    apiGet(`/api/metrics/overview?days=${trackingView.days}`, { metrics: trackingView.metrics }),
    apiGet('/api/habits', trackingView.habits),
  ]);
  trackingView.metrics = (ov && ov.metrics) || [];
  trackingView.habits = habits;
  renderTracking();
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
  const title = document.getElementById('tracking-title');
  if (!body) return;
  if (trackingView.open) { renderMetricDetail(body, title); return; }
  title.textContent = 'Tracking';

  const rows = trackingView.metrics.map(m => {
    const last = m.last;
    const recentText = m.kind === 'text'
      ? m.entries.slice(-2).reverse().map(e =>
          `<span class="mx-quote">${escHtml((e.value_text || '').slice(0, 90))}</span>`).join('')
      : '';
    return `<button class="mx-row" data-metric="${m.id}">
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
    <div class="mx-list">${rows || `<div class="gtd-empty">No metrics yet — Settings → `
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
function renderMetricDetail(body, title) {
  const m = trackingView.metrics.find(x => x.id === trackingView.open);
  if (!m) { trackingView.open = null; renderTracking(); return; }
  title.textContent = m.name;
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
        `<button class="mx-set${String(e.value_num) === v ? ' mx-set-on' : ''}"`
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
      <span class="mx-meta">${escHtml(m.prompt || '')}</span>
    </div>
    ${entries.map(e => `
      <div class="mx-day">
        <span class="mx-day-date">${escHtml(e.date)}</span>
        ${control(e)}
        <span class="mx-day-step">${escHtml(stepName(e.step_id))}</span>
      </div>`).join('')
      || '<div class="gtd-empty">Nothing answered in this window yet.</div>'}`;

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
  if (!hb) { el.innerHTML = '<span class="jh-empty">Habits unavailable.</span>'; return; }
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

// --- nightly-fill window + 10-min hard-capped session ---

async function peopleWindowPoll() {
  if (window.__peopleWindow) { peopleView.win = window.__peopleWindow; }
  else {
    peopleView.win = await fetch('/api/people/window').then(r => r.json())
      .catch(() => ({ open: false, seconds_left: 0 }));
  }
  // if the window closed while a session was running, end it — unless the
  // ROUTINE opened this one, which never had a scan window behind it.
  if (!peopleView.win.open && peopleView.editable && !peopleView.forced) endPeopleSession();
  renderSessionBar();
}

function startPeopleSession(opts) {
  // `force` is the ROUTINE opening the fill (the crm_fill step). The scan-gated
  // window is not the only honest opener — running tonight's routine is the
  // same statement — but the 10-minute cap still applies, unchanged.
  const forced = !!(opts && opts.force);
  if (!peopleView.win.open && !forced) return;
  const cap = window.__peopleCapSecs || PEOPLE_CAP_SECS;
  const winLeft = forced ? cap : (peopleView.win.seconds_left || cap);
  peopleView.sessionEnd = Date.now() + Math.min(cap, winLeft) * 1000;
  peopleView.editable = true;
  peopleView.forced = forced;
  if (peopleView.sessionTimer) clearInterval(peopleView.sessionTimer);
  peopleView.sessionTimer = setInterval(() => {
    if (Date.now() >= peopleView.sessionEnd) endPeopleSession();
    else renderSessionBar();
  }, 1000);
  renderSessionBar();
}

function endPeopleSession() {
  peopleView.editable = false;
  peopleView.forced = false;
  if (peopleView.sessionTimer) { clearInterval(peopleView.sessionTimer); peopleView.sessionTimer = null; }
  peopleView.sessionEnd = 0;
  document.getElementById('person-detail-overlay').classList.add('hidden');
  document.getElementById('person-add-overlay').classList.add('hidden');
  renderSessionBar();
}

async function peopleSatisfy(kind) {
  // The RUN's day when the runner raised this surface (crm_fill opens the CRM
  // over itself), the wall day otherwise — runDay() is that sentence.
  const today = runDay();
  if (kind === 'entries' && peopleView.satisfiedDate === today) return;
  peopleView.satisfiedDate = today;
  await apiSend('/api/people/night', 'POST', { kind, date: today }).catch(() => {});
}

// The countdown, over every surface. The .psb bar below lives inside the
// People tab (z 140), while the add/log forms are fixed at z 150 — so during
// the fill, the only ten minutes the clock actually governs, it was hidden
// behind the form you were filling in. Painted before the guard so it stays
// correct even if the People markup isn't there.
function paintPeopleTimer() {
  const el = document.getElementById('people-timer');
  if (!el) return;
  if (!peopleView.editable) { el.classList.add('hidden'); return; }
  const left = Math.max(0, Math.round((peopleView.sessionEnd - Date.now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  // Shorter than the in-flow bar's copy on purpose: it is centred over whatever
  // surface you are on, so every character it doesn't need is one it isn't
  // covering. The countdown reads as a countdown without "left".
  el.textContent = `Nightly fill · ${mm}:${ss}`;
  el.classList.remove('hidden');
}

function renderSessionBar() {
  paintPeopleTimer();
  const bar = document.getElementById('people-session-bar');
  const wrap = document.getElementById('people-wrap');
  if (!bar || !wrap) return;
  wrap.classList.toggle('people-locked', !peopleView.editable);
  // During the fill the unified add/log form is the catch-all: most entries are
  // an interaction with someone already in the list, so the button says so.
  const addBtn = document.getElementById('people-add-btn');
  if (addBtn) addBtn.textContent = peopleView.editable ? '+ add interaction' : '+ add person';
  if (peopleView.editable) {
    const left = Math.max(0, Math.round((peopleView.sessionEnd - Date.now()) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    bar.className = 'psb psb-active';
    bar.innerHTML = `<span class="psb-timer">Nightly fill · ${mm}:${ss} left</span>
      <button id="psb-nothing" class="be-btn-secondary">nothing tonight</button>`;
    bar.querySelector('#psb-nothing').addEventListener('click', async () => {
      await peopleSatisfy('nothing');
      endPeopleSession();
    });
  } else if (peopleView.win.open) {
    bar.className = 'psb psb-open';
    bar.innerHTML = `<span>Nightly fill is open</span>
      <button id="psb-start" class="be-btn-primary">start nightly fill</button>`;
    bar.querySelector('#psb-start').addEventListener('click', startPeopleSession);
  } else {
    bar.className = 'psb psb-closed';
    bar.textContent = 'Read-only — editing opens when you scan your sleep gate (10-min session)';
  }
}

// Palette for the manual recolor picker (auto-assignment happens server-side).
const BUCKET_PALETTE_JS = (() => {
  const out = [];
  for (let h = 0; h < 360; h += 15) out.push(`hsl(${h}, 55%, 60%)`);
  return out;
})();

function bucketChip(b) {
  const c = b.color || '#8a8a8a';
  return `<span class="people-chip" style="border-color:${c}"><span class="people-chip-dot" style="background:${c}"></span>${escHtml(b.name)}</span>`;
}

async function loadPeopleData() {
  const [buckets, people] = await Promise.all([
    apiGet('/api/buckets', []),
    apiGet('/api/people', []),
  ]);
  peopleView.buckets = Array.isArray(buckets) ? buckets : [];
  peopleView.people = Array.isArray(people) ? people : [];
  renderPeopleList();
  renderDueStrip();
}

// Mobile list: search + name/bucket/next-action rows; every edit lives in the
// detail modal (still gated by the nightly-fill session).
function renderPeopleList() {
  const grid = document.getElementById('people-grid');
  if (!grid) return;
  const q = (peopleView.query || '').toLowerCase();
  const people = peopleView.people
    .filter(p => !q || (p.name || '').toLowerCase().includes(q)
                    || (p.company || '').toLowerCase().includes(q))
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  grid.innerHTML = `
    <input type="text" id="people-search" class="people-search" placeholder="⌕ search people…" value="${escHtml(peopleView.query || '')}" autocomplete="off">
    <div class="people-list">
      ${people.map(p => `
        <button class="pl-row" data-id="${p.id}">
          <span class="pl-main">
            <span class="pl-name">${escHtml(p.name || '')}</span>
            <span class="pl-chips">${(p.buckets || []).map(bucketChip).join('')}</span>
          </span>
          <span class="pl-meta">
            ${p.next_action ? `<span class="pl-next">→ ${escHtml(p.next_action)}</span>` : ''}
            <span class="pl-last">${escHtml(p.last_contact || 'never')}</span>
          </span>
        </button>`).join('') || '<div class="gtd-empty">No people yet</div>'}
    </div>`;
  grid.querySelector('#people-search').addEventListener('input', e => {
    peopleView.query = e.target.value;
    preserveCaret('people-search', renderPeopleList);
  });
  grid.querySelectorAll('.pl-row').forEach(r =>
    r.addEventListener('click', () => openPersonDetail(parseInt(r.dataset.id))));
}

function renderDueStrip() {
  const strip = document.getElementById('people-due-strip');
  if (!strip) return;
  const today = wallDay();
  const due = peopleView.people
    .filter(p => p.next_due && p.next_due <= today)
    .sort((a, b) => a.next_due.localeCompare(b.next_due))
    .slice(0, 5);
  if (!due.length) { strip.innerHTML = ''; return; }
  strip.innerHTML = `<div class="due-strip-label">Due</div>` + due.map(p => `
    <div class="due-card" data-id="${p.id}">
      <div class="due-name">${escHtml(p.name)}</div>
      <div class="due-action">${escHtml(p.next_action || '')}</div>
      <button class="due-skip" data-id="${p.id}">skip this cycle</button>
    </div>`).join('');
  strip.querySelectorAll('.due-card .due-name, .due-card .due-action').forEach(el => {
    el.addEventListener('click', () => openPersonDetail(Number(el.closest('.due-card').dataset.id)));
  });
  strip.querySelectorAll('.due-skip').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!peopleView.editable) return;
      btn.disabled = true;
      const res = await apiSend(`/api/people/${btn.dataset.id}/skip-cycle`, 'POST');
      if (!res.ok) { toast(`Skip failed (${res.status})`); btn.disabled = false; return; }
      await loadPeopleData();
    });
  });
}

function openPersonDetail(id) {
  peopleView.detailId = id;
  const p = peopleView.people.find(x => x.id === id);
  if (!p) return;
  renderPersonDetail(p);
  document.getElementById('person-detail-overlay').classList.remove('hidden');
}

function renderPersonDetail(p) {
  document.getElementById('person-detail-title').textContent = p.name || 'Person';
  const body = document.getElementById('person-detail-body');
  const sub = [p.company, p.location].filter(Boolean).join(' · ');
  // The grid used to be the field editor; with the mobile list, the detail
  // modal edits every field — still gated by the nightly-fill session.
  const meta = peopleView.editable
    ? `
      ${[['name', 'Name'], ['company', 'Company'], ['location', 'Location'],
         ['birthday', 'Birthday'], ['how_we_met', 'How we met'], ['next_action', 'Next action']]
        .map(([f, label]) => `<div class="pd-meta"><span>${label}</span>
          <input type="text" class="pd-edit" data-field="${f}" value="${escHtml(p[f] || '')}"></div>`).join('')}
      <div class="pd-meta"><span>Cadence</span>
        <select class="pd-edit" data-field="cadence">${CADENCES.map(c =>
          `<option value="${c}"${(p.cadence || 'none') === c ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="pd-meta"><span>Contact</span>
        <input type="checkbox" class="pd-edit" data-field="has_contact"${p.has_contact ? ' checked' : ''}></div>
      <div class="pd-meta"><span>Buckets</span><span class="pd-bucket-chips">${
        peopleView.buckets.filter(b => b.active || (p.buckets || []).some(x => x.id === b.id)).map(b => {
          const on = (p.buckets || []).some(x => x.id === b.id);
          return `<button class="pd-bucket-chip${on ? ' pd-bucket-on' : ''}" data-bucket="${b.id}">${escHtml(b.name)}</button>`;
        }).join('')}<button class="pd-bucket-chip pd-bucket-new" id="pd-bucket-new">+ bucket</button></span></div>`
    : [
      p.birthday && `<div class="pd-meta"><span>Birthday</span>${escHtml(p.birthday)}</div>`,
      p.how_we_met && `<div class="pd-meta"><span>How we met</span>${escHtml(p.how_we_met)}</div>`,
      `<div class="pd-meta"><span>Cadence</span>${escHtml(p.cadence || 'none')}</div>`,
      `<div class="pd-meta"><span>Contact</span>${p.has_contact ? 'Yes' : '—'}</div>`,
      p.next_action && `<div class="pd-meta"><span>Next action</span>${escHtml(p.next_action)}</div>`,
    ].filter(Boolean).join('');
  const ints = p.interactions || [];
  const log = ints.length
    ? ints.map(i => `<div class="pd-log-row"><span class="pd-log-date">${escHtml(i.date)}</span><span class="pd-log-note">${escHtml(i.note || '')}</span><span class="pd-log-src">${escHtml(i.source || '')}</span></div>`).join('')
    : `<div class="pd-empty">No interactions logged yet</div>`;
  body.innerHTML = `
    ${sub ? `<div class="pd-sub">${escHtml(sub)}</div>` : ''}
    <div class="pd-metas">${meta}</div>
    <label class="pd-label">Notes</label>
    <textarea id="pd-notes" class="pd-notes" placeholder="Notes…">${escHtml(p.notes || '')}</textarea>
    <div class="pd-log-heading">Interactions</div>
    <form id="pd-add-form" class="pd-add-form">
      <input type="date" id="pd-int-date" value="${escHtml(runDay())}">
      <input type="text" id="pd-int-note" placeholder="What happened?" autocomplete="off">
      <select id="pd-int-source">
        <option value="desktop">desktop</option>
        <option value="phone">phone</option>
      </select>
      <button type="submit" class="be-btn-primary" id="pd-int-submit">Log</button>
    </form>
    <div class="pd-log">${log}</div>
    <div class="pd-footer">
      <button id="pd-delete" class="pd-delete" ${peopleView.editable ? '' : 'disabled'}>Delete person</button>
    </div>`;

  const pdPatch = async payload => {
    const res = await apiSend(`/api/people/${p.id}`, 'PATCH', payload);
    if (!res.ok) { toast(`Save failed (${res.status})`); return null; }
    const person = await res.json();
    syncPersonRow(person);
    return person;
  };
  body.querySelectorAll('.pd-edit').forEach(el => {
    el.addEventListener('change', async () => {
      const value = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;
      const person = await pdPatch({ [el.dataset.field]: value });
      if (person && el.dataset.field === 'name') {
        document.getElementById('person-detail-title').textContent = person.name || 'Person';
      }
    });
  });
  body.querySelectorAll('.pd-bucket-chip[data-bucket]').forEach(el => {
    el.addEventListener('click', async () => {
      const bid = parseInt(el.dataset.bucket);
      const ids = (p.buckets || []).map(b => b.id);
      const next = ids.includes(bid) ? ids.filter(x => x !== bid) : [...ids, bid];
      const person = await pdPatch({ bucket_ids: next });
      if (person) renderPersonDetail(person);
    });
  });
  // A BUCKET CAN BE MINTED HERE (2026-08-17). The fill is where you find out a
  // bucket is missing — you are looking at the person who does not fit any of
  // them — and the only way to add one was to leave the person, open the
  // bucket manager, add it, and come back to a 10-minute session you had just
  // spent. It mints AND files in one go, because naming it while looking at
  // the person is what makes it the right bucket.
  //
  // The ENTRY SHEET, like every other list datatype's add: one add grammar,
  // and at z-200 it opens above the person modal (175 over the runner).
  const newBucket = document.getElementById('pd-bucket-new');
  if (newBucket) {
    newBucket.addEventListener('click', () => openEntrySheet({
      title: 'New bucket',
      placeholder: 'e.g. Climbing',
      hint: `Added to ${p.name || 'this person'} as well.`,
      button: 'Add', closeOnAdd: true,
      add: async raw => {
        const name = raw.trim();
        if (!name) return;
        const res = await apiSend('/api/buckets', 'POST', { name });
        if (!res.ok) { toast('Could not add that bucket'); return; }
        const bucket = await res.json();
        peopleView.buckets = await apiGet('/api/buckets', peopleView.buckets);
        const person = await pdPatch({
          bucket_ids: [...(p.buckets || []).map(b => b.id), bucket.id] });
        if (person) renderPersonDetail(person);
      },
    }));
  }

  const pdNotes = document.getElementById('pd-notes');
  pdNotes.readOnly = !peopleView.editable;
  const pdFlush = wireNotesAutosave(pdNotes, async value => {
    if (!peopleView.editable) return;
    const res = await apiSend(`/api/people/${p.id}`, 'PATCH', { notes: value });
    if (!res.ok) return;
    p.notes = value;
    syncPersonRow(await res.json());
  });
  pdNotes.addEventListener('blur', pdFlush);
  document.getElementById('pd-add-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!peopleView.editable) return;
    const btn = document.getElementById('pd-int-submit');
    if (btn.disabled) return;
    const date = document.getElementById('pd-int-date').value;
    const note = document.getElementById('pd-int-note').value;
    const source = document.getElementById('pd-int-source').value;
    if (!date) return;
    btn.disabled = true;
    try {
      const res = await apiSend(`/api/people/${p.id}/interactions`, 'POST', { date, note, source });
      if (!res.ok) { toast(`Log failed (${res.status})`); return; }
      await peopleSatisfy('entries');
      await loadPeopleData();
      const fresh = peopleView.people.find(x => x.id === p.id);
      if (fresh) renderPersonDetail(fresh);
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('pd-delete').addEventListener('click', async () => {
    if (!peopleView.editable) return;
    if (!confirm(`Delete ${p.name || 'this person'} and all their logged interactions? This cannot be undone.`)) return;
    const btn = document.getElementById('pd-delete');
    btn.disabled = true;
    const res = await apiSend(`/api/people/${p.id}`, 'DELETE');
    if (!res.ok) { toast(`Delete failed (${res.status})`); btn.disabled = false; return; }
    document.getElementById('person-detail-overlay').classList.add('hidden');
    await loadPeopleData();
  });
}

function syncPersonRow(person) {
  const idx = peopleView.people.findIndex(p => p.id === person.id);
  if (idx >= 0) peopleView.people[idx] = person;
  renderPeopleList();
  renderDueStrip();
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
  { key: 'next', name: 'Next actions',
    keep: (i, today) => i.kind !== 'project' && i.status === 'active'
      && !(i.defer_until && i.defer_until > today) },
  { key: 'waiting', name: 'Waiting & deferred',
    keep: (i, today) => i.status === 'waiting'
      || (i.status === 'active' && i.defer_until && i.defer_until > today) },
  { key: 'projects', name: 'Projects', keep: i => i.kind === 'project' },
  { key: 'someday', name: 'Someday / maybe', keep: i => i.status === 'on_hold' },
];

const mapView = { q: '', lens: 'all', domainId: null, tags: new Set(), menuOpen: false };

function mapLens() {
  return MAP_LENSES.find(l => l.key === mapView.lens) || MAP_LENSES[0];
}

// How many terms are narrowing the list beyond the lens — what the pill counts.
function mapFilterExtras() {
  return (mapView.domainId != null ? 1 : 0) + mapView.tags.size;
}

// THE ONE PLACE the inventory is narrowed. Search runs over the result of this,
// not beside it: a search inside "Waiting & deferred" must not turn up an
// action you are not asking about.
function mapVisibleItems(items, today) {
  const lens = mapLens();
  return items.filter(i =>
    lens.keep(i, today)
    && (mapView.domainId == null || String(i.domain_id) === String(mapView.domainId))
    && [...mapView.tags].every(t => itemTags(i).includes(t)));
}

// MAP at a NAMED LENS, for the review steps that are really "go look at this
// slice and fix it". The lens is the one MAP already has (MAP_LENSES) — the
// review does not get a second projects list with its own rules.
//
// `overRunner` is the crm_fill idiom: MAP is z-150 and the runner z-165, so
// without the class it would open BEHIND the run you launched it from. The
// class comes off when MAP closes, which puts you back on the step.
async function openMapAtLens(lens, overRunner) {
  mapView.lens = lens;
  mapView.q = '';
  if (overRunner) document.body.classList.add('map-over-runner');
  await openMap();
}

async function openMap() {
  if (!mapWired) {
    const overlay = document.getElementById('map-overlay');
    const shut = () => {
      flushOpenNotes();
      overlay.classList.add('hidden');
      document.body.classList.remove('map-over-runner');
    };
    document.getElementById('map-close').addEventListener('click', shut);
    overlay.addEventListener('click', e => { if (e.target === overlay) shut(); });
    // Wired once, outside renderMap: re-rendering the body on every keystroke
    // must not take the field you are typing in with it.
    const sortBtn = document.getElementById('map-sort');
    sortBtn.addEventListener('click', () => {
      if (mapSortOn()) localStorage.setItem('mapSort', 'off');
      else localStorage.removeItem('mapSort');   // absent = on, one default
      renderMap();
    });
    document.getElementById('map-filter').addEventListener('click', e => {
      e.stopPropagation();
      mapView.menuOpen = !mapView.menuOpen;
      renderMapFilter();
    });
    // Tapping anywhere else in the overlay puts the menu away — it is transient
    // chrome, which is the whole point of 23a over a permanent rail.
    document.getElementById('map-modal').addEventListener('click', e => {
      if (!e.target.closest('#map-filter-menu, #map-filter')) closeMapFilter();
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
  await refreshMap();
  document.getElementById('map-overlay').classList.remove('hidden');
}

// The pill NAMES the lens, and counts the domain/tag terms rather than listing
// them — unlike Engage's context button, which is the receipt for items the
// POOL is hiding and must name every term. MAP hides nothing permanently: the
// menu is one tap away and shows exactly what is on.
function renderMapFilter() {
  const pill = document.getElementById('map-filter');
  const menu = document.getElementById('map-filter-menu');
  if (!pill || !menu) return;
  const extras = mapFilterExtras();
  pill.textContent = `${mapLens().name}${extras ? ` · ${extras}` : ''} ▾`;
  pill.classList.toggle('map-filter-on', mapView.lens !== 'all' || !!extras);
  pill.title = 'What the list is showing — lens, domain and tags';

  menu.classList.toggle('hidden', !mapView.menuOpen);
  if (!mapView.menuOpen) { menu.innerHTML = ''; return; }

  // Tags offered are the ones the inventory actually carries, plus any already
  // required — narrowing to a tag must never make its own chip disappear.
  const vocab = [...new Set([
    ...(state.mapItems || []).flatMap(itemTags), ...mapView.tags,
  ])].sort();
  const domains = (state.domains || []).filter(d =>
    d.active !== 0 || String(d.id) === String(mapView.domainId));

  menu.innerHTML = `
    <div class="map-filter-sec">List — showing</div>
    <div class="map-filter-chips">
      ${MAP_LENSES.map(l => `<button class="ctx-chip ${
        l.key === mapView.lens ? 'ctx-req' : 'ctx-off'}" data-lens="${l.key}"
        >${escHtml(l.name)}</button>`).join('')}
    </div>
    <div class="map-filter-sec">Domain — in force</div>
    <div class="map-filter-chips">
      <button class="ctx-chip ${mapView.domainId == null ? 'ctx-req' : 'ctx-off'}"
        data-mapdomain="">All domains</button>
      ${domains.map(d => `<button class="ctx-chip ${
        String(d.id) === String(mapView.domainId) ? 'ctx-req' : 'ctx-off'}"
        data-mapdomain="${d.id}">${escHtml(d.name)}</button>`).join('')}
    </div>
    <div class="map-filter-sec">Tags — every selected one required</div>
    <div class="map-filter-chips">
      ${vocab.length ? vocab.map(t => {
        const on = mapView.tags.has(t);
        return `<button class="ctx-chip ${on ? 'ctx-req' : 'ctx-off'}" data-maptag="${escHtml(t)}"
          title="${on ? 'required — click to clear' : 'click to require'}"
          >${on ? '∧' : ''}${escHtml(t)}</button>`;
      }).join('') : '<span class="cl-hint">no tags in the inventory yet</span>'}
    </div>
    ${mapView.lens !== 'all' || mapFilterExtras() ? `
    <div class="map-filter-foot">
      <button class="ctx-chip" id="map-filter-clear">⟳ show everything</button>
    </div>` : ''}`;

  // stopPropagation on every one of these: the handler RE-RENDERS the menu, so
  // by the time the click bubbles to the modal's tap-off handler its target has
  // been replaced and `closest('#map-filter-menu')` no longer finds it — the
  // menu would put itself away on its own chips. The menu stays open across a
  // pick on purpose: narrowing is usually several taps (a lens, then a tag).
  const stay = (el, fn) => el.addEventListener('click', e => {
    e.stopPropagation();
    fn();
    renderMap();
  });
  menu.querySelectorAll('[data-lens]').forEach(b =>
    stay(b, () => { mapView.lens = b.dataset.lens; }));
  menu.querySelectorAll('[data-mapdomain]').forEach(b => stay(b, () => {
    mapView.domainId = b.dataset.mapdomain === '' ? null : parseInt(b.dataset.mapdomain);
  }));
  menu.querySelectorAll('[data-maptag]').forEach(b => stay(b, () => {
    const t = b.dataset.maptag;
    if (mapView.tags.has(t)) mapView.tags.delete(t);
    else mapView.tags.add(t);
  }));
  const clear = menu.querySelector('#map-filter-clear');
  if (clear) stay(clear, () => {
    mapView.lens = 'all';
    mapView.domainId = null;
    mapView.tags.clear();
  });
}

function closeMapFilter() {
  if (!mapView.menuOpen) return false;
  mapView.menuOpen = false;
  renderMapFilter();
  return true;
}

async function refreshMap() {
  const [items, projects, inbox] = await Promise.all([
    fetch('/api/map').then(r => r.json()),
    fetch('/api/projects').then(r => r.json()),
    fetch('/api/inbox').then(r => r.json()),
  ]);
  state.mapItems = items;
  state.projects = projects;
  state.inbox = inbox;
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
    let clickTimer = null;
    span.addEventListener('click', () => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        const item = byId[parseInt(span.closest('.map-row').dataset.id)];
        if (item) openClarifyForItem(item, after);
      }, 220);
    });
    span.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      const row = span.closest('.map-row');
      const id = parseInt(row.dataset.id);
      const item = byId[id];
      if (!item) return;
      row.draggable = false;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 's2-rename-input';
      input.value = item.content;
      span.replaceWith(input);
      input.focus();
      input.select();
      let settled = false;
      const finish = async save => {
        if (settled) return;
        settled = true;
        const content = input.value.trim();
        row.draggable = true;
        if (!save || !content || content === item.content) { await after(); return; }
        await apiSend(`/api/inbox/${id}`, 'PATCH', { content });
        await after();
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        // stopPropagation, or this same keydown also reaches initHub's handler
        // and closes the overlay behind the editor — Esc peels innermost-first.
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
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
  renderMapFilter();
  // Everything below reads the NARROWED set, search included — a search inside
  // "Waiting & deferred" must not turn up an action you are not asking about.
  const items = mapVisibleItems(state.mapItems || [], todayStr);
  // "In" is not a next action, a project or a someday — it is what has not been
  // decided yet. It belongs to the whole inventory and to no lens, so any lens
  // at all puts it away rather than showing it under a heading it contradicts.
  const inboxItems = (mapView.lens === 'all' && mapView.domainId == null && !mapView.tags.size)
    ? (state.inbox || []) : [];
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
  const badge = item => {
    // Badges compose: an item can be waiting AND due — both are worth the
    // scan, which is the bar for badging here.
    let out = item.status === 'waiting' ? '<span class="map-badge map-badge-wait">waiting</span>' : '';
    out += dueChip(item, 'map-badge');
    if (item.defer_until && item.defer_until > todayStr) {
      out += `<span class="map-badge">→ ${escHtml(item.defer_until)}</span>`;
    }
    return out;
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

  // One control per row: the SELECT button, which opens the clarify sheet for
  // that row. A stalled project is simply RED — the old "no next action" badge
  // said in a chip what the colour already says, on the surface built for
  // reading everything at once.
  const rowHtml = item => {
    const isProject = item.kind === 'project';
    const isStalled = isProject && stalled.has(item.id);
    return `<div class="map-row${isProject ? ' map-row-project' : ''}${
        isStalled ? ' map-row-stalled' : ''}" data-id="${item.id}" draggable="true">
      ${chainN[item.id] ? `<span class="cl-chain-n" title="Position in this project's dependency chain">[${chainN[item.id]}]</span>` : ''}
      <span class="map-text" title="Tap to clarify · double-click to rename">${escHtml(item.content)}</span>
      ${ownTags(item).map(t =>
        `<span class="map-badge map-badge-tag">${escHtml(t)}</span>`).join('')}
      ${badge(item)}
      ${item.pushed >= 3 ? `<span class="map-badge map-badge-push" title="Not-today'd ${item.pushed} times — too big, not real, or being avoided">pushed ${item.pushed}x</span>` : ''}
      <span class="map-acts">
        <button class="map-open" data-id="${item.id}"
          title="${isProject ? 'Clarify this project' : 'Clarify this action'}">›</button>
      </span>
    </div>`;
  };

  // domain → area → tree. Area cascades down a subtree in storage, so a parent
  // is always in the same area group as its children.
  const domains = {};
  items.forEach(i => {
    const dk = i.domain_id || 0;
    const ak = i.area_id || 0;
    const d = domains[dk] = domains[dk] || { name: i.domain_name || '—', areas: {} };
    const a = d.areas[ak] = d.areas[ak] || { name: i.area_name || '(no area)', items: [] };
    a.items.push(i);
  });

  // SOMEDAY IS SPLIT OUT (2026-08-10). It used to be interleaved with live
  // work, and since MAP deliberately badges no 'someday' marker, a parked item
  // was indistinguishable from an active one — so reading the tree meant
  // re-deciding the state of every row. Two piles, two levels of rigour.
  //
  // The split is at the ROOT: a subtree goes wherever its root goes. An
  // on_hold PROJECT takes its children with it (they are parked with it), and
  // a parked action under a live project stays inside that project's
  // structure, where its absence from the pool is the project's problem.
  const areaTreeHtml = (areaItems, wantSomeday) => {
    const inView = new Set(areaItems.map(i => i.id));
    const kidsOf = {};
    const roots = [];
    areaItems.forEach(item => {
      const pid = item.project_id && inView.has(item.project_id) ? item.project_id : null;
      if (pid) (kidsOf[pid] = kidsOf[pid] || []).push(item);
      else roots.push(item);
    });
    // No add affordance here any more: MAP is a reading surface, and "give
    // this project a next action" already has a home on GTD's Projects list
    // (the same + that puts the global bar in the project's mode).
    const subtree = item => {
      const kids = mapSortSiblings(kidsOf[item.id] || [], todayStr);
      return rowHtml(item) + (kids.length
        ? `<div class="map-kids">${kids.map(subtree).join('')}</div>` : '');
    };
    const parked = r => r.status === 'on_hold';
    const picked = roots.filter(r => (wantSomeday ? parked(r) : !parked(r)));
    return mapSortSiblings(picked, todayStr).map(subtree).join('');
  };

  const domainKeys = Object.keys(domains).sort((a, b) =>
    domains[a].name.localeCompare(domains[b].name));

  // "In" is not part of the inventory — it is what hasn't been decided yet, so
  // get_map_items excludes it. But MAP is the read-EVERYTHING surface, and an
  // undecided pile you can only reach through the day's Clarify count is a
  // pile you forget you have. It sits at the bottom, below the tree, because
  // the tree is what you came to read.
  const inboxHtml = inboxItems.length ? `
    <div class="map-area-group">
      <div class="map-area-head">In — not yet clarified<span class="map-count">${inboxItems.length}</span></div>
      ${inboxItems.map(i => `<div class="map-row map-row-in" data-id="${i.id}">
        <span class="map-text" title="Tap to clarify · double-click to reword">${escHtml(i.content)}</span>
        <span class="map-acts"><button class="map-open" data-id="${i.id}" title="Clarify this">›</button></span>
      </div>`).join('')}
    </div>` : '';

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
  const sortEl = document.getElementById('map-sort');
  if (sortEl) {
    sortEl.textContent = mapSortOn() ? '⇅ due' : '⇅ tree';
    sortEl.classList.toggle('map-sort-on', mapSortOn());
    sortEl.title = mapSortOn()
      ? 'Due dates first (soonest first), then deferred by how soon they return — click for plain tree order'
      : 'Plain tree order — click to sort by due, then defer';
  }
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
    body.innerHTML = hits.length ? hits.map(({ i }) => {
      const isIn = !i.status || i.status === 'in';
      const isProject = i.kind === 'project';
      return `<div class="map-row map-row-hit${isProject ? ' map-row-project' : ''}${
          isProject && stalled.has(i.id) ? ' map-row-stalled' : ''}${
          isIn && !i.area_id ? ' map-row-in' : ''}" data-id="${i.id}">
        <span class="map-text" title="Tap to clarify · double-click to rename">${escHtml(i.content)}</span>
        ${ownTags(i).map(t =>
          `<span class="map-badge map-badge-tag">${escHtml(t)}</span>`).join('')}
        ${badge(i)}
        <span class="map-crumb">${escHtml(crumb(i)) || 'in'}</span>
        <span class="map-acts">
          <button class="map-open" data-id="${i.id}" title="Clarify this">›</button>
        </span>
      </div>`;
    }).join('') : `<div class="pm-empty">Nothing matches "${escHtml(q)}".</div>`;
    wireMapRows(body, byId);
    return;
  }
  if (countEl) countEl.textContent = '';

  body.innerHTML = (domainKeys.length ? domainKeys.map(dk => {
    const d = domains[dk];
    const areaKeys = Object.keys(d.areas).sort((a, b) => d.areas[a].name.localeCompare(d.areas[b].name));
    const total = areaKeys.reduce((n, ak) => n + d.areas[ak].items.length, 0);
    return `<div class="map-domain">
      <div class="map-domain-head">${escHtml(d.name)}<span class="map-count">${total}</span></div>
      ${areaKeys.map(ak => {
        const live = areaTreeHtml(d.areas[ak].items, false);
        const later = areaTreeHtml(d.areas[ak].items, true);
        const nLive = d.areas[ak].items.filter(i => i.status !== 'on_hold').length;
        const nLater = d.areas[ak].items.length - nLive;
        return `<div class="map-area-group">
        <div class="map-area-head">${escHtml(d.areas[ak].name)}<span class="map-count">${nLive}</span></div>
        ${live}
        ${later ? `<div class="map-someday-head">Someday / maybe<span class="map-count">${nLater}</span></div>${later}` : ''}
      </div>`;
      }).join('')}
    </div>`;
  }).join('') : `<div class="pm-empty">${
    mapLens().key !== 'all' || mapFilterExtras()
      // An empty list under a filter is a fact about the QUESTION, not about
      // the inventory — say which, or it reads as "you have nothing".
      ? `Nothing in the inventory answers “${escHtml(mapLens().name)}”${
          mapFilterExtras() ? ' with those filters' : ''}.`
      : 'Nothing in the inventory yet — capture into the inbox first.'
  }</div>`) + inboxHtml;

  const patchItem = (id, patch) => apiSend(`/api/inbox/${id}`, 'PATCH', patch);
  const after = async () => { await refreshMap(); await refreshActiveItems(); };

  wireMapRows(body, byId);

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
      if (byId[srcId]) undoablePatch(byId[srcId], ['project_id', 'area_id'],
                                     `filed "${byId[srcId].content}"`);
      await patchItem(srcId, { project_id: id });
      await after();
    });
  });

  dragEdgeScroll(body);
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

const SP_DAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const SP_DAY_NAMES = { mo: 'Mon', tu: 'Tue', we: 'Wed', th: 'Thu', fr: 'Fri', sa: 'Sat', su: 'Sun' };
const DAY_PRESETS = [
  ['mo,tu,we,th,fr', 'Mon – Fri'], ['sa,su', 'Weekends'],
  ['mo,tu,we,th,fr,sa,su', 'Every day'],
];

const pickerView = { open: false, uid: null, draft: null, error: null, dayMenu: null };

function blankRule() {
  return {
    uid: null, frequency: 'weekly', interval: 1,
    days: [SP_DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1]],
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
  document.getElementById('sp-sheet').classList.remove('hidden');
  document.getElementById('sp-sheet-backdrop').classList.remove('hidden');
  renderPicker();
}

function closePicker() {
  pickerView.open = false;
  pickerView.draft = null;
  document.getElementById('sp-sheet').classList.add('hidden');
  document.getElementById('sp-sheet-backdrop').classList.add('hidden');
}

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
    .map(d => SP_DAY_NAMES[d]).join(', ');
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
        <span>${SP_DAY_NAMES[d]}</span>${days.includes(d) ? '<span>✓</span>' : ''}</button>`).join('')}
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
        ${spSelect('nthDay', SP_DAYS.map(d => [d, SP_DAY_NAMES[d]]), rule.nthDay, ` data-idx="${idx}"`)}
      </div>`);
    }
  }
  // Week start only matters above interval 1, which is the only time it shows.
  if (!compact && rule.frequency === 'weekly' && Number(rule.interval) > 1) {
    rows.push(`<div class="sp-row">${label('Week starts')}${
      spSelect('firstDayOfWeek', SP_DAYS.map(d => [d, SP_DAY_NAMES[d]]),
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
        : `the ${(NTHS.find(([v]) => String(v) === String(r.nth)) || [])[1]} ${SP_DAY_NAMES[r.nthDay]}`);
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
      note: moved ? `${SP_DAY_NAMES[day]} was removed from rule 1.` : null });
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
  document.getElementById('ctx-sheet').classList.add('hidden');
  document.getElementById('ctx-sheet-backdrop').classList.add('hidden');
}

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
  const back = document.getElementById('ctx-sheet-backdrop');
  if (!sheet) return;
  const tag = ctxSheet.tag;
  if (!tag) { closeCtxSheet(); return; }
  sheet.classList.remove('hidden');
  back.classList.remove('hidden');

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
      ${['pc', 'phone'].map(d => `<button class="cl-chip${dev === d ? ' cl-chip-on' : ''}"
        data-dev="${d}">${d}</button>`).join('')}
      ${boundDev ? '<button class="cl-chip" data-dev="none">✕ any device</button>' : ''}
    </div>

    <div class="cl-sec"><span class="cl-label">⌖ Location</span>
      <span class="cl-hint">${state.geo.ok ? 'located' : 'no fix — nothing is hidden'}</span></div>
    <div class="cl-chips">
      ${(state.locations || []).filter(l => l.active !== 0
        || (boundLoc && boundLoc.location_id === l.id)).map(l => `<button class="cl-chip${
        boundLoc && boundLoc.location_id === l.id ? ' cl-chip-on' : ''}"
        data-loc="${l.id}">${escHtml(l.name)}</button>`).join('')
        || '<span class="cl-hint">no presets — add one in Settings → Locations</span>'}
      ${boundLoc ? '<button class="cl-chip" data-loc="none">✕ anywhere</button>' : ''}
    </div>

    <div class="cl-sec"><span class="cl-label">◷ Time</span></div>
    <div class="cl-chips">
      ${(state.schedules || [])
        .filter(p => p.title || (boundTime && boundTime.source_uid === p.uid))
        .map(p => `<button class="cl-chip${
        boundTime && boundTime.source_uid === p.uid ? ' cl-chip-on' : ''}"
        data-time="${p.uid}" title="${escHtml(p.label || '')}">${
        escHtml(p.title || 'its own hours')}</button>`).join('')
        || '<span class="cl-hint">no schedules — add one in Settings → Times</span>'}
      ${boundTime ? '<button class="cl-chip" data-time="none">✕ any time</button>' : ''}
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
      <button class="cl-chip${dailyOn ? ' cl-chip-on' : ''}" data-daily="on"
        title="The morning routine's contexts step will ask about this tag">ask</button>
      ${dailyOn ? '<button class="cl-chip" data-daily="off">✕ stop asking</button>' : ''}
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
  back.onclick = closeCtxSheet;

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
                     domainId: null, dragId: null,
                     // Context filter (the top-right picker). Keys are
                     // namespaced: 'domain:3' / 'tag:light'. Two tiers:
                     // include = OR (widen), require = AND (narrow).
                     // Empty include set = the block calendar's domain, i.e.
                     // the resting behaviour is exactly what it always was.
                     // Context filter (2026-08-07 model): the DOMAIN axis is
                     // single-select and mutually exclusive — picking one IS
                     // excluding the others, and the UI says so with ¬. Tags
                     // are all conjunctive: every selected tag is required.
                     // Formula: domain ∧ ¬other ∧ ¬other ∧ tag ∧ tag.
                     ctxDomain: null, ctxTags: new Set(), ctxOpen: false,
                     // Is the domain chip expanded into the full list?
                     ctxDomainPick: false,
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
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (clarifyView.open) { peelClarify(); return; }
    if (engageView.routinePop != null) {
      engageView.routinePop = null;
      renderEngage();
    }
  });
  // Tapping off the sheet is the touch Esc — same ladder, innermost first.
  document.getElementById('clarify-backdrop').addEventListener('click', peelClarify);
}

async function openEngage() {
  if (!engageView.domainId) engageView.domainId = state.activeDomainId || defaultDomainId();
  await refreshEngage();
  // No header clock (2026-08-08) and so no tick to drive it. The day is
  // already positioned against now by .eg-past dimming; the device shows the
  // time everywhere else.
}

// The viewed day as YMD; parse at noon so DST shifts can't slide the date.
function egDateStr() { return engageView.date || wallDay(); }
function egViewDate() { return new Date(egDateStr() + 'T12:00:00'); }

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
    // The day's routines, so a gate hairline can name the routine that gates it
    // — the link is what makes the gate pass or fail, and it was only visible
    // inside the step editor.
    apiGet(`/api/flows?date=${dateStr}`, engageView.flows),
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
  engageView.flows = Array.isArray(flows) ? flows : [];
  state.schedules = Array.isArray(schedules) ? schedules : [];
  engageView.deferred = Array.isArray(deferred) ? deferred : [];
  renderEngage();
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
  // A tag is device-bound either by BEING 'pc'/'phone' or by having been bound
  // to one in the ctx sheet — so `email → pc` gates exactly like `#pc` does,
  // without the tag having to be named after the hardware.
  const tagDev = {};
  DEVICE_TAGS.forEach(t => { tagDev[t] = t; });
  (state.tagDevices || []).forEach(b => { tagDev[b.tag] = b.device; });
  const deviceOk = i => {
    const devs = itemTags(i).map(t => tagDev[t]).filter(Boolean);
    return !devs.length || devs.includes(device);
  };

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
      // The routines that GATE this node (qr_node_id = anchored to its
      // deadline, before_node_id = must be done before it). The link decides
      // whether the gate judges ✓ or ✗, so the hairline says which routine it is
      // waiting on rather than leaving that buried in the step editor.
      // ONLY the routines ATTACHED to this node (qr_node_id) — not the ones
      // that merely reference it as a deadline (before_node_id). The
      // difference is real, not cosmetic: `_push_routine_config` flags only
      // the qr_node_id node on the Worker, so a before_node_id routine gates
      // NOTHING here. Listing it under this hairline claimed a consequence
      // that does not exist.
      const flows = (engageView.flows || []).filter(fl => fl.qr_node_id === n.id);
      rows.push({ kind: 'qr', minute, label: n.label, outcome });
      // Each gating routine is its OWN row directly under the hairline, not a
      // chip crowded onto it — "Morning routine" is a thing you do, and it
      // reads as one when it has a line of its own. SAME minute as the gate:
      // the sort is stable and gates are pushed first, so the pair stays
      // adjacent whatever else lands at that minute.
      flows.forEach(fl => rows.push({
        kind: 'flow', minute, flowId: fl.id, label: fl.name,
        done: !!(fl.run && fl.run.completed_at),
      }));
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
    const seg = { minute: s.start, endMin: s.end, id: s.block_id,
                  label: s.label, cancelled: !!s.cancelled };
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
                  cancelled: b.cancelled, blocks });
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
  state.gcalEvents.filter(e => !e.allday && sameDay(viewDate, e.start)
      && !state.tlHidden.event[`${e.uid}|${e.start}`]).forEach(e => {
    rows.push({ kind: 'event', minute: isoMin(e.start), endMin: isoMin(e.end),
                label: e.summary || 'Event', ekey: `${e.uid}|${e.start}`,
                color: e.color });
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
                started: !!item.started_at, flow_id: item.flow_id || null });
  });

  rows.sort((a, b) => a.minute - b.minute || (a.kind === 'action') - (b.kind === 'action'));

  return { rows, qrMinutes, routineAreaIds, routineGroups, itemById, placedIds };
}

function renderEngage() {
  const header = document.getElementById('engage-header');
  const body = document.getElementById('engage-body');
  if (!header || !body) return;

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
  const isoMin = iso => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };

  const { rows, qrMinutes, routineAreaIds, routineGroups, itemById, placedIds } =
    engageDayRows(now, dateStr, viewDate, isToday, isoMin);

  // Context filter. There are TWO AXES and they do not compose the same way:
  // a domain is WHERE the work belongs (single-valued — area.domain_id), a tag
  // is WHAT KIND of work it is (many per item). So:
  //   · within an axis, include is OR
  //   · across the two axes, AND
  //   · require (AND) exists for tags only — see the chip cycle below
  //   · an empty domain axis falls back to the block calendar's domain, so
  //     picking a tag NARROWS the resting context instead of escaping it
  // A flat OR over both axes made "School + deep" mean "School OR deep", which
  // dragged in deep work from every other domain, and a tag-only selection
  // dropped the domain scope entirely rather than filtering inside it.
  const domainOf = i => i.domain_id || domainIdForArea(i.area_id);
  // ONE domain is always in force — the explicit selection, or the block
  // calendar's. Being in it is being NOT in every other; the pool predicate
  // is exactly the formula the button shows: domain ∧ ¬others ∧ tag ∧ tag.
  const ctxDomainId = engageView.ctxDomain != null ? engageView.ctxDomain : engageView.domainId;
  const inContext = i => String(domainOf(i)) === String(ctxDomainId)
    && [...engageView.ctxTags].every(t => itemTags(i).includes(t));

  const { locOk, deviceOk, timeOk, dayOk, device,
          tagLoc, tagDev, tagTime, gateOn } = engagePoolGates(nowMin, isToday);

  // Scheduled on/after the viewed day = it HAS a day, so it isn't "Not
  // scheduled" on this one. A placement whose day has passed is not in this
  // set (the server query is date >= viewed), so an unfinished item quietly
  // returns to the pool instead of being scheduled-in-the-past forever.
  const scheduledIds = new Set(engageView.futurePlaced.map(p => p.item_id));
  const poolBase = engageView.pool
    .filter(i => (i.kind || 'item') === 'item' && !placedIds.has(i.id)
                 && !scheduledIds.has(i.id)
                 && !routineAreaIds.has(i.area_id) && inContext(i));
  // The four HIDDEN-BY-CONTEXT tallies used to be counted here and printed
  // above the list ("4 out of window", "6 not today"). Removed 2026-08-17 at
  // Quentin's request: it was a band of chrome over the one list read dozens
  // of times a day, saying what is NOT there. The gates themselves are
  // unchanged — the pool still hides those rows, and the context pills in the
  // header are still where you see and change what is gating.
  const pool = poolBase
    .filter(i => locOk(i) && deviceOk(i) && timeOk(i) && dayOk(i))
    // In-progress floats first — "what am I on" is the glance the ◐ exists
    // for — then BY DUE DATE (2026-08-07: deadlines sort the pool; no
    // deadline sorts last), then oldest-first as always.
    .sort((a, b) => (!!b.started_at - !!a.started_at)
      || (dueOf(a) || '9999').localeCompare(dueOf(b) || '9999')
      || (a.captured_at || '').localeCompare(b.captured_at || '') || a.id - b.id);

  // WHAT COMES BACK ON THIS DAY. A deferred item vanishes from every surface
  // until its date, which is the point — but it also means walking forward to
  // plan a day showed you nothing of what you had already sent there. Only on
  // a FUTURE day: on today these are already in the pool (defer_until <=
  // today is what "available" means), so a section here would be a duplicate.
  const returning = isToday ? []
    : (engageView.deferred || []).filter(i => i.defer_until === dateStr);
  const deferHtml = returning.length ? `
    <div class="eg-pool-head">Returning this day<span class="map-count">${returning.length}</span></div>
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
      return `<div class="eg-qr${r.outcome ? ` eg-qr-${r.outcome}` : ''}">
        <span class="eg-time">${hhmm(r.minute)}</span>
        <span class="eg-qr-label">${escHtml(r.label.toUpperCase())}</span>
        <span class="eg-qr-rule"></span>
        ${r.outcome === 'success' ? '<span class="eg-qr-tick">✓</span>' : ''}
      </div>`;
    }
    if (r.kind === 'flow') {
      // The routine that GATES the gate above, on its own line: name on the
      // left like any other row, ▶ to run it, ✓ once today's run completed.
      // The link is what decides whether that gate judges ✓ or ✗, so it belongs
      // on the day rather than only inside the step editor.
      return `<div class="eg-row eg-flow-row${r.done ? ' eg-flow-done' : ''}">
        <span class="eg-time"></span>
        <span class="eg-text">${escHtml(r.label)}</span>
        <button class="eg-qr-flow${r.done ? ' eg-qr-flow-done' : ''}" data-flow="${r.flowId}"
          title="${r.done ? 'Completed today' : 'Run this routine'} — the gate above judges ✗ unless this completes">${
          r.done ? '✓ done' : playMark(9) + ' run'}</button>
      </div>`;
    }
    if (r.kind === 'block') {
      return `<div class="eg-row eg-block${r.cancelled ? ' eg-cancelled' : ''}${r.endMin <= nowMin ? ' eg-past' : ''}${isNow(r) ? ' eg-now' : ''}"${nowAttrs(r)}
        data-block="${r.id}" title="${r.cancelled ? '⌘-click to restore' : '⌘-click to cancel for this day'}">
        <span class="eg-time">${hhmm(r.minute)}</span>
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
        <span class="eg-text">${escHtml(r.label)}</span>
        <button class="eg-routine-btn${engageView.routinePop === r.areaId ? ' eg-routine-btn-on' : ''}"
          data-area="${r.areaId}" title="Routine details">☰${open ? ` ${open}` : ''}</button>
        ${r.endMin > r.minute ? `<span class="eg-end">${hhmm(r.endMin)}</span>` : ''}
      </div>`;
    }
    if (r.kind === 'event') {
      // The source calendar's pastel rides along as an inset edge (inset
      // box-shadow, so no layout shift) — same identity the timeline shows.
      return `<div class="eg-row eg-event${r.endMin <= nowMin ? ' eg-past' : ''}${isNow(r) ? ' eg-now' : ''}"${nowAttrs(r)}
        data-ekey="${escHtml(r.ekey)}" title="⌘-click / long-press to hide from the day"
        ${r.color ? `style="box-shadow: inset 3px 0 0 ${escHtml(r.color)}"` : ''}>
        <span class="eg-time">${hhmm(r.minute)}</span>
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
        ? 'In progress — tap for done, hold to clear'
        : 'Tap = done · hold = in progress')}
      <span class="eg-text">${escHtml(r.label)}</span>
      <span class="eg-tags">${flowLenChip(r)}</span>
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
    parts.push(`<div class="eg-empty">Nothing fixed ${isToday ? 'today' : 'this day'} — drag an action up from the pool.</div>`);
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

  // Only the domain IN FORCE is shown (2026-08-08). The menu used to render
  // every other domain as a dimmed ¬Name to spell the exclusion out; with
  // more than a couple of domains that was most of the menu saying what
  // mutual exclusivity already guarantees. The domain still comes from the
  // block calendar, and tapping the chip returns to that resting scope.
  // Tags are two-state: off, or required (∧).
  const domainChip = d => {
    const inForce = String(d.id) === String(ctxDomainId);
    const isBase = inForce && engageView.ctxDomain == null;
    const title = isBase ? "the block calendar's domain — tap to choose another"
      : 'the domain in force — tap to choose another';
    return `<button class="ctx-chip ${isBase ? 'ctx-base' : 'ctx-req'}"
      data-ctx="domain:${d.id}" title="${title}"
      >${escHtml(d.name)}${engageView.ctxDomainPick ? '' : ' ▾'}</button>`;
  };
  // Expanded: every domain, plus the way back to letting the calendar decide.
  // A paused domain is not offered — unless it is the one in force, which the
  // block calendar can still derive and the chip must be able to name.
  const domainPicker = () => `${state.domains.filter(d =>
      d.active !== 0 || String(d.id) === String(ctxDomainId)).map(d => {
      const inForce = String(d.id) === String(ctxDomainId);
      return `<button class="ctx-chip ${inForce ? 'ctx-req' : 'ctx-off'}"
        data-pickdomain="${d.id}">${escHtml(d.name)}</button>`;
    }).join('')}${engageView.ctxDomain != null
      ? '<button class="ctx-chip" data-pickdomain="base" title="Follow the block calendar again">⟳ follow the day</button>'
      : ''}`;
  const tagChip = t => {
    const on = engageView.ctxTags.has(t);
    // Markers STACK — a tag can be gated on all three axes at once, and the
    // chip has to say so or the pool hides things for invisible reasons.
    const marks = [];
    const why = [];
    const d = tagDev[t];
    if (d) { marks.push('▭'); why.push(`only on the ${d}`); }
    if (tagLoc[t]) { marks.push('⌖'); why.push(`only at ${tagLoc[t].name}`); }
    if (tagTime[t]) { marks.push('◷'); why.push(`only ${tagTime[t].label || 'in its window'}`); }
    return `<button class="ctx-chip ${on ? 'ctx-req' : 'ctx-off'}" data-ctx="tag:${t}"
      title="${on ? 'required — click to clear' : 'click to require'}${
        why.length ? ' · ' + escHtml(why.join(' · ')) : ''} · right-click / long-press to configure"
      >${on ? '∧' : ''}${escHtml(t)}${marks.join('')}</button>`;
  };
  const poolTags = [...new Set(engageView.pool.flatMap(itemTags))].sort();
  const ctxCount = (engageView.ctxDomain != null ? 1 : 0) + engageView.ctxTags.size;
  const domainName = id =>
    (state.domains.find(d => String(d.id) === String(id)) || {}).name || 'contexts';
  // The button names the domain in force and the required tags. The ¬ terms
  // for every other domain went with the chips (2026-08-08): with more than
  // two domains the label was mostly exclusions, and it grew with each domain
  // added — on a header that has to fit a phone.
  // EVERY term is named (2026-08-12). The label was capped at two tags plus
  // "+3", which is the one thing this button must not do: it is the receipt for
  // the items the pool is hiding, and "+3" does not say which three. It wraps
  // onto as many lines as it needs and the header grows — see .eg-domain.
  const tagTerms = [...engageView.ctxTags];
  const ctxLabel = [domainName(ctxDomainId), ...tagTerms].join(' ∧ ');

  // 9c header: NOW-panel button top-left, the day as the title, domain chip.
  header.innerHTML = `
    <button id="eg-panel-btn" title="${window.pywebview && state.settings.panel_hidden === '1'
      ? 'NOW panel — off' : 'NOW panel'}">
      ${panelEyeSvg(!!window.pywebview && state.settings.panel_hidden === '1')}
    </button>
    <button class="eg-nav" id="eg-prev" title="Previous day">‹</button>
    <button class="eg-day-btn${isToday ? '' : ' eg-day-off'}" id="eg-day-btn"
      title="Open this day in calendar view">
      <span class="eg-day-name">${viewDate.toLocaleDateString('en-US', { weekday: 'long' })}</span>
      <span class="eg-day-date">${viewDate.getDate()} ${viewDate.toLocaleDateString('en-US', { month: 'short' })}</span>
    </button>
    <button class="eg-nav" id="eg-next" title="Next day">›</button>
    ${isToday ? '' : '<button id="eg-today" title="Back to today">today</button>'}
    <span class="eg-spacer"></span>
    <button class="eg-domain" id="eg-ctx-btn" title="Contexts — the domain in force, and every selected tag required">${escHtml(ctxLabel)} ▾</button>
    ${engageView.ctxOpen ? `<div id="eg-ctx-menu">
      <div class="ctx-group">Domain${engageView.ctxDomainPick ? ' — pick one' : ' — in force'}</div>
      <div class="ctx-chips">${engageView.ctxDomainPick ? domainPicker()
        : state.domains.filter(d => String(d.id) === String(ctxDomainId))
            .map(domainChip).join('')}</div>
      ${poolTags.length ? `<div class="ctx-group">Tags — every selected one required</div>
      <div class="ctx-chips">${poolTags.map(tagChip).join('')}</div>` : ''}
      <div class="ctx-foot">
        <span class="ctx-legend"><b>∧</b> required</span>
        <span class="ctx-legend">${state.geo.ok ? '⌖ located'
          : '⌖ no fix'}</span>
        <button id="eg-dev-swap" title="This device — ${detectDevice()} detected. #pc / #phone items only show on their own device; click to correct it.">▭ ${device}${device === detectDevice() ? '' : ' ✎'}</button>
        <button id="eg-time-gate" class="${gateOn ? '' : 'ctx-gate-off'}"
          title="${gateOn
            ? 'Time-bound contexts are hidden outside their window — click to show them anyway'
            : 'OFF — time-bound contexts are showing whatever the clock says'}">◷ ${
          gateOn ? 'on' : 'off'}</button>
        ${state.geo.ok ? '' : '<button id="eg-geo-enable" title="Request location — location-bound tags need a fix">enable</button>'}
        ${ctxCount ? '<button id="eg-ctx-clear">clear</button>' : ''}
      </div>
    </div>` : ''}
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
        }).join('') || '<div class="eg-empty">No checklist yet — add the first line below.</div>'}
      </div>
      <input type="text" class="eg-rt-add" placeholder="+ add to the routine…" autocomplete="off">
    </div>`;
  }

  body.innerHTML = `
    <div class="eg-day">${parts.join('')}</div>
    ${deferHtml}
    <div class="eg-pool">
      ${pool.map(i => `
        <div class="eg-row eg-pool-item${i.started_at ? ' eg-inprog' : ''}" draggable="true" data-id="${i.id}">
          ${egRowControl(i, i.started_at, 'Done')}
          <span class="eg-text">${escHtml(i.content)}</span>
          <span class="eg-tags">${flowLenChip(i)}${itemTags(i).filter(t => EST_TAGS.includes(t))
            .map(t => `<span class="eg-tag">${escHtml(t)}</span>`).join('')}${dueChip(i, 'eg-tag')}${
            itemTags(i).filter(t => !EST_TAGS.includes(t))
            .map(t => `<span class="eg-tag">${escHtml(t)}</span>`).join('')}</span>
        </div>`).join('') || '<div class="eg-empty">Nothing available — done, parked, or handed off.</div>'}
    </div>
    ${popHtml}
  `;

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
    renderSheetsInbox();
  });
  const todayBtn = header.querySelector('#eg-today');
  if (todayBtn) todayBtn.addEventListener('click', () => {
    engageView.date = null;
    refreshEngage();
  });

  header.querySelector('#eg-panel-btn').addEventListener('click', async () => {
    // PC: toggles the evergreen pywebview panel. Phone (no pywebview): the
    // same active section, full-screened.
    if (window.pywebview) {
      await togglePanel();
    } else {
      openM('now-full');
      renderNowFull();
    }
  });
  header.querySelector('#eg-ctx-btn').addEventListener('click', () => {
    engageView.ctxOpen = !engageView.ctxOpen;
    engageView.ctxDomainPick = false;
    renderEngage();
  });
  // Right-click / long-press a TAG chip binds it to a location preset — the
  // popover renders inside the menu; a plain click still toggles required.
  // Device tags are skipped: they are already a gate, and the hardware is the
  // context, so a geofence on top of one would be two answers to one question.
  header.querySelectorAll('.ctx-chip[data-ctx^="tag:"]').forEach(b => {
    const openBind = () => {
      // Every tag gets the sheet now, device tags included — `pc` can still be
      // given a location or a time window like any other context.
      openCtxSheet(b.dataset.ctx.slice(4));
    };
    b.addEventListener('contextmenu', e => { e.preventDefault(); openBind(); });
    onLongPress(b, openBind);
  });
  // Domains single-select (mutually exclusive — picking one IS excluding the
  // rest; clicking the one in force returns to the resting scope). Tags
  // toggle required ↔ off; there is no OR tier.
  header.querySelectorAll('.ctx-chip').forEach(b => {
    b.addEventListener('click', () => {
      const k = b.dataset.ctx;
      if (!k) return;   // the binding popover's chips carry data-bindloc instead
      if (k.startsWith('domain:')) {
        engageView.ctxDomainPick = true;
      } else {
        const t = k.slice(4);
        if (engageView.ctxTags.has(t)) engageView.ctxTags.delete(t);
        else engageView.ctxTags.add(t);
      }
      renderEngage();
    });
  });
  header.querySelectorAll('[data-pickdomain]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.pickdomain;
    engageView.ctxDomain = v === 'base' ? null : v;
    engageView.ctxDomainPick = false;
    renderEngage();
  }));

  const ctxClear = header.querySelector('#eg-ctx-clear');
  if (ctxClear) ctxClear.addEventListener('click', () => {
    engageView.ctxDomain = null;
    engageView.ctxTags.clear();
    renderEngage();
  });
  // The device override. Detection has no fail-open state to fall back on, so
  // this is the escape hatch: a wrong guess would hide real work silently, and
  // silent is the one thing the pool may never be.
  const gateBtn = header.querySelector('#eg-time-gate');
  if (gateBtn) gateBtn.addEventListener('click', () => {
    if (timeGateOn()) localStorage.setItem('timeGate', 'off');
    else localStorage.removeItem('timeGate');   // absent = on, so ON is the default state
    renderEngage();
  });

  const devBtn = header.querySelector('#eg-dev-swap');
  if (devBtn) devBtn.addEventListener('click', () => {
    const next = currentDevice() === 'pc' ? 'phone' : 'pc';
    // Clearing rather than storing when the flip lands back on the detected
    // value keeps ✎ meaning "I disagreed", not "I clicked twice".
    if (next === detectDevice()) localStorage.removeItem('device');
    else localStorage.setItem('device', next);
    renderEngage();
  });

  // Gesture-initiated location request — the path that actually makes iOS
  // show the permission prompt when the load-time watch silently failed.
  const geoBtn = header.querySelector('#eg-geo-enable');
  if (geoBtn) geoBtn.addEventListener('click', () => {
    initGeo();
    toast('Requesting location…');
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
  const startedToggle = async id => {
    const item = [...engageView.pool, ...engageView.allItems].find(i => i.id === id);
    if (!item) return;
    undoablePatch(item, ['started_at'], item.started_at
      ? `cleared in-progress on "${item.content}"`
      : `marked "${item.content}" in progress`);
    await patchInboxItem(id, { started_at: item.started_at ? null : new Date().toISOString() });
    await after();
  };
  body.querySelectorAll('.eg-pool-item[data-id], .eg-action[data-id]').forEach(row => {
    const id = parseInt(row.dataset.id);
    onLongPress(row, () => startedToggle(id));
    row.addEventListener('contextmenu', e => { e.preventDefault(); startedToggle(id); });
  });

  // The checkbox now does ONE thing, which is what a checkbox should do.
  body.querySelectorAll('.eg-check[data-id]').forEach(el => {
    const id = parseInt(el.dataset.id);
    el.addEventListener('click', async () => {
      // HOLDING the box is "in progress" (the row's long press, which this sits
      // inside). The click the browser synthesizes after that hold must not
      // also complete the item — see justLongPressed.
      if (justLongPressed()) return;
      const item = [...engageView.pool, ...engageView.allItems].find(i => i.id === id);
      await undoableDelete(id, `completed "${(item && item.content) || 'action'}"`);
      await after();
    });
  });

  // The pool's per-row exit glyphs are gone (2026-08): a pool row is text and
  // a checkbox now, and push/waiting/someday are taken in the clarify sheet.

  // ▶ in place of the tick, on a row a ROUTINE seeded. It runs the routine
  // rather than completing the action, because completing it directly would
  // retire the seed with the routine never run — the exact hole flow_task_seed
  // exists to close. The run retires it by itself. stopPropagation because the
  // row is draggable and opens clarify on click, and justLongPressed for the
  // same reason .eg-check checks it: this sits inside the row's long press.
  body.querySelectorAll('.eg-run[data-run]').forEach(el => {
    el.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      if (justLongPressed()) return;
      await openFlowRun(parseInt(el.dataset.run));
    });
  });

  body.querySelectorAll('.eg-routine-btn').forEach(el => {
    el.addEventListener('click', () => {
      const key = parseInt(el.dataset.area);
      engageView.routinePop = engageView.routinePop === key ? null : key;
      renderEngage();
    });
  });
  // A gating routine on a gate hairline runs straight from the day. The runner
  // needs refView.flows populated (it reads its own fetch, but the editor
  // behind it doesn't exist here) — openFlowRun refetches, so this is safe
  // from Engage with Lists never opened.
  body.querySelectorAll('.eg-qr-flow').forEach(el => {
    el.addEventListener('click', () => openFlowRun(parseInt(el.dataset.flow)));
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
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 's2-rename-input';
        input.value = item.content;
        span.replaceWith(input);
        input.focus();
        input.select();
        let settled = false;
        const finish = async save => {
          if (settled) return;
          settled = true;
          const content = input.value.trim();
          if (!save || !content || content === item.content) { renderEngage(); return; }
          await apiSend(`/api/routine-items/${id}`, 'PATCH', { content });
          await refreshEngage();
        };
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
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
  const egToggleBlockCancel = async blockId => {
    const existing = engageView.overrides.find(o => o.block_id === blockId && o.date === dateStr);
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
    await refreshEngage();
  };

  body.querySelectorAll('.eg-block[data-block]').forEach(el => {
    el.addEventListener('click', e => {
      if (!(e.metaKey || e.ctrlKey)) return;
      egToggleBlockCancel(parseInt(el.dataset.block));
    });
    onLongPress(el, () => egToggleBlockCancel(parseInt(el.dataset.block)));
  });
  body.querySelectorAll('.eg-event[data-ekey]').forEach(el => {
    const hide = () => hideTimelineItem('event', el.dataset.ekey,
      el.querySelector('.eg-text')?.textContent);
    el.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey) { hide(); return; }
      // A plain tap opens the event's OCCASION — the actions this kind of event
      // always brings with it. ⌘-click and the long press still hide, and
      // onLongPress swallows the click a fired hold would otherwise send here.
      openOccasionSheet(el.querySelector('.eg-text')?.textContent || '');
    });
    onLongPress(el, hide);
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
    row.addEventListener('click', e => {
      if (!e.target.classList.contains('eg-text')) return;
      // Same race as the checkbox: a long press on the row re-renders, taking
      // its own click guard with it, and the synthesized click would then open
      // clarify on top of the ◐ you just set.
      if (justLongPressed()) return;
      const id = parseInt(row.dataset.id);
      const item = [...engageView.pool, ...engageView.allItems].find(i => i.id === id);
      if (item) openClarifyForItem(item, after);
    });
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
  if (!day) { body.innerHTML = '<div class="gtd-empty">Could not load the day.</div>'; return; }
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
  projectId: null, projectName: '', who: '', chase: '',
  notes: '',          // support material, saved with the item on file
  due: '',            // hard deadline (YMD) — real ones only; '' = none
  refOpen: false,     // the Reference exit's list picker (R toggles)
  refLists: [],       // loaded with the sheet's other vocab
  projNotesOpen: false, // the chosen PROJECT's notes editor (✎ by the pill)
  areaId: null,       // explicit filing target; null = the block calendar's
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
  clarifyView.queue = [...state.inbox].sort((a, b) =>
    (a.captured_at || '').localeCompare(b.captured_at || '') || a.id - b.id);
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
  const defArea = (state.areas || []).find(a => a.is_default && a.active && a.type === 'standard');
  clarifyView.forRecurring = {
    id: task ? task.id : null,
    interval: task ? (task.interval || 12) : 12,
    anchor: task ? task.anchor_date : recNextAnchor(),
    dueMd: task ? (task.deadline_md || '') : '',
    active: task ? !!task.active : true,
  };
  clarifyView.action = task ? task.name : '';
  clarifyView.notes = task ? (task.notes || '') : '';
  clarifyView.areaId = (task && task.area_id) || (defArea ? defArea.id : null);
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
  if (!clarifyView.areaId) { toast('Pick an area to file it under'); return; }
  if (!rec.anchor) { toast('Say when the first one starts'); return; }
  const body = {
    name, area_id: clarifyView.areaId, kind: 'monthly_date',
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
  filedDomain: 'day',    // the domain the last filing actually landed in
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

function lastFiledDomain() {
  return stickyUse('filedDomain');
}

function rememberFiledDomain(areaId) {
  if (!areaId) return;
  stickyRemember('filedDomain', domainIdForArea(areaId));
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

// The area to land on for a given domain: its default, else its first.
function defaultAreaForDomain(did) {
  const areas = state.areas.filter(a => a.active && a.type === 'standard'
                                        && domainIdForArea(a.id) === did);
  return (areas.find(a => a.is_default) || areas[0] || {}).id || null;
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
  // An item that already has an area keeps it. Only a fresh capture — which
  // has none — takes the remembered domain.
  clarifyView.areaId = item ? item.area_id : null;
  if (!clarifyView.areaId) {
    const did = lastFiledDomain();
    if (did != null) clarifyView.areaId = defaultAreaForDomain(did);
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
  clarifyView.open = false;
  clarifyView.single = false;
  clarifyView.external = false;
  clarifyView.forProject = null;
  clarifyView.forOccasion = null;
  clarifyView.forRecurring = null;
  clarifyView.after = null;
  document.getElementById('clarify-sheet').classList.add('hidden');
  document.getElementById('clarify-backdrop').classList.add('hidden');
  document.getElementById('engage-body').classList.remove('eg-dimmed');
  renderInbox();
  if (after) after();
}

async function fileClarify(bucket, refListId) {
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
  if (clarifyView.external) { await fileClarifyExternal(bucket, refListId); return; }
  const startNow = bucket === 'do' && clarifyView.doVariant === 'progress';
  if (startNow) { clarifyView.showDate = ''; clarifyView.showTime = ''; bucket = 'defer'; }
  const item = clarifyView.queue[0];
  if (!item) { closeClarify(); return; }
  if (bucket === 'delegate' && !clarifyView.who.trim()) return;
  if (bucket === 'reference' && !refListId) return;
  // Read before clarifyResetItem clears it — the post-file composer hook
  // below needs to know where this action landed.
  const filedProjectId = (bucket !== 'trash' && bucket !== 'reference')
    ? clarifyView.projectId : null;
  clarifyView.filing = true;
  paintClarifyBusy(true);
  let refCreated = null;
  try {
    // Filing is one-way by GTD design, but a misfile should still be
    // recoverable: snapshot the item exactly as it sat in "in".
    const snap = await snapshotItem(item.id);
    const patch = body => apiSend(`/api/inbox/${item.id}`, 'PATCH', body);
    const content = clarifyView.action.trim() || item.content;
    // The design has no area control: the block calendar's area is the silent
    // default (same suggestion the old processing table made), a chosen project
    // overrides it server-side, and MAP can re-file later.
    // Filing is what teaches the memory — the area actually written, not the
    // one that happened to be showing.
    const areaId = clarifyView.areaId || item.area_id || state.activeAreaId
      || (state.areas.find(a => a.is_default && a.active && a.type === 'standard') || {}).id;
    rememberFiledDomain(areaId);

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
      refCreated = await apiSend('/api/ref/items', 'POST', { list_id: refListId, content }).then(r => r.json());
      await apiSend(`/api/inbox/${item.id}`, 'DELETE');
    } else if (bucket === 'someday') {
      // No due input on this exit, but the prefilled value rides along so
      // parking a deadlined item never silently drops its deadline.
      await patch({ content, status: 'on_hold', area_id: areaId,
                    notes: clarifyView.notes,
                    deadline: clarifyView.due || null });
    } else if (bucket === 'delegate') {
      await patch({ content, status: 'waiting', area_id: areaId,
                    waiting_on: clarifyView.who.trim(),
                    chase_on: clarifyView.chase || null,
                    notes: clarifyView.notes,
                    deadline: clarifyView.due || null,
                    tags: [...clarifyView.tags].join(' ') });
    } else {
      const body = { content, status: 'active', area_id: areaId,
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
        if (refCreated) await apiSend(`/api/ref/items/${refCreated.id}`, 'DELETE');
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
  const areaId = clarifyView.areaId || state.activeAreaId
    || (state.areas.find(a => a.is_default && a.active && a.type === 'standard') || {}).id;
  const body = {
    content: content || item.content,
    area_id: areaId,
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


// External mode: no source row — YOU hold the item (a sticky note, an email
// thread, a pile of paper). The typed next physical action is the content;
// filing creates the item and then routes it exactly like an inbox row.
// Do now / Trash store nothing: the thing happened (or died) outside the app.
async function fileClarifyExternal(bucket, refListId) {
  const content = clarifyView.action.trim();
  // Same as fileClarify: starting it keeps the item, so it takes the active
  // path rather than the do-now delete.
  const startNow = bucket === 'do' && clarifyView.doVariant === 'progress';
  if (startNow) { clarifyView.showDate = ''; clarifyView.showTime = ''; bucket = 'defer'; }
  if (!content && bucket !== 'trash') return;
  if (bucket === 'delegate' && !clarifyView.who.trim()) return;
  if (bucket === 'reference' && !refListId) return;
  clarifyView.filing = true;
  paintClarifyBusy(true);
  try {
    if (bucket === 'reference') {
      // Straight to the list — reference never touches the action inventory.
      const created = await apiSend('/api/ref/items', 'POST', { list_id: refListId, content }).then(r => r.json());
      pushUndo(`referenced "${content}"`, async () => {
        await apiSend(`/api/ref/items/${created.id}`, 'DELETE');
        await refreshAfterUndo();
      });
    } else if (bucket !== 'trash' && bucket !== 'do') {
      const areaId = clarifyView.areaId || state.activeAreaId
        || (state.areas.find(a => a.is_default && a.active && a.type === 'standard') || {}).id;
      rememberFiledDomain(areaId);   // the external step teaches it too
      const created = await apiSend('/api/inbox', 'POST', { content }).then(r => r.json());
      const patch = body => apiSend(`/api/inbox/${created.id}`, 'PATCH', body);
      if (bucket === 'someday') {
        await patch({ status: 'on_hold', area_id: areaId, notes: clarifyView.notes,
                      deadline: clarifyView.due || null });
      } else if (bucket === 'delegate') {
        await patch({ status: 'waiting', area_id: areaId,
                      waiting_on: clarifyView.who.trim(),
                      chase_on: clarifyView.chase || null,
                      notes: clarifyView.notes,
                      deadline: clarifyView.due || null,
                      tags: [...clarifyView.tags].join(' ') });
      } else {
        const body = { status: 'active', area_id: areaId,
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
  document.getElementById('engage-body').classList.add('eg-dimmed');
  document.getElementById('clarify-backdrop').classList.remove('hidden');
  sheet.classList.remove('hidden');
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
  // "Do now" means two different things and only one of them was buildable:
  // FINISH it (the two-minute rule — filing deletes it) or START it. Starting
  // it is the ACTIVE exit plus a started_at stamp — no new column, no new
  // status — so the item keeps its area, contexts, due, notes and project,
  // stays in the pool and renders ◐. Delegate→waiting was the only other way
  // to say "under way", and that one is person-shaped and leaves the pool.
  const doProgress = verb === 'do' && clarifyView.doVariant === 'progress';
  const doVariantChips = () => `
    <div class="cl-chips">
      <button class="cl-chip${clarifyView.doVariant === 'done' ? ' cl-chip-on' : ''}"
        data-dovar="done" title="Two-minute rule — filing marks it done">finish it now</button>
      <button class="cl-chip${doProgress ? ' cl-chip-on' : ''}"
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
        ${REC_PERIODS.map(p => `<button class="cl-chip${
          rec.interval === p.n ? ' cl-chip-on' : ''}" data-recper="${p.n}">${p.label}</button>`).join('')}
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
      <div class="cl-chips">
        <button class="cl-chip${rec.active ? ' cl-chip-on' : ''}" data-recact="1">Active</button>
        <button class="cl-chip${rec.active ? '' : ' cl-chip-on'}" data-recact="0">Paused</button>
      </div>
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
          `<button class="cl-chip${clarifyView.tags.has(t) ? ' cl-chip-on' : ''}" data-tag="${escHtml(t)}">${escHtml(t)}</button>`).join('')}
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
          `<button class="cl-chip${clarifyView.who === nm ? ' cl-chip-on' : ''}" data-who="${escHtml(nm)}">${escHtml(nm)}</button>`).join('')}
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
      <div class="cl-sec"><span class="cl-label">Contexts</span><span class="cl-hint">${clarifyView.tags.size} selected · pick any</span></div>
      <div class="cl-chips">
        ${clarifyView.tagVocab.map(t =>
          `<button class="cl-chip${clarifyView.tags.has(t) ? ' cl-chip-on' : ''}" data-tag="${escHtml(t)}">${escHtml(t)}</button>`).join('')}
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

  // Where it lands. Domain first (the obligation level you actually think
  // in), then that domain's areas when the choice is ambiguous. Defaults to
  // the block calendar's area, so the common case is still zero taps.
  if ((verb !== 'do' || doProgress) && verb !== 'trash') {
    const areas = state.areas.filter(a => a.active && a.type === 'standard');
    const current = areas.find(a => a.id === clarifyView.areaId)
      || areas.find(a => a.id === (state.activeAreaId || (item && item.area_id))) || areas[0];
    const curDomain = current ? domainIdForArea(current.id) : defaultDomainId();
    const siblings = areas.filter(a => domainIdForArea(a.id) === curDomain);
    middle += `
      <div class="cl-sec"><span class="cl-label">Filing to</span>
        <span class="cl-hint">domain${siblings.length > 1 ? ' · area' : ''}</span></div>
      <div class="cl-chips">
        ${state.domains.filter(d => d.active !== 0 || d.id === curDomain)
          .map(d => `<button class="cl-chip${d.id === curDomain ? ' cl-chip-on' : ''}"
           data-domain="${d.id}">${escHtml(d.name)}</button>`).join('')}
      </div>
      ${siblings.length > 1 ? `<div class="cl-chips">
        ${siblings.map(a => `<button class="cl-chip${current && a.id === current.id ? ' cl-chip-on' : ''}"
           data-area="${a.id}">${escHtml(a.name)}</button>`).join('')}
      </div>` : ''}`;
  }

  const next = clarifyView.queue[1];
  const ext = clarifyView.external;
  // Support material rides along on every keep-it exit; do/trash discard it.
  const notesHtml = (verb === 'do' && !doProgress) || verb === 'trash' ? '' : `
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
    ${item && item.flow_id ? `<div class="cl-row">
      <button class="cl-pill cl-pill-on" id="cl-run-flow">${playMark()} Run it</button>
      <span class="cl-hint">this action is a routine — running it is how it gets done</span>
    </div>` : ''}
    ${isProj && !rec ? `<div class="cl-row">
      <button class="cl-pill" id="cl-self-add">+ next action</button>
      ${acts >= 2 ? '<button class="cl-pill" id="cl-self-chain">⛓ order them</button>' : ''}
    </div>` : ''}
    <div class="cl-sec"><span class="cl-q">${isProj
      ? "What's the outcome?" : "What's the next physical action?"}</span></div>
    <div class="cl-action-wrap"><input type="text" id="cl-action" class="cl-action" value="${escHtml(clarifyView.action)}" autocomplete="off"${ext ? ' placeholder="e.g. Reply to Sam about the venue"' : ''}></div>
    ${tpl || rec ? '' : `<div class="cl-verbs">${isProj
      ? `${verbBtn('active', 'Active', 'A')}${verbBtn('defer', 'Defer', 'F')}${verbBtn('trash', 'Trash', '⌫')}`
      : `${verbBtn('do', 'Do now', 'D')}${verbBtn('delegate', 'Delegate', 'G')}${verbBtn('defer', 'Defer', 'F')}`}</div>`}
    ${middle}
    ${notesHtml}
    ${tpl || rec ? '' : `<div class="cl-row cl-or">
      <span class="cl-label">Or</span>
      ${ext || isProj ? '' : `<button class="cl-pill" id="cl-trash">Trash <span class="cl-key">⌫</span></button>`}
      <button class="cl-pill" id="cl-someday">Someday <span class="cl-key">S</span></button>
      <button class="cl-pill${clarifyView.refOpen ? ' cl-pill-on' : ''}" id="cl-reference">Reference <span class="cl-key">R</span></button>
    </div>`}
    ${clarifyView.refOpen && !tpl && !rec ? `<div class="cl-chips cl-ref-row">
      ${clarifyView.refLists.map(l => `<button class="cl-chip" data-reflist="${l.id}">${escHtml(l.name)}</button>`).join('')}
      <input type="text" id="cl-ref-new" class="cl-chip-input" placeholder="+ new list">
    </div>` : ''}
    <div class="cl-foot">
      <span class="cl-then">${rec ? `First one ${escHtml(rec.anchor || '—')}`
        : tpl ? `Every ${escHtml(clarifyView.forOccasion.name)}`
        : ext ? 'Repeat until your head is empty'
        : next ? `Then: ${escHtml(next.content)}`
        : clarifyView.single ? 'Then: back to the day' : 'Then: anything outside the app'}</span>
      ${tpl && item ? '<button id="cl-occ-del" class="cl-pill oc-del">Delete</button>' : ''}
      ${rec && rec.id ? '<button id="cl-rec-del" class="cl-pill oc-del">Delete</button>' : ''}
      ${ext && !tpl ? '<button id="cl-ext-done" class="cl-pill">Done</button>' : ''}
      <button id="cl-file">${rec ? (rec.id ? 'Save ⏎' : 'Add it ⏎')
        : tpl ? (item ? 'Save ⏎' : 'Add it ⏎') : ext ? 'Add it ⏎' : 'File it ⏎'}</button>
    </div>`;

  sheet.querySelectorAll('[data-dovar]').forEach(b => b.addEventListener('click', () => {
    clarifyView.doVariant = b.dataset.dovar;
    renderClarify();
  }));
  sheet.querySelectorAll('.cl-verb').forEach(b => b.addEventListener('click', () => {
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
  sheet.querySelectorAll('.cl-chip[data-tag]').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.tag;
    if (clarifyView.tags.has(t)) clarifyView.tags.delete(t);
    else {
      // Estimates are exclusive: picking one duration unpicks the others.
      if (EST_TAGS.includes(t)) EST_TAGS.forEach(e => clarifyView.tags.delete(e));
      clarifyView.tags.add(t);
    }
    renderClarify();
  }));
  sheet.querySelectorAll('.cl-chip[data-who]').forEach(b => b.addEventListener('click', () => {
    clarifyView.who = clarifyView.who === b.dataset.who ? '' : b.dataset.who;
    renderClarify();
  }));
  sheet.querySelectorAll('.cl-chip[data-domain]').forEach(b => {
    b.addEventListener('click', () => {
      // Land on that domain's default area; the area row refines it.
      clarifyView.areaId = defaultAreaForDomain(parseInt(b.dataset.domain));
      renderClarify();
    });
  });
  sheet.querySelectorAll('.cl-chip[data-area]').forEach(b => {
    b.addEventListener('click', () => {
      clarifyView.areaId = parseInt(b.dataset.area);
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
    if (e.target.value && !clarifyView.showDate) clarifyView.showDate = wallDay();
    renderClarify();  // date autofill + the clear ✕ appearing/going
  });
  const showTimeX = sheet.querySelector('#cl-show-time-x');
  if (showTimeX) showTimeX.addEventListener('click', () => {
    clarifyView.showTime = '';
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

  // The seeded action's door back into the routine that made it. Closing the
  // sheet first: the runner is its own full-screen surface and must not open
  // underneath a clarify sheet still sitting over the day.
  const runFlow = sheet.querySelector('#cl-run-flow');
  if (runFlow) runFlow.addEventListener('click', async () => {
    const fid = item.flow_id;
    closeClarify();
    await openFlowRun(fid);
  });

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
  const someday = sheet.querySelector('#cl-someday');
  if (someday) someday.addEventListener('click', () => fileClarify('someday'));
  // Reference: the OTHER non-actionable keep. The pill reveals the list
  // chips; tapping a chip files immediately (exits are one gesture), and the
  // + input creates the list and files into it in the same stroke.
  const reference = sheet.querySelector('#cl-reference');
  if (reference) reference.addEventListener('click', () => {
    clarifyView.refOpen = !clarifyView.refOpen;
    renderClarify();
  });
  const occDel = sheet.querySelector('#cl-occ-del');
  if (occDel) occDel.addEventListener('click', async () => {
    await apiSend(`/api/occasions/items/${item.id}`, 'DELETE');
    const back = clarifyView.after;
    closeClarify();
    if (back) back();
  });
  sheet.querySelectorAll('.cl-chip[data-reflist]').forEach(b => b.addEventListener('click', () => {
    fileClarify('reference', parseInt(b.dataset.reflist));
  }));
  const refNew = sheet.querySelector('#cl-ref-new');
  if (refNew) refNew.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.stopPropagation();
    const name = refNew.value.trim();
    if (!name) return;
    const nl = await apiSend('/api/ref/lists', 'POST', { name }).then(r => r.json());
    clarifyView.refLists.push(nl);
    fileClarify('reference', nl.id);
  });
  sheet.querySelector('#cl-file').addEventListener('click', () => fileClarify(clarifyView.verb));
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
    if (p.area_id) clarifyView.areaId = p.area_id;
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
  const areaId = clarifyView.areaId || state.activeAreaId
    || (state.areas.find(a => a.is_default && a.active && a.type === 'standard') || {}).id;
  const p = await apiSend('/api/projects', 'POST', { content: name, area_id: areaId }).then(r => r.json());
  state.projects = await fetch('/api/projects').then(r => r.json());
  recentBump('project', p.id);
  clarifyView.projectId = p.id;
  clarifyView.projectName = p.content;
  clarifyView.projSearch = null;
  // Same reason as the pick path: filing adopts the project's area server-side
  // unconditionally, so the Filing-to row must not show a different one.
  clarifyView.areaId = areaId;
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
          ${(a.tags || '').split(' ').filter(Boolean)
            .map(t => `<span class="map-tag">${escHtml(t)}</span>`).join('')}
          ${dueOf(a) ? dueChip(a, 'map-badge') : ''}
          ${a.after_id ? `<button class="cl-chain-x" data-id="${a.id}"
            title="Unchain — it stops waiting on ${escHtml((byId[a.after_id] || {}).content || 'that')}">✕</button>` : ''}
          <button class="cl-chain-go" data-go="${a.id}"
            title="Clarify this action — contexts, due, show-on, notes">›</button>
        </div>`).join('')
        || '<div class="gtd-empty">No actions yet — type the first one below.</div>'}
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
        document.getElementById('clarify-sheet').classList.remove('hidden');
        document.getElementById('clarify-backdrop').classList.remove('hidden');
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
  if (!clarifyView.open) return;
  const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
  // Both sub-views own their own keys — the composer's Enter adds an action.
  if (clarifyView.projSearch != null || clarifyView.compose) return;
  // Enter files from ANY field — the two inputs where Enter means something
  // local (new tag, project query) stopPropagation before this handler, and
  // the notes textarea keeps Enter as a newline.
  if (e.key === 'Enter') {
    if (e.target && e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    fileClarify(clarifyView.verb);
    return;
  }
  if (typing) return;
  // A template has no verbs and no exits, so it has no verb keys either —
  // otherwise D/G/S/⌫ would silently mean Save on a sheet that shows no such
  // button. Enter (above) is the one key it keeps, and that IS the Save.
  if (clarifyView.forOccasion) return;
  const k = e.key.toLowerCase();
  // A project's keys mirror its verbs. Backspace SELECTS trash rather than
  // firing it: deleting a project takes its actions with it a level up, which
  // is more than one keystroke should do on its own.
  if (clarifyView.project && !clarifyView.external) {
    if (k === 'a') { clarifyView.verb = 'active'; clarifyView.showDate = ''; renderClarify(); }
    else if (k === 'f') { clarifyView.verb = 'defer'; renderClarify(); }
    else if (e.key === 'Backspace') { e.preventDefault(); clarifyView.verb = 'trash'; renderClarify(); }
    else if (k === 's') { fileClarify('someday'); }
    else if (k === 'r') { clarifyView.refOpen = !clarifyView.refOpen; renderClarify(); }
    return;
  }
  if (k === 'd') { clarifyView.verb = 'do'; clarifyView.doVariant = 'done'; renderClarify(); }
  else if (k === 'i') { clarifyView.verb = 'do'; clarifyView.doVariant = 'progress'; renderClarify(); }
  else if (k === 'g') { clarifyView.verb = 'delegate'; renderClarify(); }
  else if (k === 'f') { clarifyView.verb = 'defer'; renderClarify(); }
  else if (k === 's') { fileClarify('someday'); }
  else if (k === 'r') { clarifyView.refOpen = !clarifyView.refOpen; renderClarify(); }
  else if (e.key === 'Backspace') { e.preventDefault(); fileClarify('trash'); }
});

function openBucketMgr() {
  renderBucketMgr();
  document.getElementById('bucket-mgr-overlay').classList.remove('hidden');
}

function renderBucketMgr() {
  const body = document.getElementById('bucket-mgr-body');
  const rows = peopleView.buckets.map(b => `
    <div class="bm-row" data-id="${b.id}">
      <button class="bm-swatch" title="Change color" style="background:${b.color || '#8a8a8a'}"></button>
      <input type="text" class="bm-name" value="${escHtml(b.name)}"${b.active ? '' : ' disabled'}>
      <button class="bm-toggle">${b.active ? 'retire' : 'activate'}</button>
    </div>`).join('') || `<div class="pd-empty">No buckets yet</div>`;
  body.innerHTML = `
    <div class="bm-list">${rows}</div>
    <form id="bm-add-form" class="be-inline-form">
      <input type="text" id="bm-new-name" placeholder="New bucket name" autocomplete="off">
      <button type="submit" id="bm-add-btn">Add</button>
    </form>`;
  body.querySelectorAll('.bm-row').forEach(row => {
    const id = Number(row.dataset.id);
    const nameInput = row.querySelector('.bm-name');
    nameInput.addEventListener('blur', async () => {
      if (nameInput.value === (peopleView.buckets.find(b => b.id === id) || {}).name) return;
      await patchBucket(id, { name: nameInput.value });
    });
    row.querySelector('.bm-toggle').addEventListener('click', async () => {
      const b = peopleView.buckets.find(x => x.id === id);
      await patchBucket(id, { active: b.active ? 0 : 1 });
    });
    row.querySelector('.bm-swatch').addEventListener('click', () => {
      const open = row.nextElementSibling && row.nextElementSibling.classList.contains('bm-palette');
      body.querySelectorAll('.bm-palette').forEach(p => p.remove());
      if (open) return;
      const pal = document.createElement('div');
      pal.className = 'bm-palette';
      pal.innerHTML = BUCKET_PALETTE_JS.map(c =>
        `<button class="bm-pal-swatch" style="background:${c}" data-color="${c}" title="${c}"></button>`).join('');
      row.after(pal);
      pal.querySelectorAll('.bm-pal-swatch').forEach(sw => {
        sw.addEventListener('click', () => patchBucket(id, { color: sw.dataset.color }));
      });
    });
  });
  document.getElementById('bm-add-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('bm-add-btn');
    if (btn.disabled) return;
    const name = document.getElementById('bm-new-name').value.trim();
    if (!name) return;
    btn.disabled = true;
    try {
      const res = await apiSend('/api/buckets', 'POST', { name });
      if (!res.ok) { toast(`Add bucket failed (${res.status})`); return; }
      await reloadBuckets();
      renderBucketMgr();
    } finally {
      // renderBucketMgr() rebuilds the form; guard only matters if the fetch failed.
      const still = document.getElementById('bm-add-btn');
      if (still) still.disabled = false;
    }
  });
}

async function patchBucket(id, body) {
  const res = await apiSend(`/api/buckets/${id}`, 'PATCH', body);
  if (!res.ok) { toast(`Bucket update failed (${res.status})`); return; }
  await reloadBuckets();
  renderBucketMgr();
  renderPeopleList();
}

async function reloadBuckets() {
  const buckets = await apiGet('/api/buckets', []);
  peopleView.buckets = Array.isArray(buckets) ? buckets : [];
}

// Unified add/log form. Typing a name surfaces matching existing people; picking
// one autofills their info (edits are saved) and the form logs a new interaction.
// Keeping a fresh name creates a new person, optionally with a first interaction.
function openAddPerson() {
  if (!peopleView.editable) return;
  peopleView.addSelectedId = null;
  peopleView.addAllowDuplicate = false;
  const title = document.getElementById('person-add-title');
  if (title) title.textContent = 'Add interaction';
  const body = document.getElementById('person-add-body');
  const bucketChecks = peopleView.buckets.filter(b => b.active).map(b => `
    <label class="pa-check"><input type="checkbox" value="${b.id}"> ${escHtml(b.name)}</label>`).join('')
    || `<span class="pd-empty">No buckets yet</span>`;
  body.innerHTML = `
    <form id="pa-form" class="pa-form" autocomplete="off">
      <div class="pa-row pa-name-row"><label>Name</label>
        <div class="pa-name-wrap">
          <input type="text" id="pa-name" autocomplete="off" required placeholder="Type a name…">
          <div id="pa-suggest" class="pa-suggest hidden"></div>
        </div>
      </div>
      <div id="pa-existing" class="pa-existing hidden"></div>
      <div class="pa-row"><label>Company</label><input type="text" id="pa-company" autocomplete="off"></div>
      <div class="pa-row"><label>Location</label><input type="text" id="pa-location" autocomplete="off"></div>
      <div class="pa-row"><label>Birthday</label><input type="text" id="pa-birthday" autocomplete="off"></div>
      <div class="pa-row"><label>How we met</label><input type="text" id="pa-how" autocomplete="off"></div>
      <div class="pa-row"><label>Next action</label><input type="text" id="pa-next" autocomplete="off"></div>
      <div class="pa-row"><label>Cadence</label>
        <select id="pa-cadence">${CADENCES.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
      </div>
      <div class="pa-row"><label>Contact</label>
        <label class="pa-check pa-contact"><input type="checkbox" id="pa-contact"> I have their contact info</label>
      </div>
      <div class="pa-row pa-row-notes"><label>Notes</label>
        <div class="pa-notes-wrap">
          <div id="pa-notes-current" class="pa-notes-current hidden"></div>
          <textarea id="pa-notes-add" class="pa-notes-add" placeholder="Add to notes…"></textarea>
        </div>
      </div>
      <div class="pa-int">
        <div class="pd-log-heading">Interaction (optional)</div>
        <div class="pa-row"><label>Date</label><input type="date" id="pa-int-date" value="${escHtml(runDay())}"></div>
        <div class="pa-row"><label>What happened</label><input type="text" id="pa-int-note" autocomplete="off"></div>
        <div class="pa-row"><label>Source</label>
          <select id="pa-int-source"><option value="desktop">desktop</option><option value="phone">phone</option></select>
        </div>
      </div>
      <div class="pa-actions"><button type="submit" class="be-btn-primary" id="pa-submit">Add person</button></div>
      <div id="pa-error" class="be-error"></div>
    </form>`;

  const nameInput = document.getElementById('pa-name');
  const suggest = document.getElementById('pa-suggest');
  // The notes-append box is a markdown field like every other notes surface.
  wireMdShortcuts(document.getElementById('pa-notes-add'));

  // Typing a name in FULL is the same intent as tapping it in the suggestion
  // list, and it is the likelier one on a phone (the list is a 36px target you
  // have to notice). Before this, only the tap set addSelectedId, so typing
  // "Sarah Chen" over an existing Sarah Chen minted a second row. The match is
  // resolved here and at submit; the server 409s as the backstop.
  const exactMatch = () => {
    const key = nameInput.value.trim().toLowerCase();
    if (!key) return null;
    return peopleView.people.find(p => (p.name || '').trim().toLowerCase() === key) || null;
  };

  // Tapping a suggestion PREFILLS the form from the person, so saving it whole
  // is safe. Typing the name does not, so the form is blank — and a blank field
  // there means "I didn't fill this in", never "clear what's on file". Sending
  // it whole would blank their company, birthday, cadence and buckets. Only
  // what was actually entered travels.
  const prunedFields = f => {
    const out = {};
    ['company', 'location', 'birthday', 'how_we_met', 'next_action'].forEach(k => {
      if ((f[k] || '').trim()) out[k] = f[k];
    });
    if (f.cadence && f.cadence !== 'none') out.cadence = f.cadence;
    if (f.has_contact) out.has_contact = true;
    // Empty means "checked nothing", and update_person replaces the whole set —
    // an empty list would unfile them from every bucket they are in.
    if ((f.bucket_ids || []).length) out.bucket_ids = f.bucket_ids;
    return out;
  };

  const updateBanner = () => {
    const banner = document.getElementById('pa-existing');
    const submit = document.getElementById('pa-submit');
    if (peopleView.addSelectedId) {
      const p = peopleView.people.find(x => x.id === peopleView.addSelectedId);
      banner.innerHTML = `Existing contact — edits save to <strong>${escHtml(p ? p.name : '')}</strong> and your interaction is logged.`;
      banner.classList.remove('hidden');
      submit.textContent = 'Save + log interaction';
      return;
    }
    const m = peopleView.addAllowDuplicate ? null : exactMatch();
    if (m) {
      // Said before the press, not refused after it: the button already names
      // what it will do, and the escape for two real people with one name is
      // right here rather than being a dead end.
      banner.innerHTML = `Already in your CRM — this logs to <strong>${escHtml(m.name)}</strong> instead of adding a second row. `
        + `<button type="button" class="pa-dup-btn" id="pa-dup">Add as a separate person</button>`;
      banner.classList.remove('hidden');
      const dup = document.getElementById('pa-dup');
      if (dup) dup.addEventListener('click', () => {
        peopleView.addAllowDuplicate = true;
        updateBanner();
      });
      submit.textContent = 'Log interaction';
      return;
    }
    banner.classList.add('hidden');
    submit.textContent = peopleView.addAllowDuplicate ? 'Add separate person' : 'Add person';
  };

  const selectExisting = id => {
    const p = peopleView.people.find(x => x.id === id);
    if (!p) return;
    peopleView.addSelectedId = id;
    nameInput.value = p.name || '';
    document.getElementById('pa-company').value = p.company || '';
    document.getElementById('pa-location').value = p.location || '';
    document.getElementById('pa-birthday').value = p.birthday || '';
    document.getElementById('pa-how').value = p.how_we_met || '';
    document.getElementById('pa-next').value = p.next_action || '';
    document.getElementById('pa-cadence').value = p.cadence || 'none';
    document.getElementById('pa-contact').checked = !!p.has_contact;
    const bids = (p.buckets || []).map(b => b.id);
    document.querySelectorAll('#pa-form .pa-buckets input').forEach(cb => { cb.checked = bids.includes(Number(cb.value)); });
    // Show what's already on file, read-only, so you're adding to their notes
    // rather than repeating what's in them. The box below only ever appends.
    const curNotes = document.getElementById('pa-notes-current');
    const hasNotes = (p.notes || '').trim();
    curNotes.textContent = hasNotes ? p.notes : '';
    curNotes.classList.toggle('hidden', !hasNotes);
    suggest.classList.add('hidden');
    updateBanner();
    document.getElementById('pa-int-note').focus();
  };

  nameInput.addEventListener('input', () => {
    peopleView.addSelectedId = null;   // typing means diverging from any picked person
    // …but a CHANGED name is a fresh question, so an earlier "separate person"
    // decision does not carry over to whoever is being typed now.
    peopleView.addAllowDuplicate = false;
    updateBanner();
    document.getElementById('pa-notes-current').classList.add('hidden');
    const q = nameInput.value.trim().toLowerCase();
    const matches = q ? peopleView.people.filter(p => (p.name || '').toLowerCase().includes(q)).slice(0, 8) : [];
    if (!matches.length) { suggest.classList.add('hidden'); suggest.innerHTML = ''; return; }
    suggest.innerHTML = matches.map(p => `
      <div class="pa-suggest-item" data-id="${p.id}">
        <span class="pa-suggest-name">${escHtml(p.name)}</span>
        <span class="pa-suggest-sub">${escHtml([p.company, p.location].filter(Boolean).join(' · '))}</span>
      </div>`).join('');
    suggest.classList.remove('hidden');
    suggest.querySelectorAll('.pa-suggest-item').forEach(it => {
      // pointerdown beats the input's blur on BOTH inputs; mousedown is
      // synthesised after touchend on a phone, by which time the 120ms blur
      // timer has already hidden the list and the tap hits nothing.
      it.addEventListener('pointerdown', e => { e.preventDefault(); selectExisting(Number(it.dataset.id)); });
    });
  });
  nameInput.addEventListener('focus', () => { if (suggest.innerHTML) suggest.classList.remove('hidden'); });
  nameInput.addEventListener('blur', () => setTimeout(() => suggest.classList.add('hidden'), 120));

  document.getElementById('pa-form').addEventListener('submit', async e => {
    e.preventDefault();
    const submit = document.getElementById('pa-submit');
    if (submit.disabled) return;
    const errEl = document.getElementById('pa-error');
    errEl.textContent = '';
    const name = nameInput.value.trim();
    if (!name) { errEl.textContent = 'Name is required.'; return; }
    const bucket_ids = [...document.querySelectorAll('#pa-form .pa-buckets input:checked')].map(cb => Number(cb.value));
    const fields = {
      name,
      company: document.getElementById('pa-company').value,
      location: document.getElementById('pa-location').value,
      birthday: document.getElementById('pa-birthday').value,
      how_we_met: document.getElementById('pa-how').value,
      next_action: document.getElementById('pa-next').value,
      cadence: document.getElementById('pa-cadence').value,
      has_contact: document.getElementById('pa-contact').checked,
      bucket_ids,
    };
    const intDate = document.getElementById('pa-int-date').value;
    const intNote = document.getElementById('pa-int-note').value.trim();
    const intSource = document.getElementById('pa-int-source').value;
    const notesAdd = document.getElementById('pa-notes-add').value.trim();
    submit.disabled = true;
    try {
      let personId = peopleView.addSelectedId;
      // A name typed in full names the person it matches, exactly as tapping
      // the suggestion would have. Without this the form's own autocomplete was
      // the only thing standing between you and a second row.
      let adopted = null;
      if (!personId && !peopleView.addAllowDuplicate) {
        adopted = exactMatch();
        if (adopted) personId = adopted.id;
      }
      if (personId) {
        // notes_append, never notes: appending in SQL is what keeps this form
        // from overwriting notes it never showed.
        const base = adopted ? prunedFields(fields) : fields;
        const body = notesAdd ? { ...base, notes_append: notesAdd } : base;
        const res = await apiSend(`/api/people/${personId}`, 'PATCH', body);
        if (!res.ok) { errEl.textContent = `Save failed (${res.status})`; return; }
        if (adopted) toast(`Logged to ${adopted.name} — already in your CRM`);
      } else {
        // A new person has nothing to append to, so this IS their notes.
        const body = notesAdd ? { ...fields, notes: notesAdd } : fields;
        if (peopleView.addAllowDuplicate) body.allow_duplicate = true;
        const res = await apiSend('/api/people', 'POST', body);
        // The server's own name guard, for the case the client could not see:
        // a people list loaded before someone else's session added them. It
        // hands back the person, so this becomes the log it should have been.
        if (res.status === 409) {
          const dup = (await res.json()).person;
          personId = dup.id;
          const pbody = prunedFields(fields);
          if (notesAdd) pbody.notes_append = notesAdd;
          const pres = await apiSend(`/api/people/${personId}`, 'PATCH', pbody);
          if (!pres.ok) { errEl.textContent = `Save failed (${pres.status})`; return; }
          toast(`Logged to ${dup.name} — already in your CRM`);
        } else if (!res.ok) {
          errEl.textContent = `Add failed (${res.status})`; return;
        } else {
          personId = (await res.json()).id;
        }
      }
      if (intNote && intDate) {
        const ires = await apiSend(`/api/people/${personId}/interactions`, 'POST', { date: intDate, note: intNote, source: intSource });
        if (!ires.ok) { errEl.textContent = `Person saved, but logging failed (${ires.status})`; await loadPeopleData(); return; }
      }
      await peopleSatisfy('entries');
      document.getElementById('person-add-overlay').classList.add('hidden');
      await loadPeopleData();
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById('person-add-overlay').classList.remove('hidden');
  nameInput.focus();
}

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
