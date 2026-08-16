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
    state.settings = await fetch('/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    }).then(r => r.json());
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
    const res = await fetch('/api/panel/toggle', { method: 'POST' }).then(r => r.json());
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
  const zones = await fetch('/api/timezones').then(r => r.json()).catch(() => []);
  const current = currentTimezone();
  sel.innerHTML = zones.map(z =>
    `<option value="${escHtml(z)}"${z === current ? ' selected' : ''}>${escHtml(z)}</option>`).join('');
  sel.addEventListener('change', async () => {
    sel.disabled = true;
    state.settings = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: sel.value }),
    }).then(r => r.json());
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
  experiments: [],
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
  view: { start: 0, end: 1440 },
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
  const dateStr = formatDateYMD(state.currentDate);
  const [blocks, projects, domains, gcal, overrides, inbox, sheetsInbox, reviewStatus, experiments, accountabilityNodes, calendars, settings, qrOutcomes, dismissals, locations, tagLocations, tagDevices, tagTimes, tagDaily] = await Promise.all([
    fetch('/api/blocks').then(r => r.json()).catch(() => state.blocks),
    fetch('/api/areas').then(r => r.json()).catch(() => state.areas),
    fetch('/api/domains').then(r => r.json()).catch(() => state.domains),
    fetch('/api/gcal').then(r => r.json()).catch(() => state.gcalEvents),
    fetch(`/api/overrides?date=${dateStr}`).then(r => r.json()).catch(() => state.overrides),
    fetch('/api/inbox').then(r => r.json()).catch(() => state.inbox),
    fetch('/api/sheets/inbox').then(r => r.json()).catch(() => state.sheetsInbox),
    fetch('/api/gtd-review').then(r => r.json()).catch(() => ({})),
    fetch('/api/experiments').then(r => r.json()).catch(() => state.experiments),
    fetch('/api/accountability/nodes').then(r => r.json()).catch(() => []),
    fetch('/api/calendars').then(r => r.json()).catch(() => []),
    fetch('/api/settings').then(r => r.json()).catch(() => ({})),
    fetch(`/api/accountability/outcomes?from=${localDatePlusDays(dateStr, -4)}&to=${dateStr}`).then(r => r.json()).catch(() => []),
    fetch('/api/dismissals').then(r => r.json()).catch(() => []),
    fetch('/api/locations').then(r => r.json()).catch(() => state.locations),
    fetch('/api/tag-locations').then(r => r.json()).catch(() => state.tagLocations),
    fetch('/api/tag-devices').then(r => r.json()).catch(() => state.tagDevices),
    fetch('/api/tag-times').then(r => r.json()).catch(() => state.tagTimes),
    fetch('/api/tag-daily').then(r => r.json()).catch(() => state.tagDaily),
  ]);

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
  state.experiments = experiments;
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
  state.projects = await fetch('/api/projects').then(r => r.json()).catch(() => state.projects);
  if (state.activeDomainId) {
    state.activeDomainItems = await fetch(`/api/inbox/active?domain_id=${state.activeDomainId}`).then(r => r.json()).catch(() => state.activeDomainItems);
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
  // The due dot rides on the hub's GTD icon and the review fold-out header.
  ['hub-gtd-btn', 'gtd-review-head'].forEach(id => {
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
function onLongPress(el, fn) {
  let t = null, sx = 0, sy = 0, fired = false;
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    fired = false;
    sx = e.clientX; sy = e.clientY;
    t = setTimeout(() => { fired = true; fn(); }, 550);
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
    t = setTimeout(() => { t = null; arm(e); }, 550);
    const cancelOnMove = ev => {
      if (t && (Math.abs(ev.clientY - sy) > 10 || Math.abs(ev.clientX - sx) > 10)) {
        clearTimeout(t); t = null;
      }
    };
    el.addEventListener('pointermove', cancelOnMove);
    const stop = () => {
      clearTimeout(t); t = null;
      el.removeEventListener('pointermove', cancelOnMove);
    };
    ['pointerup', 'pointercancel'].forEach(ev =>
      el.addEventListener(ev, stop, { once: true }));
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
  fetch('/api/dismissals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, key }),
  }).catch(() => {});
  renderTimeline();
  renderEngage();   // Engage shares the event dismissal set (⌘-click there)
  pushUndo(`hid "${label || 'item'}"`, async () => {
    delete state.tlHidden[type][key];
    await fetch('/api/dismissals', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, key }),
    }).catch(() => {});
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
  if (!wake || !sleep) return { start: 0, end: 1440 };
  const pageDate = formatDateYMD(state.currentDate);
  const viewingToday = isToday(state.currentDate);
  const pageDow = (state.currentDate.getDay() + 6) % 7;
  const deadlineMin = (node) => {
    const ov = viewingToday ? node.today_override : (state.qrPageOverrides[`${node.id}:${pageDate}`] || null);
    const def = nodeWindowForDow(node, pageDow);
    const end = ov ? ov.window_end : def.window_end;
    const offset = ov ? ov.window_end_offset_days : def.window_end_offset_days;
    return timeToMinutes(end) + (offset ? 1440 : 0);
  };
  const start = deadlineMin(wake);
  let end = deadlineMin(sleep);
  // A sleep deadline at/before wake means past midnight, offset flag or not
  if (end <= start) end += 1440;
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
    const hh = h % 24;
    const label = hh === 0 ? '12 AM' : hh < 12 ? `${hh} AM` : hh === 12 ? '12 PM' : `${hh - 12} PM`;
    html += `<div class="tl-hour" style="top:${pct}%">
      <span class="tl-hour-label">${label}</span>
      <div class="tl-hour-line"></div>
    </div>`;
  }
  grid.innerHTML = html;
}

function renderDateLabel() {
  const el = document.getElementById('tl-date-label');
  if (el) el.textContent = formatDateLabel(state.currentDate);
  updateNavButtons();
}

function updateNavButtons() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cur = new Date(state.currentDate); cur.setHours(0, 0, 0, 0);
  const diff = Math.round((cur - today) / 86400000);
  const prev = document.getElementById('nav-prev');
  const next = document.getElementById('nav-next');
  const bounds = navBounds();
  if (prev) prev.disabled = diff <= bounds.min;
  if (next) next.disabled = diff >= bounds.max;
}


function renderBlocksLayer(bodyH = 600) {
  const layer = document.getElementById('tl-blocks-layer');
  if (!layer) return;
  const dow = jsDateToDayOfWeek(state.currentDate);
  const projectsById = Object.fromEntries(state.areas.map(p => [p.id, p]));
  const dateStr = formatDateYMD(state.currentDate);
  const prevDate = new Date(state.currentDate.getTime() - 86400000);
  const prevDow = jsDateToDayOfWeek(prevDate);
  const prevDateStr = formatDateYMD(prevDate);

  const isVisible = (b, dayOfWeek) => b.active && b.day_of_week === dayOfWeek;

  const segments = [];

  // Today's blocks (overnight blocks run past 1440 in semantic minutes);
  // a day override's times take precedence over the block's defaults
  for (const b of state.blocks.filter(b => isVisible(b, dow))) {
    const override = state.overrides.find(o => o.block_id === b.id && o.date === dateStr);
    const startT = (override && override.start_time) || b.start_time;
    const endT = (override && override.end_time) || b.end_time;
    const startMin = timeToMinutes(startT);
    const endMin = timeToMinutes(endT) + (endT < startT ? 1440 : 0);
    const cancelled = override ? override.cancelled === 1 : false;
    segments.push({ b, startMin, endMin, cancelled, label: b.label, cont: false });
  }

  // Yesterday's overnight blocks — continuation segments from 00:00 → end_time
  for (const b of state.blocks.filter(b => isVisible(b, prevDow))) {
    const override = state.overrides.find(o => o.block_id === b.id && o.date === prevDateStr);
    if (override && override.cancelled === 1) continue;
    const startT = (override && override.start_time) || b.start_time;
    const endT = (override && override.end_time) || b.end_time;
    if (endT >= startT) continue;
    segments.push({ b, startMin: 0, endMin: timeToMinutes(endT), cancelled: false, label: b.label + ' (cont.)', cont: true });
  }

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
        const res = await fetch('/api/overrides', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            block_id: blockId, date: dateStr, cancelled: false,
            start_time: minutesToHHMM(curS % 1440),
            end_time: minutesToHHMM(curE % 1440),
          }),
        });
        if (res.ok) {
          const data = await res.json();
          const idx = state.overrides.findIndex(o => o.block_id === blockId && o.date === dateStr);
          if (idx !== -1) state.overrides[idx] = data; else state.overrides.push(data);
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
    return `<div class="tl-allday-event" style="background:${rgbaColor(col, 0.14)};border-left-color:${col};color:color-mix(in srgb, ${col} 50%, #fff)">${escHtml(e.summary || '')}</div>`;
  }).join('');
}

function renderGcalLayer(bodyH = 600) {
  const layer = document.getElementById('tl-gcal-layer');
  if (!layer) return;
  layer.style.pointerEvents = 'none';
  const isoMin = iso => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };
  const nextDate = new Date(state.currentDate.getTime() + 86400000);
  // Next-day events count when the view runs past midnight (sleep +1d)
  const dayEvents = state.gcalEvents.filter(e => !e.allday &&
    !state.tlHidden.event[`${e.uid}|${e.start}`] &&
    (sameDay(state.currentDate, e.start) || (state.view.end > 1440 && sameDay(nextDate, e.start))));
  layer.innerHTML = dayEvents.map(e => {
    const base = sameDay(nextDate, e.start) ? 1440 : 0;
    const startMin = base + isoMin(e.start);
    let endMin = base + isoMin(e.end);
    if (endMin <= startMin) endMin += 1440;
    const top = Math.max(0, minutesToViewPercent(startMin));
    const bottom = Math.min(100, minutesToViewPercent(endMin));
    if (bottom - top <= 0) return '';
    const height = Math.max(bottom - top, 2);
    const tight = (height * bodyH / 100) < 18;
    const timeStr = `${isoToAmPm(e.start)}–${isoToAmPm(e.end)}`;
    const inner = `<div class="tl-event-row"><span class="tl-event-summary">${escHtml(e.summary || '')}</span><span class="tl-event-time">${escHtml(timeStr)}</span></div>`;
    const col = e.color || '#888888';
    const key = `${e.uid}|${e.start}`;
    return `<div class="tl-gcal-event${tight ? ' tl-event-tight' : ''}" data-ev-key="${escHtml(key)}" data-ev-label="${escHtml(e.summary || 'Event')}" style="pointer-events:auto;top:${top}%;height:${height}%;background:${rgbaColor(col, 0.14)};border-left-color:${col};color:color-mix(in srgb, ${col} 50%, #fff)">${inner}</div>`;
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
  el.classList.remove('fetch-failed');
  if (!state.lastFetched) { el.textContent = ''; return; }
  const mins = Math.floor((Date.now() - state.lastFetched) / 60000);
  el.textContent = mins === 0 ? 'Last fetched: just now' : `Last fetched: ${mins} min ago`;
}

function startCurrentTimeTick() {
  if (currentTimeTick) clearInterval(currentTimeTick);
  currentTimeTick = setInterval(() => {
    updateCurrentTimeLine();
  }, 60000);
}

async function refreshExternal() {
  fetchFailed = false;
  const todayStr = formatDateYMD(new Date());
  const [gcalResult, sheetsResult, outcomesResult] = await Promise.allSettled([
    fetch('/api/gcal/refresh', { method: 'POST' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch('/api/sheets/refresh', { method: 'POST' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
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
  openM('tab-gtd');
  await refreshGtd();
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
  const dateStr = formatDateYMD(state.currentDate);
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
      gtdReview = await fetch('/api/gtd-review/step', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ week: gtdReview.week_start_date, step, done: true }),
      }).then(r => r.json());
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
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cur = new Date(state.currentDate); cur.setHours(0, 0, 0, 0);
    if (Math.round((cur - today) / 86400000) <= navBounds().min) return;
    state.currentDate = new Date(state.currentDate.getTime() - 86400000);
    await fetchOverridesForDate(state.currentDate);
    renderTimeline();
  });
  document.getElementById('nav-next').addEventListener('click', async () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cur = new Date(state.currentDate); cur.setHours(0, 0, 0, 0);
    if (Math.round((cur - today) / 86400000) >= navBounds().max) return;
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

async function fetchOverridesForDate(date) {
  const dateStr = formatDateYMD(date);
  state.overrides = await fetch(`/api/overrides?date=${dateStr}`).then(r => r.json());
}

async function toggleBlockOverride(blockId) {
  const dateStr = formatDateYMD(state.currentDate);
  const existing = state.overrides.find(o => o.block_id === blockId && o.date === dateStr);
  const hasTimes = existing && (existing.start_time || existing.end_time);

  if (existing && existing.cancelled === 1 && !hasTimes) {
    // un-cancel with nothing else on the row — drop it
    const saved = existing;
    const idx = state.overrides.indexOf(existing);
    state.overrides.splice(idx, 1);
    renderTimeline();
    try {
      const res = await fetch(`/api/overrides/${saved.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
    } catch (err) {
      state.overrides.push(saved);
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
  renderTimeline();
  try {
    const res = await fetch('/api/overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ block_id: blockId, date: dateStr, cancelled: !!cancelled }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    const idx = state.overrides.indexOf(optimistic);
    if (idx !== -1) state.overrides[idx] = data;
  } catch (err) {
    if (existing) existing.cancelled = prev;
    else {
      const idx = state.overrides.indexOf(optimistic);
      if (idx !== -1) state.overrides.splice(idx, 1);
    }
    renderTimeline();
    console.error('Override save failed:', err);
  }
}

// Called (via evaluate_js) after the NOW panel checks something off — and
// after an inbox capture lands from outside this window (hotkey, bridge) —
// so the day view reflects it immediately instead of waiting for a manual
// refresh. The name is historical (the panel used to edit the to-do plan).
// Refetches the inbox too: the footer's "Clarify N" count is stale otherwise.
async function refreshTodoNow() {
  state.inbox = await fetch('/api/inbox').then(r => r.json()).catch(() => state.inbox);
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

function detectCurrentStandardBlock() {
  const now = new Date();
  const dow = jsDateToDayOfWeek(now);
  const nowTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const dateStr = formatDateYMD(now);
  const projectsById = Object.fromEntries(state.areas.map(p => [p.id, p]));

  for (const b of state.blocks) {
    if (!b.active || b.day_of_week !== dow || !b.area_id) continue;
    const proj = projectsById[b.area_id];
    if (!proj || proj.type !== 'standard') continue;
    const ov = state.overrides.find(o => o.block_id === b.id && o.date === dateStr);
    if (ov && ov.cancelled === 1) continue;
    const startT = (ov && ov.start_time) || b.start_time;
    const endT = (ov && ov.end_time) || b.end_time;
    if (nowTime >= startT && nowTime < endT) return b;
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
// ±3 days normally: this is a DAY manager, and the timeline is the day you are
// in, not a calendar to browse. A review pass widens it for its duration —
// an explicit, bounded exception with an end, rather than a permanent
// widening that would undo the scoping.
const reviewPass = { active: false, from: null, to: null, step: null };

function navBounds() {
  if (!reviewPass.active) return { min: -3, max: 3 };
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
  const res = await fetch('/api/inbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }).catch(() => null);
  if (!res || !res.ok) { toast('Capture failed'); return null; }
  const item = await res.json();
  // A create inverts to a delete of the new id (see the undo rule).
  pushUndo(`captured "${content}"`, async () => {
    await fetch(`/api/inbox/${item.id}`, { method: 'DELETE' });
    await refreshInboxCount();
  });
  await refreshInboxCount();
  return item;
}

async function refreshInboxCount() {
  state.inbox = await fetch('/api/inbox').then(r => r.json()).catch(() => state.inbox);
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
  if (!document.getElementById('tab-gtd').classList.contains('hidden')) await refreshGtd();
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
  return fetch(`/api/inbox/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(flush, NOTES_SAVE_MS);
  });
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
  await fetch(`/api/inbox/${id}`, { method: 'DELETE' });
  if (snap) {
    pushUndo(label, async () => {
      await fetch('/api/inbox/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snap),
      });
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
  const today = formatDateYMD(new Date());
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

function itemTags(item) {
  return (item.tags || '').split(/\s+/).filter(Boolean);
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
  { key: 'areas', name: 'Areas', group: 'Where and what',
    desc: 'The areas of your life, and the domains that group them.',
    summary: () => String(beCounts.areas || 0) },
  { key: 'locations', name: 'Locations', group: 'Where and what',
    desc: 'Places a gate or a context tag can be pinned to.',
    summary: () => String(beCounts.locations || 0) },
  { key: 'qr', name: 'Gates', group: 'Where and what',
    desc: 'Scan points that gate the day.',
    summary: () => plural(beCounts.qr, 'gate') },
  { key: 'calendars', name: 'Calendars', group: 'App',
    desc: 'iCal feeds drawn on the timeline.',
    summary: () => `${beCounts.calendars || 0} connected` },
  { key: 'display', name: 'Display', group: 'App',
    desc: 'Theme, timezone, and the NOW panel.',
    summary: () => `${document.documentElement.classList.contains('theme-light') ? 'Light' : 'Dark'}`
      + ` · ${currentTimezone().split('/').pop().replace(/_/g, ' ')}` },
];

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

function seFieldHtml(f, v) {
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
  } else if (f.kind === 'select') {
    control = `<select class="se-input se-select" data-f="${f.key}">${f.options(v).map(o =>
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
    if (f.kind === 'openpicker') {
      wrap.addEventListener('click', () => f.open(v));
    } else if (f.kind === 'action') {
      wrap.addEventListener('click', async () => {
        await f.run(seSheet.item);
        closeSeSheet();
        renderSettingsIndex();
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
    seSheet.error = error;
    renderSeSheet();
    return;
  }
  closeSeSheet();
  renderSettingsIndex();
}

async function removeSeItem() {
  const spec = SETTINGS_SHEETS[seSheet.kind];
  if (spec.confirm && !confirm(spec.confirm(seSheet.item))) return;
  await spec.remove(seSheet.item);
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

// ── Per-datatype sheets ──────────────────────────────────────

const SETTINGS_SHEETS = {

  // A block row is a GROUP of one-per-day rows (groupBlocks), so saving an
  // edit deletes the group and re-posts it — the API has no group identity.
  block: {
    title: it => it ? 'Edit block' : 'Add block',
    save: () => 'Save block',
    removeLabel: 'Delete block',
    blank: () => ({ label: '', color: BLOCK_COLORS[0], days: [], start: '', end: '',
                    area: '', location: '', active: true }),
    load: g => ({
      label: g.label, color: g.color, days: g.days.slice(),
      start: g.start_time, end: g.end_time,
      area: g.area_id || '', location: g.location_id || '',
      // A group is paused when every row in it is — the rows only ever move
      // together, and a half-paused group has no meaning on the timeline.
      active: g.rows.some(r => r.active),
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
    ],
    submit: async (v, g) => {
      if (!v.label.trim() || !v.color || !v.start || !v.end) return 'Label, colour, from and to are required.';
      if (!v.days.length) return 'Select at least one day.';
      if (g) await Promise.all(g.rows.map(r => fetch(`/api/blocks/${r.id}`, { method: 'DELETE' })));
      const res = await fetch('/api/blocks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: v.label.trim(), color: v.color, days: v.days,
          start_time: v.start, end_time: v.end,
          area_id: v.area || null, location_id: v.location || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // The old rows were deleted to make room for the new ones, so a refused
        // POST (an overlap) would otherwise take the block with it. Put it back
        // as it was and report the refusal.
        if (g) {
          await fetch('/api/blocks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              label: g.label, color: g.color, days: g.days,
              start_time: g.start_time, end_time: g.end_time,
              area_id: g.area_id || null, location_id: g.location_id || null,
            }),
          }).catch(() => {});
          await refreshBlockEditor();
        }
        return data.error || 'Error saving block.';
      }
      // The group is re-POSTed on every save (the API has no group identity),
      // and rows arrive active — so a paused group has to be paused again, or
      // editing one would quietly turn it back on.
      if (!v.active) {
        await Promise.all(data.map(b => fetch(`/api/blocks/${b.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: 0 }),
        })));
      }
      await refreshBlockEditor();
      return null;
    },
    remove: async g => {
      await Promise.all(g.rows.map(r => fetch(`/api/blocks/${r.id}`, { method: 'DELETE' })));
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
      nth: 1, weekday: 0, anchor: formatDateYMD(new Date()),
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
        { key: 'area', label: 'Area', kind: 'select',
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
        { key: 'interval', label: 'Every', kind: 'number', min: 1, suffix: unit, half: true },
        { key: 'anchor', label: 'Starting', kind: 'date', half: true },
      ];
    },
    submit: async (v, it) => {
      if (it) {
        const res = await fetch(`/api/recurring/${it.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: v.project ? parseInt(v.project) : null,
            active: v.active ? 1 : 0,
          }),
        });
        if (!res.ok) return 'Error saving.';
        await refreshRecurringList();
        return null;
      }
      if (!v.name.trim() || !v.area || !v.anchor) return 'Name, area and start date are required.';
      const body = {
        name: v.name.trim(), area_id: parseInt(v.area), kind: v.kind,
        anchor_date: v.anchor, interval: parseInt(v.interval) || 1,
      };
      if (v.kind === 'weekly') {
        if (!v.days.length) return 'Select at least one day.';
        body.days_of_week = v.days.slice().sort().join('');
      } else if (v.kind === 'monthly_nth') {
        body.nth = parseInt(v.nth);
        body.weekday = parseInt(v.weekday);
      }
      const res = await fetch('/api/recurring', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return 'Error saving.';
      await refreshRecurringList();
      return null;
    },
    remove: async it => {
      await fetch(`/api/recurring/${it.id}`, { method: 'DELETE' });
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
        await fetch('/api/areas', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: v.name.trim(), type: v.type, domain_id: parseInt(v.domain) || null }),
        });
        await refreshBlockEditor();
        return null;
      }
      const patch = async body => fetch(`/api/areas/${a.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
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
      await fetch(`/api/areas/${a.id}`, { method: 'DELETE' });
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
        await fetch(`/api/domains/${d.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, ...(d.is_default ? {} : { active: v.active ? 1 : 0 }) }),
        });
      } else {
        await fetch('/api/domains', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
      }
      await refreshBlockEditor();
      return null;
    },
    remove: async d => {
      await fetch(`/api/domains/${d.id}`, { method: 'DELETE' });
      await refreshBlockEditor();
    },
  },

  // A location's COORDINATES stay immutable — they are what gates and context
  // tags were pinned against, and moving them would silently redefine every
  // geofence that quoted them. Its name and its state are ordinary edits, the
  // same two verbs every other settings item has.
  location: {
    title: it => it ? 'Location' : 'Add location',
    save: it => it ? 'Save location' : 'Save location',
    removeLabel: 'Delete location',
    confirm: it => `Delete "${it.name}"? Gates and tags pinned to it lose their anchor.`,
    blank: () => ({ name: '', lat: '', lng: '', radius: '', active: true }),
    load: l => ({ name: l.name, lat: l.lat, lng: l.lng, radius: l.radius_m,
                  active: l.active !== 0 }),
    fields: (v, it) => it ? [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'e.g. Mox' },
      { key: 'coords', label: 'Coordinates', kind: 'static', text: `${it.lat}, ${it.lng}`,
        hint: 'Fixed — a gate quotes these, so moving them would move the gate.' },
      { key: 'radius', label: 'Radius', kind: 'static', text: `${it.radius_m}m` },
      seStateRow('Paused: not offered to gates or tags. Ones already pinned keep their anchor.'),
    ] : [
      { key: 'name', label: 'Name', kind: 'text', placeholder: 'e.g. Mox' },
      { key: 'lat', label: 'Latitude', kind: 'number', step: 'any', half: true },
      { key: 'lng', label: 'Longitude', kind: 'number', step: 'any', half: true },
      { key: 'radius', label: 'Radius', kind: 'number', suffix: 'm', hint: 'blank = 150m' },
    ],
    submit: async (v, it) => {
      if (it) {
        if (!v.name.trim()) return 'Name is required.';
        const res = await fetch(`/api/locations/${it.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: v.name.trim(), active: v.active ? 1 : 0 }),
        });
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
      await fetch('/api/locations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: v.name.trim(), lat, lng, radius_m: isNaN(radius) ? null : radius }),
      });
      await renderQrManager();
      return null;
    },
    remove: async l => {
      await fetch(`/api/locations/${l.id}`, { method: 'DELETE' });
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
      location: '', radius: '', stake: '', routine: '',
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
        // Dollars in the field, cents in the column. Blank means "use the
        // default", which is a different thing from zero.
        stake: n.charge_cents == null ? '' : (n.charge_cents / 100).toFixed(2),
        routine: n.routine_id == null ? '' : String(n.routine_id),
        routine0: n.routine_id == null ? '' : String(n.routine_id),
      };
    },
    fields: (v, it) => {
      const pending = it ? (it.pending_changes || []).filter(p => p.field !== 'active') : [];
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
        ...(it && it.today_state && it.today_state.judged ? [{ key: 'todayres', label: 'Today',
          kind: 'static',
          text: `✗ ${gateReason(it.today_state.judged.failure_reason)} · `
            + gateStatus(it.today_state.judged.charge_status) }]
          : it && it.today_state && it.today_state.scan ? [{ key: 'todayres', label: 'Today',
            kind: 'static', text: `✓ scanned ${it.today_state.scan.scanned_at.slice(11, 16)}` }] : []),
        ...(it ? [{ key: 'link', label: 'Scan link', kind: 'action',
          text: `${state.settings.gate_scan_url || ''}/scan/${it.token}`,
          action: 'Copy',
          hint: 'The QR code to print. Anyone with this URL can satisfy the gate.',
          run: n => {
            navigator.clipboard?.writeText(`${state.settings.gate_scan_url || ''}/scan/${n.token}`);
            toast('Scan link copied');
          } }] : []),

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
        ...(it ? [seStateRow('Pausing a gate is an easing, so it takes effect in 24h —'
          + ' turning it back on before then calls it off.')] : []),
        ...(pending.length ? [{ key: 'pending', label: 'Pending', kind: 'static',
          hint: 'Anything that makes a gate easier waits 24h, so it can\'t be loosened '
            + 'in the moment you want to dodge it.',
          text: pending.map(p => (p.field === '__delete__'
            ? 'gate is deleted'
            : `${GATE_FIELDS[p.field] || p.field} → `
              + `${p.field === 'charge_cents' ? '$' + ((p.new_value || 0) / 100).toFixed(2)
                : p.new_label || p.new_value}`)
            + ` (applies ${new Date(p.apply_at).toLocaleString()})`).join('; ') }] : []),
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
        const resp = await fetch('/api/accountability/nodes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            label: v.label.trim(), source_uid: v.source,
            geofence_lat: loc ? loc.lat : null,
            geofence_lng: loc ? loc.lng : null,
            geofence_radius_m: loc ? (isNaN(radius) ? loc.radius_m : radius) : null,
          }),
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
          await fetch(`/api/flows/${v.routine0}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_node_id: null }),
          });
        }
        if (v.routine) {
          await fetch(`/api/flows/${v.routine}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr_node_id: n.id }),
          });
        }
      }
      if (v.location) {
        const loc = state.locations.find(l => String(l.id) === String(v.location));
        body.geofence_lat = loc.lat;
        body.geofence_lng = loc.lng;
      }
      const res = await fetch(`/api/accountability/nodes/${n.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return `Edit failed (${res.status}).`;
      const result = await res.json();
      if (v.active !== v.active0) {
        const route = v.active ? 'activate' : 'disable';
        const r = await fetch(`/api/accountability/nodes/${n.id}/${route}`, { method: 'PATCH' });
        if (!r.ok) return `${v.active ? 'Resume' : 'Pause'} failed (${r.status}).`;
      }
      if (result.pending && result.pending.length) {
        alert(`Saved. Loosening changes apply ${new Date(result.apply_at).toLocaleString()}:\n`
          + result.pending.map(p => `${p.field} → ${p.newVal}`).join('\n'));
      }
      await renderQrManager();
      return null;
    },
    remove: async n => {
      const res = await fetch(`/api/accountability/nodes/${n.id}`, { method: 'DELETE' });
      if (!res.ok) { alert(`Delete failed (${res.status}): ${await res.text()}`); return; }
      const out = await res.json().catch(() => ({}));
      // A live gate's deletion is QUEUED, so say when it lands — the gate is
      // still on the list until then, and silence would read as a failure.
      if (out.pending) toast(`Deletion applies ${new Date(out.apply_at).toLocaleString()}`);
      await renderQrManager();
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
      const res = await fetch('/api/gates/billing', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
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
      const res = await fetch('/api/calendars', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: v.url.trim(), color: v.color }),
      });
      const data = await res.json();
      if (!res.ok) return data.error || 'Could not add calendar.';
      await refreshCalendars();
      document.getElementById('be-ics-status').textContent =
        `Added — ${data.count} event${data.count === 1 ? '' : 's'} found.`;
      return null;
    },
    remove: async c => {
      await fetch(`/api/calendars/${c.id}`, { method: 'DELETE' });
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
    const res = await fetch('/api/blocks/export-ics', { method: 'POST' });
    const data = await res.json();
    btn.disabled = false;
    status.textContent = res.ok ? `Saved to ${data.path}` : 'Error';
  });
}

async function openBlockEditor() {
  const [projects, domains, blocks, locations] = await Promise.all([
    fetch('/api/areas').then(r => r.json()),
    fetch('/api/domains').then(r => r.json()).catch(() => []),
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
  renderBeRecurring(await fetch('/api/recurring').then(r => r.json()).catch(() => []), projects);
  renderBeCalendars(await fetch('/api/calendars').then(r => r.json()).catch(() => []));
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
    fetch('/api/domains').then(r => r.json()).catch(() => []),
    fetch('/api/blocks').then(r => r.json()),
    fetch('/api/gcal').then(r => r.json()),
    fetch('/api/calendars').then(r => r.json()).catch(() => []),
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
    fetch('/api/domains').then(r => r.json()).catch(() => []),
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
  await fetch(`/api/calendars/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Section lists ────────────────────────────────────────────

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
  list.innerHTML = groups.map(g => beRow({
    id: g.id, color: g.color, name: g.label,
    dim: !g.rows.some(r => r.active),
    meta: `${formatDays(g.days)} · ${g.start_time}–${g.end_time}`,
    sub: [g.project_name, g.location_name].filter(Boolean).join(' · '),
    badge: g.rows.some(r => r.active) ? '' : 'paused',
  })).join('') + beAddRow('Add block');
  wireBeList(list, 'block', groups);
}

function ordinalNth(n) {
  return ['1st', '2nd', '3rd', '4th', '5th'][n - 1] || `${n}th`;
}

function recurringScheduleLabel(t) {
  const every = (n, unit) => n > 1 ? `every ${n} ${unit}s` : `every ${unit}`;
  if (t.kind === 'weekly') {
    const days = (t.days_of_week || '').split('').map(d => DAY_NAMES[parseInt(d)]).join(', ');
    return `${days} ${every(t.interval, 'week')}`;
  }
  if (t.kind === 'monthly_nth') return `${ordinalNth(t.nth)} ${DAY_NAMES[t.weekday]} ${every(t.interval, 'month')}`;
  if (t.kind === 'monthly_date') return `Day ${parseInt(t.anchor_date.slice(8, 10))} ${every(t.interval, 'month')}`;
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
    sub: [byId[t.area_id] ? byId[t.area_id].name : null, projectName(t.project_id)]
      .filter(Boolean).join(' · '),
    badge: t.active ? '' : 'paused',
  })).join('') + beAddRow('Add recurring task');
  wireBeList(list, 'recurring', tasks);
}

async function checkActiveBlock() {
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
let dayStamp = formatDateYMD(new Date());

async function checkDayRollover() {
  const now = formatDateYMD(new Date());
  if (now === dayStamp) return;
  // Only follow the timeline forward if it was sitting on the old today; a day
  // deliberately navigated to stays where it was put.
  const follow = formatDateYMD(state.currentDate) === dayStamp;
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

  review_next_actions: { phase: 'Get Current', pushed: true,
    hint: 'Mark off completed; add follow-on steps.' },
  review_cal_back: { phase: 'Get Current', act: 'pass_back',
    hint: 'Uncaptured follow-ups. Archive the past with nothing left in it.' },
  review_cal_fwd: { phase: 'Get Current', act: 'pass_fwd',
    hint: 'Anything needing preparation that starts now.' },
  review_waiting: { phase: 'Get Current', waiting: true,
    hint: 'What\'s owed to you? What needs chasing?' },
  review_projects: { phase: 'Get Current', stalled: true,
    hint: 'Anything with none is stalled or dead — decide which.' },
  review_checklists: { phase: 'Get Current' },

  review_someday: { phase: 'Get Creative', count: 'someday',
    hint: 'Activate what\'s ripe, delete what\'s outlived your interest, add new.' },
  review_creative: { phase: 'Get Creative',
    hint: 'Anything new worth capturing into the system.' },
};

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

// The weekly review lives INSIDE the GTD overlay now: a fold-out section at
// the top, toggled by #gtd-review-head. No modal.
async function openGtdReview() {
  const today = formatDateYMD(new Date());
  const [review, habits, flows] = await Promise.all([
    fetch('/api/gtd-review').then(r => r.json()),
    fetch('/api/habits').then(r => r.json()).catch(() => null),
    fetch(`/api/flows?date=${today}`).then(r => r.json()).catch(() => []),
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
  const run = await fetch(`/api/flows/${gtdReview.flow.id}/run`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: formatDateYMD(new Date()), steps: ticks, completed: complete }),
  }).then(r => r.json()).catch(() => null);
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
  const verdict = prompt(verb === 'graduated'
    ? 'One line for the ledger — what made it stick?'
    : 'One line for the ledger — why drop it?') || null;
  await fetch(`/api/habits/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: verb, verdict }),
  });
  pushUndo(`${verb === 'graduated' ? 'graduated' : 'dropped'} "${name}"`, async () => {
    await fetch(`/api/habits/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'forming' }),
    });
    await openGtdReview();
  });
  toast(`${verb}: ${name}`);
  await openGtdReview();
}

async function experimentVerb(id, verb, name) {
  // WAIT is the honest no-op: the experiment is already resolved-and-awaiting,
  // so choosing to leave it writes nothing. It exists as a button because
  // "I considered it and left it" and "I never looked" should not be the same
  // gesture.
  if (verb === 'wait') { toast(`left for next review: ${name}`); return; }
  const res = await fetch(`/api/habit-experiments/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome: verb }),
  });
  if (!res.ok) { toast((await res.json()).error || 'could not evaluate'); return; }
  // Undoing an evaluation also unmints the habit it may have created — half
  // an undo would strand a habit nothing decided on.
  pushUndo(`${verb === 'habit' ? 'promoted' : verb + 'ed'} experiment "${name}"`, async () => {
    await fetch(`/api/habit-experiments/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'resolved' }),
    });
    await openGtdReview();
  });
  toast(verb === 'habit' ? `now forming: ${name}` : `${verb}: ${name}`);
  await openGtdReview();
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

  const stalledList = counts.stalled.length
    ? `<ul class="gr-stalled">${counts.stalled.map(p =>
        `<li>${escHtml(p.content)}<span class="gr-stalled-area">${escHtml(p.area_name || '—')}</span></li>`).join('')}</ul>`
    : '';

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
      html += `<div class="gr-phase"><div class="gr-phase-name">${escHtml(phase)}</div>`;
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
          ${s.act === 'sweep' ? `<button class="gr-act" data-act="sweep">▶ 5-minute sweep</button>` : ''}
          ${s.act === 'pass_back' ? '<button class="gr-act" data-act="pass_back">▶ Walk it back 14 days</button>' : ''}
          ${s.act === 'pass_fwd' ? '<button class="gr-act" data-act="pass_fwd">▶ Walk the next 14 days</button>' : ''}
          ${s.stalled ? stalledList : ''}
          ${s.waiting ? waitingList : ''}
          ${s.pushed ? pushedList : ''}
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
    ${habitReviewHtml(gtdReview.habits)}
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
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
        String(d.getDate()).padStart(2, '0')}`;
      openDangerousWriting({ goalKind: 'time', goalTime: 5, hardcore: false,
                             logName: `${iso} emptied`, autostart: true });
    });
  });

  panel.querySelectorAll('[data-hbverb]').forEach(b => b.addEventListener('click', () => {
    const row = b.closest('[data-hbid]');
    const h = gtdReview.habits.forming.find(x => x.id === parseInt(row.dataset.hbid));
    habitVerb(h.id, b.dataset.hbverb, h.content);
  }));
  panel.querySelectorAll('[data-exverb]').forEach(b => b.addEventListener('click', () => {
    const row = b.closest('[data-exid]');
    const e = gtdReview.habits.experiments.awaiting.find(x => x.id === parseInt(row.dataset.exid));
    experimentVerb(e.id, b.dataset.exverb, e.content);
  }));
  panel.querySelectorAll('.gr-cb').forEach(cb => {
    cb.addEventListener('change', () => setReviewTick(cb.dataset.step, cb.checked));
  });

  const finish = document.getElementById('gr-finish');
  if (finish) {
    finish.addEventListener('click', async () => {
      finish.disabled = true;
      // The free-text path mints a real habit row (habit_week is history now);
      // the finish route no longer receives it.
      const newHabit = document.getElementById('gr-habit').value.trim();
      if (newHabit) {
        await fetch('/api/habits', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: newHabit }),
        });
      }
      await fetch('/api/gtd-review/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          week: gtdReview.week_start_date,
          note: document.getElementById('gr-note').value,
        }),
      });
      // FILING THE REVIEW IS FINISHING THE ROUTINE. Deciding you are done is
      // the same act whichever surface you say it on, so the run is completed
      // here too — otherwise the runner would still show the week as open.
      if (gtdReview.flow) {
        await fetch(`/api/flows/${gtdReview.flow.id}/run`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: formatDateYMD(new Date()),
                                 steps: reviewTicks(), completed: true }),
        });
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
  const night = await fetch(`/api/people/night?date=${flowRunView.date
    || formatDateYMD(new Date())}`).then(r => r.json()).catch(() => null);
  flowRunView.crmFilled = !!(night && night.satisfied_at);
  flowRunView.crmKind = night ? night.kind : null;
  renderFlowRun();
}

function initHub() {
  const hub = document.getElementById('hub-overlay');
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
    if (!hub.classList.contains('hidden')) { hub.classList.add('hidden'); return; }
    // (MAP has no transient layer of its own to peel any more — its rows open
    // the clarify sheet, and the bail above lets the sheet peel first.)
    // Settings peels the way it navigates (11a): sheet, then section, then the
    // panel itself — so Esc is Back, not Close, until there is nothing left.
    if (seSheet.kind) { closeSeSheet(); return; }
    // Legacy modal overlays first (they sit above the m-overlays), innermost
    // wins; the person-detail/bucket/add trio stack over People.
    for (const id of ['person-add-overlay', 'bucket-mgr-overlay', 'person-detail-overlay',
                      'map-overlay', 'logs-overlay', 'modal-overlay']) {
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
      else if (dest === 'gtd') { openM('tab-gtd'); refreshGtd(); }
      else if (dest === 'lists') {
        refView.open = null;
        refView.openFlow = null;
        openM('tab-lists');
        refreshRef();
      }
      else if (dest === 'map') { openMap(); }
      else if (dest === 'people') { openM('tab-people'); openPeopleSurface(); }
      else if (dest === 'journal') { openM('tab-journal'); renderJournal(); }
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

const logsView = { logs: [], open: null, content: '', dirty: false, saveTimer: null, desc: false };

// Logs are named "YY-M-D topic", so name order IS date order — one direction
// toggle covers both "oldest first" and "newest first". Session-local, like
// the other view filters.
function sortedLogs() {
  const rows = logsView.logs.slice().sort((a, b) => a.name.localeCompare(b.name));
  return logsView.desc ? rows.reverse() : rows;
}

function initLogsView() {
  const overlay = document.getElementById('logs-overlay');
  document.getElementById('logs-close').addEventListener('click', closeLogsView);
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
  const today = formatDateYMD(new Date());
  const [lists, flows, schedules] = await Promise.all([
    fetch('/api/ref').then(r => r.json()).catch(() => refView.lists),
    fetch(`/api/flows?date=${today}`).then(r => r.json()).catch(() => refView.flows),
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
function flowWindow(f) {
  if (!f || !f.source_uid) return null;
  const src = (state.schedules || []).find(s => s.uid === f.source_uid);
  const iv = src && (src.intervals || [])[0];
  if (!iv) return null;
  const open = timeToMinutes(iv.start);
  let due = timeToMinutes(iv.end);
  if (iv.into_next || due < open) due += 1440;   // past midnight, same rule as a gate
  return { open, due };
}

function flowWindowLabel(f) {
  const w = flowWindow(f);
  if (!w) return null;
  return `${minutesToHHMM(w.open % 1440)}–${minutesToHHMM(Math.round(w.due) % 1440)}`;
}

function flowDueMin(f) {
  // Its own window wins where set; the gate-derived deadline is the fallback,
  // so every routine written before this keeps answering the same way.
  const own = flowWindow(f);
  if (own) return own.due;
  const nodeId = f.before_node_id || f.qr_node_id;
  if (!nodeId) return null;
  const n = (state.accountabilityNodes || []).find(x => x.id === nodeId);
  if (!n) return null;
  const dow = jsDateToDayOfWeek(new Date());
  const ov = n.today_override;
  const def = nodeWindowForDow(n, dow);
  const end = ov ? ov.window_end : def.window_end;
  const off = ov ? (ov.window_end_offset_days || 0) : (def.window_end_offset_days || 0);
  let m = timeToMinutes(end) + (off ? 1440 : 0);
  if (!f.before_node_id && f.offset_min) m += f.offset_min;
  return m;
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
      const todaySteps = f.steps.filter(s => stepDueToday(s)).length;
      return `<div class="ref-row" data-flow="${f.id}">
        <span class="ref-name" title="Tap to edit steps · double-click to rename">${escHtml(f.name)}</span>
        ${due != null ? `<span class="fr-due">${done ? '✓ done'
          : (flowWindowLabel(f) || 'due ' + minutesToHHMM(Math.round(due) % 1440))}</span>`
          : done ? '<span class="fr-due">✓ done</span>' : ''}
        <span class="map-count" title="${todaySteps} of ${f.steps.length} steps run today">${todaySteps}${
          todaySteps === f.steps.length ? '' : `<span class="fr-of">/${f.steps.length}</span>`}</span>
        <button class="fr-play" data-flow="${f.id}" title="Run this routine">▶</button>
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
          await fetch(`/api/flows/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          pushUndo(`renamed routine to "${name}"`, async () => {
            await fetch(`/api/flows/${id}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: was }),
            });
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
      const created = await fetch('/api/flows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New routine' }),
      }).then(r => r.json());
      pushUndo(`created routine "${created.name}"`, async () => {
        await fetch(`/api/flows/${created.id}`, { method: 'DELETE' });
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
        const created = await fetch('/api/ref/lists', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }).then(r => r.json());
        pushUndo(`created list "${name}"`, async () => {
          await fetch(`/api/ref/lists/${created.id}`, { method: 'DELETE' });
          await refreshAfterUndo();
        });
        refView.open = created.id;
        await refreshRef();
      },
    }));
    body.querySelectorAll('[data-flow-del]').forEach(b => b.addEventListener('click', async () => {
      const id = parseInt(b.dataset.flowDel);
      const f = refView.flows.find(x => x.id === id);
      await fetch(`/api/flows/${id}`, { method: 'DELETE' });
      pushUndo(`deleted routine "${f.name}"`, async () => {
        const nf = await fetch('/api/flows', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.name }),
        }).then(r => r.json());
        for (const s of f.steps) {
          await fetch(`/api/flows/${nf.id}/steps`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: s.content, kind: s.kind, requirement: s.requirement }),
          });
        }
        await refreshAfterUndo();
      });
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
          fetch(`/api/ref/lists/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          }));
      });
    });
    // [data-id] again: the routine rows' × carries data-flow-del and is wired
    // above — unscoped, this handler also fired there and tried to DELETE
    // /api/ref/lists/NaN.
    body.querySelectorAll('.ref-del[data-id]').forEach(b => b.addEventListener('click', async () => {
      const id = parseInt(b.dataset.id);
      const l = refView.lists.find(x => x.id === id);
      await fetch(`/api/ref/lists/${id}`, { method: 'DELETE' });
      // Recreate replays name + items; new ids are fine — nothing references
      // a ref id from outside (unlike inbox restore).
      pushUndo(`deleted list "${l.name}"`, async () => {
        const nl = await fetch('/api/ref/lists', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: l.name }),
        }).then(r => r.json());
        for (const it of l.items) {
          await fetch('/api/ref/items', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ list_id: nl.id, content: it.content, done: it.done }),
          });
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
      const created = await fetch('/api/ref/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list_id: open.id, content: raw }),
      }).then(r => r.json());
      pushUndo(`added "${raw}" to ${open.name}`, async () => {
        await fetch(`/api/ref/items/${created.id}`, { method: 'DELETE' });
        await refreshAfterUndo();
      });
      await refreshRef();
    },
  }));
  document.getElementById('ref-add-sub').addEventListener('click', () => openEntrySheet({
    title: `List inside ${open.name}`, placeholder: 'Name the list…', button: 'Create',
    closeOnAdd: true,
    add: async name => {
      const created = await fetch('/api/ref/lists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parent_id: open.id }),
      }).then(r => r.json());
      pushUndo(`created list "${name}" in ${open.name}`, async () => {
        await fetch(`/api/ref/lists/${created.id}`, { method: 'DELETE' });
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
        fetch(`/api/ref/lists/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }));
    });
  });
  body.querySelectorAll('.ref-del[data-id]').forEach(b => b.addEventListener('click', async () => {
    const id = parseInt(b.dataset.id);
    const l = refView.lists.find(x => x.id === id);
    await fetch(`/api/ref/lists/${id}`, { method: 'DELETE' });
    pushUndo(`deleted list "${l.name}"`, async () => {
      const nl = await fetch('/api/ref/lists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: l.name, parent_id: l.parent_id }),
      }).then(r => r.json());
      for (const it of l.items) {
        await fetch('/api/ref/items', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ list_id: nl.id, content: it.content, done: it.done }),
        });
      }
      await refreshAfterUndo();
    });
    await refreshRef();
  }));
  body.querySelectorAll('.ref-check').forEach(c => c.addEventListener('click', async () => {
    const id = parseInt(c.dataset.item);
    const it = open.items.find(x => x.id === id);
    const to = it.done ? 0 : 1;
    await fetch(`/api/ref/items/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: to }),
    });
    pushUndo(`${to ? 'checked' : 'unchecked'} "${it.content}"`, async () => {
      await fetch(`/api/ref/items/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: it.done }),
      });
      await refreshAfterUndo();
    });
    await refreshRef();
  }));
  body.querySelectorAll('.ref-row[data-item] .ref-text').forEach(span => {
    span.addEventListener('dblclick', () => {
      const id = parseInt(span.closest('.ref-row').dataset.item);
      refRenameEl(span, async content => {
        await fetch(`/api/ref/items/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        await refreshRef();
      });
    });
  });
  body.querySelectorAll('.ref-del[data-item]').forEach(b => b.addEventListener('click', async () => {
    const id = parseInt(b.dataset.item);
    const it = open.items.find(x => x.id === id);
    await fetch(`/api/ref/items/${id}`, { method: 'DELETE' });
    pushUndo(`removed "${it.content}"`, async () => {
      await fetch('/api/ref/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list_id: open.id, content: it.content, done: it.done }),
      });
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

function stepPending(s) {
  if (!s.pending) return null;
  try { return typeof s.pending === 'string' ? JSON.parse(s.pending) : s.pending; }
  catch { return null; }
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
    <div class="ref-list">${f.steps.map((s, i) => `
      <div class="ref-row${stepDueToday(s) ? '' : ' fr-step-off'}" data-step="${s.id}">
        <span class="cl-chain-n">${i + 1}</span>
        <span class="ref-text${stepShowsText(s) ? '' : ' fr-feature'}"
          title="${stepShowsText(s) ? 'Double-click to rewrite' : stepKindLabel(s)}">${
          stepShowsText(s) ? escHtml(s.content) : '⚙ ' + stepKindLabel(s)}</span>
        ${stepBadges(s)}
        <button class="fr-up" data-step="${s.id}" title="Move up">↑</button>
        <button class="fr-down" data-step="${s.id}" title="Move down">↓</button>
        <button class="fr-open" data-step="${s.id}" title="Settings for this step">›</button>
      </div>`).join('')
      || '<div class="gtd-empty">No steps yet.</div>'}
    <button id="fr-add-step" class="map-add-btn">+ step</button></div>
    <button class="fr-play fr-play-big" data-flow="${f.id}">▶ Run</button>`;

  body.querySelector('#fr-add-step').addEventListener('click', () => openEntrySheet({
    title: `${f.name} · add step`, placeholder: 'What is the step?',
    add: async raw => {
      const created = await fetch(`/api/flows/${f.id}/steps`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: raw }),
      }).then(r => r.json());
      pushUndo(`added step "${raw}"`, async () => {
        await fetch(`/api/flow-steps/${created.id}`, { method: 'DELETE' });
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
    await fetch(`/api/flows/${f.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
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
      await fetch(`/api/flow-steps/${a.id}`, { method: 'PATCH',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: a.position }) });
      await fetch(`/api/flow-steps/${b.id}`, { method: 'PATCH',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: b.position }) });
      await refreshAfterUndo();
    });
    await fetch(`/api/flow-steps/${a.id}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: b.position }) });
    await fetch(`/api/flow-steps/${b.id}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: a.position }) });
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
        await fetch(`/api/flow-steps/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: v }),
        });
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
  if (s.requirement === 'soft') out.push('<span class="fr-badge">soft</span>');
  if (s.kind === 'checklist') out.push('<span class="fr-badge">☰</span>');
  const p = stepPending(s);
  if (p) out.push(`<span class="fr-badge fr-badge-pending" title="A gated routine eases on a 24h delay">${
    p.field === 'delete' ? 'removes' : p.field === 'requirement' ? 'soft' : 'days'} in ${pendingHours(p)}h</span>`);
  return out.join('');
}

function stepSheetFind() {
  for (const f of refView.flows) {
    const s = (f.steps || []).find(x => x.id === stepSheet.id);
    if (s) return { f, s };
  }
  return null;
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
    await fetch(`/api/flow-steps/${s.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prev),
    });
    await refreshAfterUndo();
  });
  await fetch(`/api/flow-steps/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
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
    ${s.requirement === 'soft' || (stepPending(s) || {}).field === 'requirement' ? `
    <div class="cl-row">
      <input type="text" class="cl-action" id="fr-sheet-soft"
        placeholder="Name the smaller version (optional)"
        value="${escHtml(s.soft_content || '')}"
        title="Shown on the runner's soft button, so 'a smaller version' is a decision made now, not at 11pm">
    </div>` : ''}
    ${stepPending(s) ? `
    <div class="cl-row fr-pending-row">
      <span class="cl-hint">⏳ ${stepPending(s).field === 'delete' ? 'removal lands'
        : stepPending(s).field === 'requirement' ? 'goes soft'
        : 'day change lands'} in ${pendingHours(stepPending(s))}h — a gated routine eases on a 24h delay</span>
      <button class="cl-pill" id="fr-sheet-unpend">Cancel</button>
    </div>` : ''}

    <div class="cl-sec"><span class="cl-label">Runs on</span></div>
    <div class="cl-chips fr-sheet-days">
      ${DAY_LETTERS.map((d, n) => `<button class="fr-day${lit(n) ? ' fr-day-on' : ''}"
        data-dow="${n}" title="${DAY_NAMES[n]}">${d}</button>`).join('')}
      <span class="cl-hint">${s.days_of_week
        ? 'only the lit days' : 'every day'}</span>
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
    await fetch(`/api/flow-steps/${s.id}/pending`, { method: 'DELETE' });
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
    const res = await fetch(`/api/flow-steps/${s.id}`, { method: 'DELETE' })
      .then(r => r.json()).catch(() => ({}));
    if (res.pending) {
      // The 24h easing gate deferred it — the undo is the CANCEL, and the
      // sheet stays open showing the pending state.
      pushUndo(`scheduled removal of "${s.content || stepKindLabel(s)}"`, async () => {
        await fetch(`/api/flow-steps/${s.id}/pending`, { method: 'DELETE' });
        await refreshAfterUndo();
      });
      toast('A gated routine eases on a 24h delay — removal is scheduled');
      await refreshRef();
      renderStepSheet();
      return;
    }
    pushUndo(`removed "${s.content || stepKindLabel(s)}"`, async () => {
      await fetch(`/api/flows/${f.id}/steps`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: s.content, kind: s.kind,
                               requirement: s.requirement, days_of_week: s.days_of_week }),
      });
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
        value="${escHtml(formatDateYMD(state.currentDate))}">
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
    const resp = await fetch('/api/gcal/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary, date, start, end: end || null }),
    });
    const created = await resp.json();
    // The sheet stays open on failure — the config-missing message has to be
    // readable, and closing would throw the typed event away with it.
    if (!resp.ok) { toast(created.error || 'Google refused the write'); return; }
    // Times have no natural sort, so the sheet remembers the ones you use —
    // the chips above the When row (see recentBump).
    recentBump('evtime', start + '|' + (end || ''));
    pushUndo(`added event "${summary}"`, async () => {
      const r = await fetch(`/api/gcal/events/${encodeURIComponent(created.event_id)}`
        + `?uid=${encodeURIComponent(created.uid)}`, { method: 'DELETE' });
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
const entrySheet = { open: false, spec: null };

function openEntrySheet(spec) {
  entrySheet.open = true;
  entrySheet.spec = spec;
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
    <div class="cl-row">
      <button class="cl-pill" id="en-add">${escHtml(spec.button || 'Add')}</button>
      <button class="cl-pill" id="en-done">Done</button>
    </div>`;

  const input = sheet.querySelector('#en-input');
  const add = async () => {
    const raw = input.value.trim();
    if (!raw) { closeEntrySheet(); return; }   // empty Enter = done
    input.value = '';
    await spec.add(raw);
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
                      refLists: [], checks: {} };

async function openFlowRun(flowId) {
  const today = formatDateYMD(new Date());
  const [flows, day, journal, habits, refLists, crmNight] = await Promise.all([
    fetch(`/api/flows?date=${today}`).then(r => r.json()).catch(() => []),
    fetch(`/api/social/day?date=${today}`).then(r => r.json()).catch(() => null),
    fetch('/api/journal').then(r => r.json()).catch(() => null),
    fetch('/api/habits').then(r => r.json()).catch(() => null),
    fetch('/api/ref').then(r => r.json()).catch(() => []),
    fetch(`/api/people/night?date=${today}`).then(r => r.json()).catch(() => null),
  ]);
  flowRunView.refLists = refLists;
  flowRunView.checks = {};
  const flow = flows.find(f => f.id === flowId);
  if (!flow) return;
  // THE RUN IS TODAY'S STEPS. `due` is the server's answer (storage.step_due_on
  // — one weekday convention for the whole app), and narrowing the flow here
  // rather than at each use means resume, progress and above all COMPLETION
  // are all about today: a Sunday-only step must not hold a Tuesday's gate open.
  const steps = flow.steps.filter(s => s.due);
  if (!steps.length) {
    toast(flow.steps.length ? 'Nothing in this routine today' : 'No steps in this routine');
    return;
  }
  flowRunView.flow = { ...flow, steps };
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
  const today = flowRunView.date || formatDateYMD(new Date());
  flowRunView.steps[step.id] = how;
  const complete = flowRunView.flow.steps.every(s => flowRunView.steps[s.id]);
  await fetch(`/api/flows/${flowRunView.flow.id}/run`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: today, steps: flowRunView.steps, completed: complete }),
  });
  if (complete) {
    toast(`${flowRunView.flow.name} complete ✓`);
    closeFlowRun();
    return;
  }
  const next = flowRunView.flow.steps.findIndex(s => !flowRunView.steps[s.id]);
  flowRunView.idx = next === -1 ? flowRunView.idx : next;
  renderFlowRun();
}

function flowName(flowId) {
  const f = (engageView.flows || []).find(x => x.id === flowId)
    || (refView.flows || []).find(x => x.id === flowId);
  return f ? f.name : 'the later routine';
}

// Pawning is a DAY-level act: the step leaves today's routine, joins the later
// one, and takes its minutes with it — so that routine's gate closes earlier. It
// is deliberately not undoable through the undo stack (the config surfaces are
// not either); taking it back is the same button on the other side.
async function pawnStep(step) {
  const res = await fetch(`/api/flow-steps/${step.id}/pawn`, { method: 'POST' });
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
  await fetch(`/api/flow-steps/${step.id}/pawn`, { method: 'DELETE' });
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
        placeholder="What do you want to do better tomorrow?">${escHtml(j.bottleneck || '')}</textarea>
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
            and never queues it. */''}
      <div class="fr-exp">
        <div class="fr-exp-head">${running ? 'Tomorrow’s experiment' : 'Start an experiment'}</div>
        ${running ? `
          <input type="text" id="fr-exp-edit" class="cl-action" value="${escHtml(running.content)}"
            title="Reword it and press keep — same variable, said better">
          <div class="cl-row">
            <button class="cl-pill" id="fr-exp-keep">Keep it running</button>
            <button class="cl-pill" id="fr-exp-grad">End it → weekly review</button>
            <button class="cl-pill" id="fr-exp-drop">End it → drop</button>
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
  } else if (REVIEW_KINDS[s.kind]) {
    // A REVIEW STEP. Two of the eleven have a surface to open from here; the
    // other nine state the step and take the tick, which is what the fold-out
    // gave them and no less. They get their pages one at a time, deliberately —
    // a page that only repeats its own label is not worth an endpoint.
    const meta = REVIEW_KINDS[s.kind];
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
        ? '<button id="fr-rv-sweep" class="cl-pill">▶ 5-minute sweep</button>'
        : ''}`;
  } else {
    // An unknown kind must still be a page you can get past — a blank one would
    // strand the run (and, on a gated routine, the gate).
    page = `<div class="fr-step-big">${escHtml(s.content || stepKindLabel(s))}</div>`;
  }

  el.innerHTML = `
    <div class="fr-head">
      <span class="fr-title">${escHtml(f.name)}</span>
      <span class="fr-meta">${flowRunView.idx + 1}/${f.steps.length}${
        due != null ? ` · due ${minutesToHHMM(Math.round(due) % 1440)}` : ''}</span>
      <button class="modal-close-btn" id="fr-close">✕</button>
    </div>
    <div class="fr-page">${page}${credited ? '<div class="fr-note">✓ already credited</div>' : ''}
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
      <button id="fr-done" class="cl-pill cl-pill-on"${
        s.requirement !== 'soft'
          && ((s.kind === 'social_spec' && day.specOk !== true)
              || (s.kind === 'social_dose' && day.doseCleared !== true))
          ? ' disabled' : ''}>Done ✓</button>
    </div>`;
  el.classList.remove('hidden');

  el.querySelector('#fr-close').addEventListener('click', closeFlowRun);
  el.querySelector('#fr-back').addEventListener('click', () => {
    if (flowRunView.idx > 0) { flowRunView.idx--; renderFlowRun(); }
  });
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
  const pawn = el.querySelector('#fr-pawn');
  if (pawn) pawn.addEventListener('click', () => pawnStep(s));
  const unpawn = el.querySelector('#fr-unpawn');
  if (unpawn) unpawn.addEventListener('click', () => unpawnStep(s));
  // The two review steps that are a DOING, not a ticking — the same two acts
  // the GTD fold-out offers, from the same registry. The runner closes first:
  // both open a full-screen surface of their own, and one over the other would
  // be two layers deep with no way back.
  const rvClarify = el.querySelector('#fr-rv-clarify');
  if (rvClarify) rvClarify.addEventListener('click', () => { closeFlowRun(); openClarify(); });
  const rvSweep = el.querySelector('#fr-rv-sweep');
  if (rvSweep) rvSweep.addEventListener('click', () => {
    const iso = formatDateYMD(new Date());
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
        const body = { date: formatDateYMD(new Date()) };
        if (mark) body.mark = mark.dataset.mark;
        if (eff) body.effort = eff.dataset.effort;
        await fetch(`/api/habits/${r.dataset.habit}/mark`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
    }
    if (s.kind === 'journal_night') {
      // The run's day, not the clock's — the night's entry belongs to the night
      // even when it is written after midnight (same rule as creditFlowStep).
      const today = flowRunView.date || formatDateYMD(new Date());
      const rate = el.querySelector('.fr-rate-on');
      await fetch(`/api/journal/${today}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bottleneck: el.querySelector('#fr-jn-bottleneck').value,
          active_experiment: el.querySelector('#fr-jn-exp').value,
          rating: rate ? parseInt(rate.dataset.rate) : null,
        }),
      });
    }
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
  const expRefresh = async () => {
    flowRunView.habits = await fetch('/api/habits').then(r => r.json())
      .catch(() => flowRunView.habits);
    renderFlowRun();
  };
  const expStart = el.querySelector('#fr-exp-start');
  if (expStart) expStart.addEventListener('click', async () => {
    const content = el.querySelector('#fr-exp-new').value.trim();
    if (!content) { toast('Name the experiment first'); return; }
    const res = await fetch('/api/habit-experiments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) { toast((await res.json()).error || 'could not start it'); return; }
    const made = await res.json();
    pushUndo(`started the experiment "${content}"`, async () => {
      // Undoing a start closes it outright rather than queueing it: it never
      // ran, so there is nothing for the review to judge.
      await fetch(`/api/habit-experiments/${made.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution: 'undone', outcome: 'drop' }),
      });
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
    await fetch(`/api/habit-experiments/${expRunning.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: next }),
    });
    pushUndo(`reworded the experiment`, async () => {
      await fetch(`/api/habit-experiments/${expRunning.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: was }),
      });
      await expRefresh();
    });
    toast('reworded — still running');
    await expRefresh();
  });
  const expEnd = async drop => {
    // The resolution is the EVIDENCE the review judges, so it is written now
    // rather than reconstructed a week later. Dropping still asks for it: the
    // ledger is the point even when the answer was no.
    const note = prompt(drop ? 'Why drop it? One line for the ledger.'
                             : 'How did it resolve? One line for the review.');
    if (note == null) return;
    const body = { resolution: note };
    if (drop) body.outcome = 'drop';
    const res = await fetch(`/api/habit-experiments/${expRunning.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { toast((await res.json()).error || 'could not end it'); return; }
    pushUndo(drop ? 'dropped the experiment' : 'sent the experiment to the review', async () => {
      // One call whichever end it was: reopen wipes the resolution, any
      // evaluation, and any habit the promotion minted.
      const r = await fetch(`/api/habit-experiments/${expRunning.id}/reopen`, { method: 'POST' });
      if (!r.ok) toast((await r.json()).error || 'could not reopen it');
      await expRefresh();
    });
    toast(drop ? 'dropped' : 'waiting for the weekly review');
    await expRefresh();
  };
  const expGrad = el.querySelector('#fr-exp-grad');
  if (expGrad) expGrad.addEventListener('click', () => expEnd(false));
  const expDrop = el.querySelector('#fr-exp-drop');
  if (expDrop) expDrop.addEventListener('click', () => expEnd(true));

  el.querySelectorAll('[data-dset]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('[data-dtag]');
    const tag = row.dataset.dtag;
    const want = b.dataset.dset === 'yes';
    const prev = ((state.tagDaily || {}).answers || {})[tag];
    // Tapping the answer you already gave clears it — back to unanswered, which
    // excludes nothing. That is the only way to undo a "not today" in place.
    const applies = prev === want ? null : want;
    const answers = await fetch('/api/tag-daily/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, applies }),
    }).then(r => r.json()).catch(() => null);
    if (answers) state.tagDaily = { ...state.tagDaily, answers };
    pushUndo(`set ${tag} ${applies === null ? 'unanswered' : applies ? 'today' : 'not today'}`,
      async () => {
        const back = await fetch('/api/tag-daily/answer', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag, applies: prev === undefined ? null : prev }),
        }).then(r => r.json()).catch(() => null);
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
    const today = formatDateYMD(new Date());
    await fetch('/api/people/night', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'entries', date: today }),
    });
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
  await fetch(`/api/logs/${encodeURIComponent(logsView.open)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: ta.value }),
  });
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
  const log = await fetch('/api/logs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(r => r.json());
  const body = text;
  await fetch(`/api/logs/${encodeURIComponent(log.name)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: body }),
  });
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

function renderLogs() {
  const body = document.getElementById('logs-body');
  const title = document.getElementById('logs-title');
  if (!body) return;
  if (!logsView.open) {
    title.textContent = 'Logs';
    const rows = sortedLogs().map(l => `
      <button class="log-row" data-name="${escHtml(l.name)}">
        <span class="log-row-name">${escHtml(l.name)}</span>
        <span class="log-row-date">${new Date(l.updated_at).toLocaleDateString()}</span>
      </button>`).join('');
    body.innerHTML = `
      <div class="log-list-bar">
        <button id="log-sort" class="log-sort-btn"
          title="Sorted by name — for the YY-M-D logs that is ${logsView.desc ? 'newest' : 'oldest'} first">
          ${logsView.desc ? 'Z → A ↓' : 'A → Z ↑'}
        </button>
      </div>
      <div class="log-list">${rows || '<div class="log-empty">No logs yet</div>'}</div>
      <button id="log-new" class="map-add-btn">+ log</button>
      <button id="log-dangerous" class="dw-entry" title="Stop typing and the draft is destroyed">⚡ Dangerous writing</button>`;
    body.querySelectorAll('.log-row').forEach(row => {
      row.addEventListener('click', () => openLog(row.dataset.name));
    });
    document.getElementById('log-dangerous')
      .addEventListener('click', openDangerousWriting);
    const d = new Date();
    document.getElementById('log-new').addEventListener('click', () => openEntrySheet({
      title: 'New log',
      placeholder: `${d.getFullYear() % 100}-${d.getMonth() + 1}-${d.getDate()} topic…`,
      button: 'Create', closeOnAdd: true,
      add: async raw => {
        const log = await fetch('/api/logs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: raw }),
        }).then(r => r.json());
        logsView.open = log.name;
        logsView.content = log.content;
        logsView.dirty = false;
        renderLogs();
      },
    }));
    document.getElementById('log-sort').addEventListener('click', () => {
      logsView.desc = !logsView.desc;
      renderLogs();
      document.getElementById('logs-body').scrollTop = 0;
    });
    return;
  }

  title.textContent = logsView.open;
  body.innerHTML = `
    <div class="log-editor-bar">
      <button id="log-back" class="log-back-btn">‹ All logs</button>
      <span id="log-save-status" class="log-save-status"></span>
    </div>
    <div class="log-editor-wrap">
      <div id="log-highlight" class="log-highlight" aria-hidden="true"></div>
      <textarea id="log-editor" class="log-editor" spellcheck="false"></textarea>
    </div>`;
  const ta = document.getElementById('log-editor');
  ta.value = logsView.content;
  updateLogHighlight();
  ta.addEventListener('input', () => {
    updateLogHighlight();
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
  socialView.day = await fetch('/api/social/day').then(r => r.json()).catch(() => socialView.day);
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
    fetch('/api/social').then(r => r.json()).catch(() => socialView.config),
    fetch('/api/social/day').then(r => r.json()).catch(() => socialView.day),
    fetch('/api/engage/day').then(r => r.json()).catch(() => null),
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
    await fetch(`/api/social/levels/${inp.dataset.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: v }),
    });
    await refreshSocial();
  }));

  body.querySelectorAll('.so-anchor .so-lvl').forEach(b => b.addEventListener('click', async () => {
    const next = { ...(socialView.config.anchor || {}) };
    next[b.dataset.axis] = parseInt(b.dataset.id);
    if (next.warmth && next.medium && next.ask) {
      await fetch('/api/social/anchor', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
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
  const respec = s => fetch('/api/social/specs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.id, date: s.date, family: s.family, levels: s.levels,
                           person: s.person, opener: s.opener, price: s.price }),
  });
  body.querySelectorAll('.so-spec-edit').forEach(b => b.addEventListener('click', () => {
    const s = specById(b.dataset.spec);
    socialView.form = { intent: 'spec', editId: s.id, family: s.family,
                        levels: { ...s.levels }, person: s.person, opener: s.opener };
    renderSocial();
  }));
  body.querySelectorAll('.so-spec-did').forEach(b => b.addEventListener('click', async () => {
    const s = specById(b.dataset.spec);
    const rep = await fetch('/api/social/reps', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: s.family, levels: s.levels, person: s.person, planned: 1 }),
    }).then(r => r.json());
    pushUndo(`logged the spec'd rep (+${rep.price})`, async () => {
      await fetch(`/api/social/reps/${rep.id}`, { method: 'DELETE' });
      await refreshSocialIfOpen();
    });
    await refreshSocial();
  }));
  body.querySelectorAll('.so-spec-del').forEach(b => b.addEventListener('click', async () => {
    const s = specById(b.dataset.spec);
    await fetch(`/api/social/specs/${s.id}`, { method: 'DELETE' });
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
        const spec = await fetch('/api/social/specs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ family: f.family, levels: f.levels,
                                 person: f.person, opener: f.opener }),
        }).then(r => r.json());
        if (spec.error) return;
        if (prev) await fetch(`/api/social/specs/${prev.id}`, { method: 'DELETE' });
        pushUndo(prev ? 'replaced a planned interaction' : 'planned an interaction', async () => {
          await fetch(`/api/social/specs/${spec.id}`, { method: 'DELETE' });
          if (prev) await respec(prev);
          await refreshSocialIfOpen();
        });
      } else {
        const rep = await fetch('/api/social/reps', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ family: f.family, levels: f.levels, person: f.person,
                                 pre_rating: f.pre === '' || f.pre == null ? null
                                   : Math.max(0, Math.min(10, parseInt(f.pre) || 0)) }),
        }).then(r => r.json());
        if (rep.error) return;
        pushUndo(`logged social rep (+${rep.price})`, async () => {
          await fetch(`/api/social/reps/${rep.id}`, { method: 'DELETE' });
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
    const rep = await fetch('/api/social/reps', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: 'micro', levels: { micro: parseInt(b.dataset.id) } }),
    }).then(r => r.json());
    if (rep.error) return;
    pushUndo(`logged "${socialShortLabel(rep.levels.micro)}" (+${rep.price})`, async () => {
      await fetch(`/api/social/reps/${rep.id}`, { method: 'DELETE' });
      await refreshSocialIfOpen();
    });
    await refreshSocial();
  }));

  body.querySelectorAll('.so-del').forEach(b => b.addEventListener('click', async () => {
    const id = parseInt(b.dataset.id);
    const rep = (socialView.day.reps || []).find(r => r.id === id);
    await fetch(`/api/social/reps/${id}`, { method: 'DELETE' });
    // Replay verbatim — id and stamped price included, so undo can't reprice.
    pushUndo(`removed rep (${rep ? '+' + rep.price : ''})`, async () => {
      await fetch('/api/social/reps', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rep),
      });
      await refreshSocialIfOpen();
    });
    await refreshSocial();
  }));
}


// ── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
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
  setInterval(() => { checkDayRollover(); checkActiveBlock(); }, 60000);
});

// ── Accountability ────────────────────────────────────────────

function renderQrLayer() {
  const layer = document.getElementById('tl-qr-layer');
  if (!layer) return;
  layer.innerHTML = '';
  const nodes = (state.accountabilityNodes || []).filter(n => n.active);
  if (!nodes.length) return;

  const body = document.getElementById('tl-body');
  const pageDate = formatDateYMD(state.currentDate);
  const viewingToday = isToday(state.currentDate);
  const pageDow = String((state.currentDate.getDay() + 6) % 7);

  nodes.forEach(node => {
    if (node.days_of_week != null && !String(node.days_of_week).includes(pageDow)) return;
    // today_override from the API is only for the Worker's local today.
    // For other dates, use the client-side cache populated by drag saves.
    const cacheKey = `${node.id}:${pageDate}`;
    if (state.tlHidden.qr[cacheKey]) return;
    const ov = viewingToday ? node.today_override : (state.qrPageOverrides[cacheKey] || null);
    const def = nodeWindowForDow(node, pageDow);
    const windowStart = ov ? ov.window_start : def.window_start;
    const windowEnd = ov ? ov.window_end : def.window_end;
    const offsetDays = ov ? ov.window_end_offset_days : def.window_end_offset_days;

    // ±12h drag bounds in semantic minutes: a +1d deadline counts as end + 1440,
    // so dragging preserves the offset and can cross midnight in either direction
    const originalMinutes = timeToMinutes(windowEnd) + (offsetDays ? 1440 : 0);
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
    const dismissed = !locked && !!state.qrDismissed[cacheKey];

    const line = document.createElement('div');
    // outcome colors the pill for judged (closed) windows: green/red
    const outcome = state.qrOutcomes[cacheKey];
    line.className = 'tl-qr-line' + (locked ? ' tl-qr-locked' : '') + (dismissed ? ' tl-qr-dismissed' : '')
      + (outcome ? ` tl-qr-${outcome}` : '');
    line.style.top = `${pct}%`;

    const label = document.createElement('span');
    label.className = 'tl-qr-label';
    const labelText = document.createElement('span');
    labelText.textContent = `${node.label} ${windowEnd}${offsetDays ? ' +1d' : ''}${locked ? ' 🔒︎' : ''}`;
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
    if (locked) return;

    const xBtn = document.createElement('button');
    xBtn.className = 'tl-qr-x';
    xBtn.textContent = '✕';
    xBtn.title = dismissed ? 'Restore' : 'Gray out for this day';
    label.appendChild(xBtn);

    // pointerdown, not mousedown: the pill's drag starts on pointerdown now, so
    // a mousedown guard would no longer keep pressing ✕ from grabbing the pill.
    xBtn.addEventListener('pointerdown', e => e.stopPropagation());
    xBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (state.qrDismissed[cacheKey]) delete state.qrDismissed[cacheKey];
      else state.qrDismissed[cacheKey] = true;
      renderQrLayer();
    });

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
      const nextDay = mins >= 1440;
      labelText.textContent = `${node.label} ${minutesToHHMM(mins % 1440)}${nextDay ? ' +1d' : ''}`;
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
      if (Math.abs(clientY - dragStartY) < (touch ? 1 : 5)) {
        if (e && e.button === 2 && !touch) {
          hideTimelineItem('qr', cacheKey, node.label);
        }
        renderQrLayer();
        return;
      }

      const mins = calcMinutes(clientY);
      const newOffsetDays = mins >= 1440 ? 1 : 0;
      const newEnd = minutesToHHMM(mins % 1440);

      if (newEnd === windowEnd && newOffsetDays === offsetDays) return;

      const ovBody = {
        date: pageDate,
        window_start: windowStart,
        window_end: newEnd,
        window_end_offset_days: newOffsetDays,
      };
      const res = await fetch(`/api/accountability/nodes/${node.id}/overrides`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ovBody),
      });
      if (res.ok) {
        // Cache the override so non-today pages stay in the right position on re-render
        state.qrPageOverrides[cacheKey] = ovBody;
        if (viewingToday) {
          state.accountabilityNodes = await fetch('/api/accountability/nodes').then(r => r.json()).catch(() => state.accountabilityNodes);
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

function nodeSourceWindowForDow(node, dow) {
  const days = node.day_windows;
  if (!days) return null;
  for (const date of Object.keys(days).sort()) {
    // Mon=0..Sun=6, matching qr_judge._dow_of and weekly_windows' keys.
    const jsDow = new Date(date + 'T12:00:00').getDay();
    if ((jsDow + 6) % 7 === Number(dow)) return days[date];
  }
  return null;
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
      fetch('/api/flows').then(r => r.json()).catch(() => []),
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
        state.settings = await fetch('/api/settings', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: value }),
        }).then(r => r.json());
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
  geofence_radius_m: 'radius', weekly_windows: 'per-day times', active: 'state',
  source_uid: 'schedule', __delete__: 'delete gate',
};

const GATE_REASONS = {
  absent: 'no scan',
  no_scan: 'no scan',
  geofence: 'scanned somewhere else',
  geofence_fail: 'scanned somewhere else',
  routine_incomplete: 'routine not done',
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
      await fetch('/api/gates/billing', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gate_charging_live: mode !== 'off',
          gate_charge_dryrun: mode !== 'live',
        }),
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
  const st = n.today_state || {};
  let today = '';
  if (st.judged) {
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
  const res = await fetch(`/api/accountability/nodes/${nodeId}/overrides/${date}`, { method: 'DELETE' });
  if (!res.ok) alert(`Remove override failed (${res.status}): ${await res.text()}`);
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
  const refresh = document.getElementById('journal-refresh');
  if (refresh) refresh.addEventListener('click', () => renderJournal());
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

// ── Journal (dashboard mirror of the sleep-gate nightly fill) ────
const journalView = { table: null, ready: false, pending: null, habit: null };
const RATING_OPTS = { '': '—', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7' };
const HABIT_MARK_OPTS = { '': '—', ehh: 'Ehh', good: 'Good', great: 'Great' };

async function renderJournal() {
  await loadJournalData();
}
window.renderJournal = renderJournal;

// Opening the tab pulls phone-written entries from the Worker (a no-op merge if
// the Worker is unconfigured/unreachable) and renders the merged local view.
async function loadJournalData() {
  const data = await fetch('/api/journal/sync', { method: 'POST' }).then(r => r.json())
    .catch(() => null)
    || await fetch('/api/journal').then(r => r.json()).catch(() => ({ days: [], habit: null }));
  journalView.habit = data.habit;
  renderJournalHabit(await fetch('/api/habits').then(r => r.json()).catch(() => null));
  renderJournalCards(data.days || []);
}

// Day cards: the two textareas + rating/habit selects, PATCH on change.
function renderJournalCards(days) {
  const grid = document.getElementById('journal-grid');
  if (!grid) return;
  const sorted = days.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const sel = (field, opts, val) => `<select class="jn-sel" data-field="${field}">${
    Object.entries(opts).map(([v, label]) =>
      `<option value="${v}"${String(val ?? '') === v ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
  grid.innerHTML = sorted.map(d => `
    <div class="jn-card" data-date="${escHtml(d.date)}">
      <div class="jn-head">
        <span class="jn-date">${escHtml(d.date)}</span>
        <span class="jn-spacer"></span>
        <label class="jn-sel-label">rating ${sel('rating', RATING_OPTS, d.rating)}</label>
        <label class="jn-sel-label">habit ${sel('habit_mark', HABIT_MARK_OPTS, d.habit_mark)}</label>
      </div>
      <label class="jn-lab">What to do better tomorrow</label>
      <textarea class="jn-ta" data-field="bottleneck" rows="2">${escHtml(d.bottleneck || '')}</textarea>
      <label class="jn-lab">Active experiment</label>
      <textarea class="jn-ta" data-field="active_experiment" rows="2">${escHtml(d.active_experiment || '')}</textarea>
    </div>`).join('')
    || '<div class="gtd-empty">No journal entries yet — they arrive from the sleep-gate nightly fill</div>';

  const save = async (card, field, value) => {
    const date = card.dataset.date;
    if (field === 'rating') value = value === '' ? null : Number(value);
    if (field === 'habit_mark' && value === '') value = null;
    const res = await fetch(`/api/journal/${date}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    if (!res.ok) alert(`Save failed (${res.status})`);
  };
  grid.querySelectorAll('.jn-ta').forEach(ta =>
    ta.addEventListener('blur', () => save(ta.closest('.jn-card'), ta.dataset.field, ta.value)));
  grid.querySelectorAll('.jn-sel').forEach(s =>
    s.addEventListener('change', () => save(s.closest('.jn-card'), s.dataset.field, s.value)));
}

// The STANDING VIEW of the habit system (2026-08-11): forming habits with
// their health spectrum, the running experiment, the ledger of concluded
// commitments with verdicts, and the old habit_week rows read-only at the
// bottom — they were real commitments. Reads only: marks are made in the
// nightly step, verdicts at the weekly review. No Settings page, on purpose —
// a fourth surface would restate these three.
function renderJournalHabit(hb) {
  const el = document.getElementById('journal-habit');
  if (!el) return;
  if (!hb) { el.innerHTML = '<span class="jh-empty">Habits unavailable.</span>'; return; }
  journalView.habits = hb;
  const ex = hb.experiments || {};
  const rows = [];
  // START and RESOLVE live here (2026-08-11): an experiment is a thing you
  // notice while writing the day, not a decision you take once a week. The
  // review only judges what is already resolved.
  if (ex.running) {
    rows.push(`<div class="jh-row"><span class="jh-label">experiment</span>
      ${escHtml(ex.running.content)} <span class="jh-since">since ${escHtml(ex.running.started_on)}</span>
      <button class="cl-pill" id="jh-resolve" data-id="${ex.running.id}">resolve</button></div>`);
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
    const res = await fetch('/api/habit-experiments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) { toast((await res.json()).error || 'could not start'); return; }
    renderJournalHabit(await fetch('/api/habits').then(r => r.json()));
  });
  const resolve = el.querySelector('#jh-resolve');
  if (resolve) resolve.addEventListener('click', async () => {
    // The resolution is the EVIDENCE the review's verbs judge, so it is asked
    // for here rather than reconstructed from memory a week later.
    const note = prompt('How did it resolve? One line.');
    if (note == null) return;
    await fetch(`/api/habit-experiments/${resolve.dataset.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution: note }),
    });
    renderJournalHabit(await fetch('/api/habits').then(r => r.json()));
  });
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
  const today = formatDateYMD(new Date());
  if (kind === 'entries' && peopleView.satisfiedDate === today) return;
  peopleView.satisfiedDate = today;
  await fetch('/api/people/night', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, date: today }),
  }).catch(() => {});
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
    fetch('/api/buckets').then(r => r.json()).catch(() => []),
    fetch('/api/people').then(r => r.json()).catch(() => []),
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
  const today = formatDateYMD(new Date());
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
      const res = await fetch(`/api/people/${btn.dataset.id}/skip-cycle`, { method: 'POST' });
      if (!res.ok) { alert(`Skip failed (${res.status})`); btn.disabled = false; return; }
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
        }).join('')}</span></div>`
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
      <input type="date" id="pd-int-date" value="${escHtml(formatDateYMD(new Date()))}">
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
    const res = await fetch(`/api/people/${p.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) { alert(`Save failed (${res.status})`); return null; }
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
  body.querySelectorAll('.pd-bucket-chip').forEach(el => {
    el.addEventListener('click', async () => {
      const bid = parseInt(el.dataset.bucket);
      const ids = (p.buckets || []).map(b => b.id);
      const next = ids.includes(bid) ? ids.filter(x => x !== bid) : [...ids, bid];
      const person = await pdPatch({ bucket_ids: next });
      if (person) renderPersonDetail(person);
    });
  });

  const pdNotes = document.getElementById('pd-notes');
  pdNotes.readOnly = !peopleView.editable;
  const pdFlush = wireNotesAutosave(pdNotes, async value => {
    if (!peopleView.editable) return;
    const res = await fetch(`/api/people/${p.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: value }),
    });
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
      const res = await fetch(`/api/people/${p.id}/interactions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, note, source }),
      });
      if (!res.ok) { alert(`Log failed (${res.status})`); return; }
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
    const res = await fetch(`/api/people/${p.id}`, { method: 'DELETE' });
    if (!res.ok) { alert(`Delete failed (${res.status})`); btn.disabled = false; return; }
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
const mapView = { q: '' };

async function openMap() {
  if (!mapWired) {
    const overlay = document.getElementById('map-overlay');
    const shut = () => { flushOpenNotes(); overlay.classList.add('hidden'); };
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
        await fetch(`/api/inbox/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
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
  const items = state.mapItems || [];
  const inboxItems = state.inbox || [];
  const todayStr = formatDateYMD(new Date());
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
      ${isProject ? '' : itemTags(item).map(t =>
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
        ${isProject ? '' : itemTags(i).map(t =>
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
  }).join('') : '<div class="pm-empty">Nothing in the inventory yet — capture into the inbox first.</div>') + inboxHtml;

  const patchItem = (id, patch) => fetch(`/api/inbox/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
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

// ── GTD tab — the four lists with no other surface ────────────
// Projects, Waiting For, Someday/Maybe, Deferred: all inbox_item rows, all
// already computable, none with a home until now. Flat on purpose (no domain
// or area grouping — the breadcrumb rides on the row), and weekly-cadence, so
// density is cheap here in a way it never is on NOW.
// notesFor = which project's notes are open; notesEdit = raw-markdown editing
// (false shows the rendered view — notes are read far more than written).
// chainFor/chainArm/chainItems: the ⛓ dependency editor, which lives HERE on
// the Projects list (2026-08-07, moved out of the clarify sheet
// deliberately — ordering a project's actions is a structure decision, and this is
// the projects surface). chainItems is fetched from /api/map on open because
// the GTD lists payload carries no plain actions.
// Notes, dependency ordering and the per-list verbs all moved to the clarify
// sheet (2026-08-10), so this view holds nothing but its data.
const gtdView = { lists: null };
let gtdTagFilter = null;


async function refreshGtd() {
  gtdView.lists = await fetch('/api/gtd/lists').then(r => r.json());
  renderGtd();
}

// The four canonical GTD lists, rendered exactly like MAP: one ground, MAP's
// row (text + badges + a single `›` into the clarify sheet), and grouped by
// DOMAIN. Rewritten 2026-08-10 — it used to be two columns on two different
// backgrounds, with a different bespoke control set per list (✎ ⛓ # + →active
// ✓ × now), which is the "second grammar" problem MAP already solved.
//
// Every decision is the sheet's now. A project row opens the PROJECT clarify
// sheet (kind === 'project' routes it), and someday/deferred/waiting rows open
// the action sheet — so re-activating, parking, re-dating and deleting are all
// the same gesture they are everywhere else in the app.
function gtdCollapsed(key) {
  return (localStorage.getItem('gtdCollapsed') || '').split(',').includes(key);
}

function gtdToggleSection(key) {
  const open = new Set((localStorage.getItem('gtdCollapsed') || '').split(',').filter(Boolean));
  if (open.has(key)) open.delete(key); else open.add(key);
  localStorage.setItem('gtdCollapsed', [...open].join(','));
}

function renderGtd() {
  const body = document.getElementById('gtd-body');
  if (!body || !gtdView.lists) return;
  const { projects, waiting, someday, deferred } = gtdView.lists;
  const all = [...projects, ...waiting, ...someday, ...deferred];
  const allTags = [...new Set(all.flatMap(itemTags))].sort();
  if (gtdTagFilter && !allTags.includes(gtdTagFilter)) gtdTagFilter = null;
  const byTag = list => gtdTagFilter
    ? list.filter(i => itemTags(i).includes(gtdTagFilter)) : list;
  const todayStr = formatDateYMD(new Date());
  const stalled = new Set(projects.filter(p => !p.action_count).map(p => p.id));
  const byId = {};
  all.forEach(i => { byId[i.id] = i; });

  // captured_at is SQLite UTC with a space — normalize before parsing or ages
  // drift by the timezone offset.
  const ageDays = i => Math.max(0, Math.floor(
    (Date.now() - new Date((i.captured_at || '').replace(' ', 'T') + 'Z')) / 86400000));

  // MAP's row, verbatim in shape: the text, whatever is worth SCANNING, and
  // one control. `extra` is the per-list badge set.
  const rowHtml = (item, extra) => {
    const isProject = item.kind === 'project';
    return `<div class="map-row${isProject ? ' map-row-project' : ''}${
        isProject && stalled.has(item.id) ? ' map-row-stalled' : ''}" data-id="${item.id}">
      <span class="map-text" title="Tap to clarify · double-click to rename">${escHtml(item.content)}</span>
      ${isProject ? '' : itemTags(item).map(t =>
        `<span class="map-badge map-badge-tag">${escHtml(t)}</span>`).join('')}
      ${dueChip(item, 'map-badge')}
      ${extra || ''}
      <span class="map-crumb">${escHtml(item.project_name || item.area_name || '—')}</span>
      <span class="map-acts">
        <button class="map-open" data-id="${item.id}"
          title="${isProject ? 'Clarify this project' : 'Clarify this item'}">›</button>
      </span>
    </div>`;
  };

  // Domain groups, the level above areas — same cut MAP makes, so the two
  // surfaces describe the inventory the same way. The area rides on the row as
  // a breadcrumb rather than becoming a second nesting level: these lists are
  // flat by design (see the GTD tab notes).
  const groupByDomain = (list, extraFn) => {
    const groups = {};
    list.forEach(i => {
      const did = i.domain_id || domainIdForArea(i.area_id);
      (groups[did] = groups[did] || []).push(i);
    });
    const keys = Object.keys(groups).sort((a, b) =>
      (domainName(a) || '').localeCompare(domainName(b) || ''));
    // One domain in play needs no header — a heading that never varies is noise.
    const showHeads = keys.length > 1;
    return keys.map(did => `
      ${showHeads ? `<div class="gtd-domain-head">${escHtml(domainName(did))}<span class="map-count">${groups[did].length}</span></div>` : ''}
      ${groups[did].map(i => rowHtml(i, extraFn ? extraFn(i) : '')).join('')}`).join('');
  };

  const section = (key, title, list, extraFn, empty, headExtra) => {
    const shown = byTag(list);
    const closed = gtdCollapsed(key);
    return `<div class="gtd-section">
      <button class="gtd-section-head" data-section="${key}">
        <span>${title}</span><span class="map-count">${shown.length}</span>
        ${headExtra || ''}<span class="gtd-chev">${closed ? '›' : '⌄'}</span>
      </button>
      ${closed ? '' : (shown.length ? groupByDomain(shown, extraFn)
        : `<div class="gtd-empty">${empty}</div>`)}
    </div>`;
  };

  const chips = allTags.map(t =>
    `<button class="gtd-chip${t === gtdTagFilter ? ' gtd-chip-on' : ''}" data-tag="${escHtml(t)}">${escHtml(t)}</button>`
  ).join('');
  const stalledN = projects.filter(p => !p.action_count).length;

  body.innerHTML = `
    <div class="gtd-header">
      <span class="gtd-counts">${projects.length} projects · ${waiting.length} waiting · ${someday.length} someday · ${deferred.length} deferred</span>
      ${allTags.length ? `<span class="gtd-chips">${chips}</span>` : ''}
    </div>
    ${section('projects', 'Projects', projects,
      p => `<span class="map-badge">${p.action_count} action${p.action_count === 1 ? '' : 's'}</span>`,
      'No projects — nothing multi-step is on the books.',
      stalledN ? `<span class="gtd-stalled-n">${stalledN} stalled</span>` : '')}
    ${section('waiting', 'Waiting for', waiting,
      w => (w.waiting_on ? `<span class="map-badge map-badge-wait">${escHtml(w.waiting_on)}</span>` : '')
        + `<span class="map-badge" title="Waiting since ${escHtml(w.captured_at || '')}">${ageDays(w)}d</span>`
        + (w.chase_on ? `<span class="map-badge">chase ${escHtml(w.chase_on)}</span>` : ''),
      'Nothing handed off.')}
    ${section('someday', 'Someday / maybe', someday, null, 'Nothing parked.')}
    ${section('deferred', 'Deferred', deferred,
      d => `<span class="map-badge">→ ${escHtml(d.defer_until)}</span>`
        + (d.pushed >= 3 ? `<span class="map-badge map-badge-push" title="Not-today'd ${d.pushed} times — too big, not real, or being avoided">pushed ${d.pushed}x</span>` : ''),
      'Nothing deferred — the tickler is empty.')}`;

  const after = async () => { await refreshGtd(); await refreshActiveItems(); };
  // The SAME gestures MAP's rows carry — click to clarify, double-click to
  // rename, `›` for the sheet. One implementation, two surfaces.
  wireMapRows(body, byId, after);

  body.querySelectorAll('.gtd-section-head').forEach(h => h.addEventListener('click', () => {
    gtdToggleSection(h.dataset.section);
    renderGtd();
  }));
  body.querySelectorAll('.gtd-chip').forEach(c => c.addEventListener('click', () => {
    gtdTagFilter = gtdTagFilter === c.dataset.tag ? null : c.dataset.tag;
    renderGtd();
  }));
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
  ['PT15M', '15 min'], ['PT30M', '30 min'], ['PT45M', '45 min'],
  ['PT1H', '1 hr'], ['PT1H30M', '1 hr 30'], ['PT2H', '2 hr'], ['PT2H30M', '2 hr 30'],
  ['PT3H', '3 hr'], ['PT3H30M', '3 hr 30'], ['PT4H', '4 hr'], ['PT6H', '6 hr'],
  ['PT8H', '8 hr'], ['P1D', 'all day'], ['', 'no duration'],
];
const FREQS = [['daily', 'day'], ['weekly', 'week'], ['monthly', 'month'], ['yearly', 'year']];
const MONTH_MODES = [['date', 'a day of the month'], ['nth', 'an nth weekday']];
const NTHS = [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [-1, 'last']];
// relativeTo + offset as ONE control, the way the design states it.
const OPENS = [
  ['-PT2H|start', '2 hr before it starts'], ['-PT1H|start', '1 hr before it starts'],
  ['-PT30M|start', '30 min before it starts'], ['PT0S|start', 'when it starts'],
  ['PT0S|end', 'when it ends'], ['PT30M|end', '30 min after it ends'],
  ['PT1H|end', '1 hr after it ends'],
];
const EXTENTS = [
  ['until-source-start', 'until it starts'], ['until-source-end', 'until it ends'],
  ['same-as-source', 'as long as it runs'], ['PT15M', 'for 15 min'],
  ['PT30M', 'for 30 min'], ['PT1H', 'for 1 hr'], ['PT2H', 'for 2 hr'],
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
    anchor: formatDateYMD(new Date()),
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
      anchor: (s.start || '').slice(0, 10) || formatDateYMD(new Date()),
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
    body += `<div class="sp-row"><span class="sp-label">Opens</span>${
      spSelect('opens', OPENS, `${f.offset || 'PT0S'}|${f.relativeTo || 'start'}`)}</div>`;
    body += `<div class="sp-row"><span class="sp-label">Stays open</span>${
      spSelect('extent', EXTENTS, f.extent || 'until-source-start')}</div>`;
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
    ? await fetch(`/api/schedules/${uid}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    : await fetch('/api/schedules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
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
      if (src && !src.title) await fetch(`/api/schedules/${uid}`, { method: 'DELETE' });
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
  await fetch(`/api/schedules/${pickerView.uid}`, { method: 'DELETE' });
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
    fetch('/api/tag-devices').then(r => r.json()).catch(() => state.tagDevices),
    fetch('/api/tag-times').then(r => r.json()).catch(() => state.tagTimes),
    fetch(`/api/schedules?date=${egDateStr()}&unnamed=1`).then(r => r.json()).catch(() => state.schedules),
    fetch('/api/tag-daily').then(r => r.json()).catch(() => state.tagDaily),
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
    await fetch('/api/tag-daily', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, on: b.dataset.daily === 'on' }),
    });
    await ctxSheetRefresh();
  }));
  sheet.querySelector('#ctx-sheet-close').addEventListener('click', closeCtxSheet);
  sheet.querySelector('#ctx-sheet-done').addEventListener('click', closeCtxSheet);
  back.onclick = closeCtxSheet;

  sheet.querySelectorAll('[data-dev]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.dev === 'none') {
      await fetch(`/api/tag-devices/${encodeURIComponent(tag)}`, { method: 'DELETE' });
    } else {
      await fetch('/api/tag-devices', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag, device: b.dataset.dev }),
      });
    }
    await ctxSheetRefresh();
  }));
  sheet.querySelectorAll('[data-loc]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.loc === 'none') {
      await fetch(`/api/tag-locations/${encodeURIComponent(tag)}`, { method: 'DELETE' });
      state.tagLocations = state.tagLocations.filter(x => x.tag !== tag);
    } else {
      state.tagLocations = await fetch('/api/tag-locations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag, location_id: parseInt(b.dataset.loc) }),
      }).then(r => r.json());
    }
    await ctxSheetRefresh();
  }));
  sheet.querySelectorAll('[data-time]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.time === 'none') {
      await fetch(`/api/tag-times/${encodeURIComponent(tag)}`, { method: 'DELETE' });
    } else {
      await fetch('/api/tag-times', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag, source_uid: b.dataset.time }),
      });
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
function egDateStr() { return engageView.date || formatDateYMD(new Date()); }
function egViewDate() { return new Date(egDateStr() + 'T12:00:00'); }

async function refreshEngage() {
  const dateStr = egDateStr();
  // /api/map resolves placed items from ANY domain; the pool fetch is only the
  // chip's domain (and runs the recurring-task seeding, same as NOW).
  // Catches fall back to the current values, not [] — this is the home screen,
  // and a network drop must not blank the day that is already rendered. See the
  // note on loadAll.
  const [placements, futurePlaced, pool, all, overrides, routineItems, flows,
         schedules, deferred] = await Promise.all([
    fetch(`/api/engage/placements?date=${dateStr}`).then(r => r.json()).catch(() => engageView.placements),
    // Scheduled on/after the viewed day → out of "Not scheduled" (the pool
    // shows what still NEEDS a day, and these have one).
    fetch(`/api/engage/placements?from=${dateStr}`).then(r => r.json()).catch(() => engageView.futurePlaced),
    // Everything available, every domain: the context picker narrows it
    // client-side, so switching contexts is instant.
    fetch('/api/inbox/active').then(r => r.json()).catch(() => engageView.pool),
    fetch('/api/map').then(r => r.json()).catch(() => engageView.allItems),
    fetch(`/api/overrides?date=${dateStr}`).then(r => r.json()).catch(() => []),
    fetch('/api/routine-items').then(r => r.json()).catch(() => []),
    // The day's routines, so a gate hairline can name the routine that gates it
    // — the link is what makes the gate pass or fail, and it was only visible
    // inside the step editor.
    fetch(`/api/flows?date=${dateStr}`).then(r => r.json()).catch(() => engageView.flows),
    fetch(`/api/schedules?date=${dateStr}&unnamed=1`).then(r => r.json()).catch(() => state.schedules),
    // Everything parked on a future date, unfiltered — walking the calendar
    // then costs no round trip, same as the pool.
    fetch('/api/inbox/deferred').then(r => r.json()).catch(() => engageView.deferred),
  ]);
  engageView.placements = placements;
  engageView.futurePlaced = futurePlaced;
  engageView.pool = pool;
  engageView.allItems = all;
  engageView.overrides = overrides;
  engageView.routineItems = routineItems;
  engageView.flows = Array.isArray(flows) ? flows : [];
  state.schedules = Array.isArray(schedules) ? schedules : [];
  engageView.deferred = Array.isArray(deferred) ? deferred : [];
  renderEngage();
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
  const dow = jsDateToDayOfWeek(viewDate);
  const isoMin = iso => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };

  // The day's fixed points, all in semantic minutes.
  const rows = [];

  const qrMinutes = {};
  (state.accountabilityNodes || []).filter(n => n.active)
    .filter(n => n.days_of_week == null || String(n.days_of_week).includes(String(dow)))
    .forEach(n => {
      // today_override is the Worker's resolution FOR TODAY — on any other
      // viewed day fall back to weekly window > defaults. (Date overrides for
      // other days stay the timeline's business; Engage shows the default
      // shape of a day it can't yet know overrides for.)
      const ov = isToday ? n.today_override : null;
      const def = nodeWindowForDow(n, dow);
      const end = ov ? ov.window_end : def.window_end;
      const off = ov ? (ov.window_end_offset_days || 0) : (def.window_end_offset_days || 0);
      const outcome = state.qrOutcomes[`${n.id}:${dateStr}`];
      const minute = timeToMinutes(end) + (off ? 1440 : 0);
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

  state.blocks.filter(b => b.active && b.day_of_week === dow).forEach(b => {
    const ov = engageView.overrides.find(o => o.block_id === b.id && o.date === dateStr);
    const startT = (ov && ov.start_time) || b.start_time;
    const endT = (ov && ov.end_time) || b.end_time;
    const seg = { minute: timeToMinutes(startT),
                  endMin: timeToMinutes(endT) + (endT < startT ? 1440 : 0),
                  id: b.id, label: b.label, cancelled: !!(ov && ov.cancelled === 1) };
    if (routineAreaIds.has(b.area_id)) {
      (routineGroups[b.area_id] = routineGroups[b.area_id] || []).push(seg);
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
                started: !!item.started_at });
  });

  rows.sort((a, b) => a.minute - b.minute || (a.kind === 'action') - (b.kind === 'action'));

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

  // Location gate: any bound tag on the item must be satisfied by the current
  // fix; without a fix nothing is gated (fail-open, see initGeo).
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
  const otherDevice = device === 'pc' ? 'phone' : 'pc';

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
    const to = iv.end === '24:00' ? 1440 : timeToMinutes(iv.end);
    return nowMin >= from && nowMin < to;
  });
  const gateOn = timeGateOn();
  const timeOk = i => !isToday || !gateOn || itemTags(i).every(t => {
    const p = tagTime[t];
    return !p || inPeriod(p);
  });

  // Scheduled on/after the viewed day = it HAS a day, so it isn't "Not
  // scheduled" on this one. A placement whose day has passed is not in this
  // set (the server query is date >= viewed), so an unfinished item quietly
  // returns to the pool instead of being scheduled-in-the-past forever.
  const scheduledIds = new Set(engageView.futurePlaced.map(p => p.item_id));
  const poolBase = engageView.pool
    .filter(i => (i.kind || 'item') === 'item' && !placedIds.has(i.id)
                 && !scheduledIds.has(i.id)
                 && !routineAreaIds.has(i.area_id) && inContext(i));
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
  const onToday = !engageView.date || engageView.date === formatDateYMD(new Date());
  const dayOk = i => !onToday || itemTags(i).every(t => dayAns[t] !== false);

  const geoHidden = poolBase.filter(i => !locOk(i)).length;
  const devHidden = poolBase.filter(i => locOk(i) && !deviceOk(i)).length;
  const timeHidden = poolBase.filter(i => locOk(i) && deviceOk(i) && !timeOk(i)).length;
  const dayHidden = poolBase.filter(i =>
    locOk(i) && deviceOk(i) && timeOk(i) && !dayOk(i)).length;
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
          ${itemTags(i).map(t => `<span class="eg-tag">${escHtml(t)}</span>`).join('')}
          ${dueChip(i, 'eg-tag')}
          <span class="eg-tag">${escHtml(i.project_name || i.area_name || '')}</span>
        </div>`).join('')}
    </div>` : '';

  const hhmm = m => minutesToHHMM(Math.round(m) % 1440);

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
          r.done ? '✓ done' : '▶ run'}</button>
      </div>`;
    }
    if (r.kind === 'block') {
      return `<div class="eg-row eg-block${r.cancelled ? ' eg-cancelled' : ''}${r.endMin <= nowMin ? ' eg-past' : ''}"
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
      return `<div class="eg-row eg-routine${r.cancelled ? ' eg-cancelled' : ''}${r.endMin <= nowMin ? ' eg-past' : ''}">
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
      return `<div class="eg-row eg-event${r.endMin <= nowMin ? ' eg-past' : ''}"
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
      <span class="eg-check${r.started ? ' eg-check-started' : ''}" data-id="${r.id}"
        title="${r.started ? 'In progress — tap for done, hold to clear' : 'Tap = done · hold = in progress'}">${r.started ? '◐' : ''}</span>
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
    <div class="eg-pool-head">Not scheduled${geoHidden
      ? ` <span class="eg-geo-hidden" title="Hidden by location-bound tags — they return when you're there">⌖ ${geoHidden} elsewhere</span>` : ''}${devHidden
      ? ` <span class="eg-dev-hidden" title="Tagged #${otherDevice} — they show up on the ${otherDevice}">▭ ${devHidden} ${otherDevice}-only</span>` : ''}${timeHidden
      ? ` <span class="eg-dev-hidden" title="Their context is bound to a time period you are not in — they come back when you are">◷ ${timeHidden} out of window</span>` : ''}${dayHidden
      ? ` <span class="eg-dev-hidden" title="You said these contexts don't apply today — the morning routine is where that is answered">👤 ${dayHidden} not today</span>` : ''}</div>
    ${deferHtml}
    <div class="eg-pool">
      ${pool.map(i => `
        <div class="eg-row eg-pool-item${i.started_at ? ' eg-inprog' : ''}" draggable="true" data-id="${i.id}">
          <span class="eg-check${i.started_at ? ' eg-check-started' : ''}" data-id="${i.id}"
            title="Done">${i.started_at ? '◐' : ''}</span>
          <span class="eg-text">${escHtml(i.content)}</span>
          ${itemTags(i).filter(t => EST_TAGS.includes(t))
            .map(t => `<span class="eg-tag">${escHtml(t)}</span>`).join('')}
          ${dueChip(i, 'eg-tag')}
          ${itemTags(i).filter(t => !EST_TAGS.includes(t))
            .map(t => `<span class="eg-tag">${escHtml(t)}</span>`).join('')}
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
    engageView.date = s === formatDateYMD(new Date()) ? null : s;
    refreshEngage();
  };
  header.querySelector('#eg-prev').addEventListener('click', () => shiftDay(-1));
  header.querySelector('#eg-next').addEventListener('click', () => shiftDay(1));
  // The day itself is the door to the timeline: open calendar view AT the
  // viewed day (clamped to the timeline's ±3-day window). "Back to today" is
  // the pill that appears only when you're elsewhere.
  header.querySelector('#eg-day-btn').addEventListener('click', async () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = egViewDate();
    const diff = Math.round((new Date(target).setHours(0, 0, 0, 0) - today) / 86400000);
    const b = navBounds();
    const clamped = Math.max(b.min, Math.min(b.max, diff));
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
      const item = [...engageView.pool, ...engageView.allItems].find(i => i.id === id);
      await undoableDelete(id, `completed "${(item && item.content) || 'action'}"`);
      await after();
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
  // A gating routine on a gate hairline runs straight from the day. The runner
  // needs refView.flows populated (it reads its own fetch, but the editor
  // behind it doesn't exist here) — openFlowRun refetches, so this is safe
  // from Engage with Lists never opened.
  body.querySelectorAll('.eg-qr-flow').forEach(el => {
    el.addEventListener('click', () => openFlowRun(parseInt(el.dataset.flow)));
  });

  const pop = body.querySelector('.eg-rt-pop');
  if (pop) {
    const rtHeaders = { 'Content-Type': 'application/json' };
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
        await fetch(`/api/routine-items/${id}`, {
          method: 'PATCH', headers: rtHeaders, body: JSON.stringify({ done: !wasDone }),
        });
        pushUndo(`${wasDone ? 'un-checked' : 'checked'} "${item.content}"`, async () => {
          await fetch(`/api/routine-items/${id}`, {
            method: 'PATCH', headers: rtHeaders, body: JSON.stringify({ done: wasDone }),
          });
          await refreshAfterUndo();
        });
        await refreshEngage();
      });
    });
    pop.querySelectorAll('.eg-rt-del').forEach(el => {
      el.addEventListener('click', async () => {
        const id = parseInt(el.dataset.rt);
        const row = engageView.routineItems.find(i => i.id === id);
        await fetch(`/api/routine-items/${id}`, { method: 'DELETE' });
        if (row) {
          pushUndo(`removed "${row.content}" from the routine`, async () => {
            await fetch('/api/routine-items/restore', {
              method: 'POST', headers: rtHeaders, body: JSON.stringify(row),
            });
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
          await fetch(`/api/routine-items/${id}`, {
            method: 'PATCH', headers: rtHeaders, body: JSON.stringify({ content }),
          });
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
      await fetch('/api/routine-items', {
        method: 'POST', headers: rtHeaders,
        body: JSON.stringify({ area_id: engageView.routinePop, content }),
      });
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
      await fetch(`/api/overrides/${existing.id}`, { method: 'DELETE' });
      pushUndo(`restored "${label}"`, async () => {
        await fetch('/api/overrides', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ block_id: blockId, date: dateStr, cancelled: true }),
        });
        await refreshAfterUndo();
      });
    } else {
      const target = !(existing && existing.cancelled === 1);
      await fetch('/api/overrides', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ block_id: blockId, date: dateStr, cancelled: target }),
      });
      pushUndo(`${target ? 'cancelled' : 'restored'} "${label}"`, async () => {
        await fetch('/api/overrides', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ block_id: blockId, date: dateStr, cancelled: !target }),
        });
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
      if (!(e.metaKey || e.ctrlKey)) return;
      hide();
    });
    onLongPress(el, hide);
  });

  body.querySelectorAll('.eg-unplace').forEach(el => {
    el.addEventListener('click', async () => {
      const id = parseInt(el.dataset.id);
      const was = engageView.placements.find(p => p.item_id === id);
      await fetch(`/api/engage/placements/${id}?date=${dateStr}`, { method: 'DELETE' });
      if (was) {
        pushUndo('unscheduled an action', async () => {
          await fetch('/api/engage/placements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: dateStr, item_id: id, minute: was.minute }),
          });
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
    await fetch('/api/engage/placements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateStr, item_id: id, minute }),
    });
    pushUndo(was ? 'moved an action' : 'scheduled an action', async () => {
      if (was) {
        await fetch('/api/engage/placements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: dateStr, item_id: id, minute: was.minute }),
        });
      } else {
        await fetch(`/api/engage/placements/${id}?date=${dateStr}`, { method: 'DELETE' });
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
  const day = await fetch('/api/engage/day').then(r => r.json()).catch(() => null);
  if (!day) { body.innerHTML = '<div class="gtd-empty">Could not load the day.</div>'; return; }
  const d = new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  const PRIO = { event: 3, routine: 2, block: 1 };
  const active = day.rows
    .filter(r => r.start <= m && m < r.end)
    .sort((a, b) => (b.start - a.start) || (PRIO[b.kind] - PRIO[a.kind]))[0] || null;
  const next = day.rows.filter(r => r.start > m).sort((a, b) => a.start - b.start)[0] || null;
  const hhmm = x => minutesToHHMM(((Math.round(x) % 1440) + 1440) % 1440);

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
        await fetch(`/api/routine-items/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ done: true }),
        });
        pushUndo(`checked "${label}"`, async () => {
          await fetch(`/api/routine-items/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ done: false }),
          });
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
  action: '', tags: new Set(), showDate: '', showTime: '',
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
    fetch('/api/people').then(r => r.json()).catch(() => []),
    fetch('/api/map').then(r => r.json()).catch(() => []),
    fetch('/api/projects').then(r => r.json()).catch(() => []),
    fetch('/api/ref').then(r => r.json()).catch(() => []),
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

// THE LAST DOMAIN YOU FILED INTO, for the rest of the day.
//
// Clarifying a queue is one sitting: an inbox is usually about one part of
// your life at a time, so re-picking the domain on every item is a tax on the
// common case. It expires at MIDNIGHT rather than persisting forever, because
// "what I was working on" is a fact about a day — carrying yesterday's context
// into this morning would file today's captures into last night's project.
//
// Stored per-day so the expiry needs no timer and survives a restart. It is a
// DEFAULT, never a decision: the Filing-to row still shows every domain, and
// an item that already has an area (re-clarified from MAP/GTD/the pool) keeps
// its own — a suggestion must not overwrite something already decided.
function lastFiledDomain() {
  try {
    const raw = JSON.parse(localStorage.getItem('lastFiled') || 'null');
    if (raw && raw.date === formatDateYMD(new Date())) return raw.domainId;
  } catch (e) { /* unparseable = no memory, which is the safe answer */ }
  return null;
}

function rememberFiledDomain(areaId) {
  if (!areaId) return;
  localStorage.setItem('lastFiled', JSON.stringify({
    domainId: domainIdForArea(areaId), date: formatDateYMD(new Date()),
  }));
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
  clarifyView.tags = new Set(item ? itemTags(item) : []);
  clarifyView.showDate = '';
  clarifyView.showTime = '';
  // A project's start date is a standing property, not a fresh decision, so
  // unlike an action's it is PREFILLED — "Active" is then the explicit act of
  // clearing it, and re-filing a parked project can't silently un-park it.
  if (clarifyView.project) {
    const parked = item.defer_until && item.defer_until > formatDateYMD(new Date());
    clarifyView.verb = parked ? 'defer' : 'active';
    clarifyView.showDate = parked ? item.defer_until : '';
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
  const item = clarifyView.queue[0];
  if (item && !clarifyView.external && clarifyView.notes !== (item.notes || '')) {
    undoablePatch(item, ['notes'], `edited notes on "${item.content}"`);
    patchInboxItem(item.id, { notes: clarifyView.notes });
    item.notes = clarifyView.notes;
  }
  const after = clarifyView.after;
  clarifyView.open = false;
  clarifyView.single = false;
  clarifyView.external = false;
  clarifyView.forProject = null;
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
    const patch = body => fetch(`/api/inbox/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
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
      await fetch(`/api/inbox/${item.id}`, { method: 'DELETE' });
    } else if (bucket === 'reference') {
      // The other non-actionable keep: the text moves to a reference list and
      // the item leaves the action inventory entirely.
      refCreated = await fetch('/api/ref/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list_id: refListId, content }),
      }).then(r => r.json());
      await fetch(`/api/inbox/${item.id}`, { method: 'DELETE' });
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
      if (clarifyView.showDate && clarifyView.showTime) {
        // A time schedules it: the placement lands in THAT day's schedule.
        // Prior placements go first, so re-clarifying to a new slot never
        // leaves a stale one behind on another date.
        for (const p of (snap && snap.placements) || []) {
          await fetch(`/api/engage/placements/${item.id}?date=${p.date}`, { method: 'DELETE' });
        }
        await fetch('/api/engage/placements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_id: item.id, date: clarifyView.showDate,
                                 minute: timeToMinutes(clarifyView.showTime) }),
        });
      }
    }

    if (snap) {
      const verb = { do: 'did', trash: 'trashed', someday: 'parked',
                     delegate: 'delegated', defer: 'filed',
                     reference: 'referenced' }[bucket] || 'filed';
      pushUndo(`${verb} "${item.content}"`, async () => {
        // A reference filing has TWO effects; undo reverses both.
        if (refCreated) await fetch(`/api/ref/items/${refCreated.id}`, { method: 'DELETE' });
        await fetch('/api/inbox/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snap),
        });
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
      const created = await fetch('/api/ref/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list_id: refListId, content }),
      }).then(r => r.json());
      pushUndo(`referenced "${content}"`, async () => {
        await fetch(`/api/ref/items/${created.id}`, { method: 'DELETE' });
        await refreshAfterUndo();
      });
    } else if (bucket !== 'trash' && bucket !== 'do') {
      const areaId = clarifyView.areaId || state.activeAreaId
        || (state.areas.find(a => a.is_default && a.active && a.type === 'standard') || {}).id;
      rememberFiledDomain(areaId);   // the external step teaches it too
      const created = await fetch('/api/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }).then(r => r.json());
      const patch = body => fetch(`/api/inbox/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
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
        if (clarifyView.showDate && clarifyView.showTime) {
          await fetch('/api/engage/placements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_id: created.id, date: clarifyView.showDate,
                                   minute: timeToMinutes(clarifyView.showTime) }),
          });
        }
      }
      pushUndo(`clarified "${content}"`, async () => {
        await fetch(`/api/inbox/${created.id}`, { method: 'DELETE' });
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
  if (!clarifyView.open || (!item && !clarifyView.external)) { closeClarify(); return; }
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
  const isProj = clarifyView.project && !clarifyView.external && !!item;
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
  if (isProj) {
    middle = verb === 'trash'
      ? '<div class="cl-donow">Not a real outcome. Deleting it splices its actions up one level.</div>'
      : `<div class="cl-row">
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
      <div class="cl-row">
        ${doProgress ? '' : `<span class="cl-label">Show on</span>
        <input type="date" id="cl-show-date" class="cl-date"
          title="Date alone defers; adding a time places it into that day's schedule" value="${clarifyView.showDate}">
        <input type="time" id="cl-show-time" class="cl-date" value="${clarifyView.showTime}" title="A time schedules it into that day">
        ${clarifyView.showTime ? '<button id="cl-show-time-x" class="cl-x" title="Clear the time — date alone just defers">✕</button>' : ''}`}
        <span class="cl-label">Due</span>
        <input type="date" id="cl-due" class="cl-date" title="Real deadlines only" value="${clarifyView.due}">
      </div>
      <div class="cl-row">
        <span class="cl-label">Project</span>
        <button id="cl-proj" class="cl-pill${clarifyView.projectId ? ' cl-pill-on' : ''}">${clarifyView.projectId ? escHtml(clarifyView.projectName) : 'none'} ⌕</button>
        ${clarifyView.projectId ? `<button id="cl-proj-notes-btn" class="cl-pill${clarifyView.projNotesOpen ? ' cl-pill-on' : ''}"
          title="The project's support material — saved to the project, not this item">✎</button>
        <button id="cl-proj-chain" class="cl-pill"
          title="Order this project's actions and set dependencies">⛓</button>` : ''}
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
  const acts = isProj
    ? ((state.projects || []).find(p => p.id === item.id) || {}).action_count
    : null;
  sheet.innerHTML = `
    <div class="cl-head">
      <span class="cl-eyebrow">Clarify${isProj ? ' · project' : ''}</span>
      <span class="cl-count">${ext
        ? (clarifyView.forProject ? 'new action' : 'outside the app')
        : `${n} of ${clarifyView.total}`}</span>
      <span class="cl-spacer"></span>
      <span class="cl-hint">one at a time · esc / tap off</span>
    </div>
    ${ext && clarifyView.forProject ? `
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
    ${isProj ? `<div class="cl-row">
      <button class="cl-pill" id="cl-self-add">+ next action</button>
      ${acts >= 2 ? '<button class="cl-pill" id="cl-self-chain">⛓ order them</button>' : ''}
    </div>` : ''}
    <div class="cl-sec"><span class="cl-q">${isProj
      ? "What's the outcome?" : "What's the next physical action?"}</span></div>
    <div class="cl-action-wrap"><input type="text" id="cl-action" class="cl-action" value="${escHtml(clarifyView.action)}" autocomplete="off"${ext ? ' placeholder="e.g. Reply to Sam about the venue"' : ''}></div>
    <div class="cl-verbs">${isProj
      ? `${verbBtn('active', 'Active', 'A')}${verbBtn('defer', 'Defer', 'F')}${verbBtn('trash', 'Trash', '⌫')}`
      : `${verbBtn('do', 'Do now', 'D')}${verbBtn('delegate', 'Delegate', 'G')}${verbBtn('defer', 'Defer', 'F')}`}</div>
    ${middle}
    ${notesHtml}
    <div class="cl-row cl-or">
      <span class="cl-label">Or</span>
      ${ext || isProj ? '' : `<button class="cl-pill" id="cl-trash">Trash <span class="cl-key">⌫</span></button>`}
      <button class="cl-pill" id="cl-someday">Someday <span class="cl-key">S</span></button>
      <button class="cl-pill${clarifyView.refOpen ? ' cl-pill-on' : ''}" id="cl-reference">Reference <span class="cl-key">R</span></button>
    </div>
    ${clarifyView.refOpen ? `<div class="cl-chips cl-ref-row">
      ${clarifyView.refLists.map(l => `<button class="cl-chip" data-reflist="${l.id}">${escHtml(l.name)}</button>`).join('')}
      <input type="text" id="cl-ref-new" class="cl-chip-input" placeholder="+ new list">
    </div>` : ''}
    <div class="cl-foot">
      <span class="cl-then">${ext ? 'Repeat until your head is empty'
        : next ? `Then: ${escHtml(next.content)}`
        : clarifyView.single ? 'Then: back to the day' : 'Then: anything outside the app'}</span>
      ${ext ? '<button id="cl-ext-done" class="cl-pill">Done</button>' : ''}
      <button id="cl-file">${ext ? 'Add it ⏎' : 'File it ⏎'}</button>
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
  if (showDate) showDate.addEventListener('change', e => { clarifyView.showDate = e.target.value; });
  const showTime = sheet.querySelector('#cl-show-time');
  if (showTime) showTime.addEventListener('change', e => {
    clarifyView.showTime = e.target.value;
    if (e.target.value && !clarifyView.showDate) clarifyView.showDate = formatDateYMD(new Date());
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

  const chainBtn = sheet.querySelector('#cl-proj-chain');
  if (chainBtn) chainBtn.addEventListener('click', async () => {
    const p = (state.projects || []).find(x => x.id === clarifyView.projectId);
    if (p) await openComposeFor(p, 'pick');
  });
  const notesTa = sheet.querySelector('#cl-notes');
  if (notesTa) {
    notesTa.addEventListener('input', e => { clarifyView.notes = e.target.value; });
    // Not autosave-wired (closeClarify owns the flush), so add the markdown
    // suite explicitly. insertText fires input, so the mirror above stays hot.
    wireMdShortcuts(notesTa);
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
  sheet.querySelector('#cl-someday').addEventListener('click', () => fileClarify('someday'));
  // Reference: the OTHER non-actionable keep. The pill reveals the list
  // chips; tapping a chip files immediately (exits are one gesture), and the
  // + input creates the list and files into it in the same stroke.
  sheet.querySelector('#cl-reference').addEventListener('click', () => {
    clarifyView.refOpen = !clarifyView.refOpen;
    renderClarify();
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
    const nl = await fetch('/api/ref/lists', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(r => r.json());
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

// Creating a project IS the breakdown flow now (2026-08-07, replacing "⤷ Break
// this down"). The old one made the CAPTURE become the project and left you in
// the bar with an empty outcome; this one names the outcome, puts the thing you
// were clarifying IN it as action [1], and opens the composer so the rest of
// the decomposition — more actions, then the order they go in — happens in one
// place, while you still have the project in your head.
async function clarifyCreateProject(name) {
  if (!name) return;
  const areaId = clarifyView.areaId || state.activeAreaId
    || (state.areas.find(a => a.is_default && a.active && a.type === 'standard') || {}).id;
  const p = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: name, area_id: areaId }),
  }).then(r => r.json());
  state.projects = await fetch('/api/projects').then(r => r.json());
  recentBump('project', p.id);
  clarifyView.projectId = p.id;
  clarifyView.projectName = p.content;
  clarifyView.projSearch = null;

  // The external step has no source row to file, so it opens the composer
  // empty — the project's first action is typed in the add field like the rest.
  const item = clarifyView.external ? null : clarifyView.queue[0];
  if (item) {
    // Commit the item into the project as clarified, WITHOUT advancing the
    // queue: fileClarify would move to the next capture and take the composer
    // with it. Everything the main sheet had decided rides along, so opening
    // the composer never silently drops a tag or a due date.
    const snap = await snapshotItem(item.id);
    const content = clarifyView.action.trim() || item.content;
    await fetch(`/api/inbox/${item.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, status: 'active', area_id: areaId,
                             project_id: p.id,
                             tags: [...clarifyView.tags].join(' '),
                             notes: clarifyView.notes,
                             deadline: clarifyView.due || null,
                             defer_until: clarifyView.showDate || null }),
    });
    item.content = content;
    item.notes = clarifyView.notes;
    // One undo for the whole act: the item goes back to "in" AND the project
    // it was created for goes away. Half of it would leave an empty project.
    pushUndo(`broke down "${content}"`, async () => {
      if (snap) {
        await fetch('/api/inbox/restore', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snap),
        });
      }
      await fetch(`/api/inbox/${p.id}`, { method: 'DELETE' });
      await refreshAfterUndo();
    });
    // It has left "in", so it leaves the queue — the composer is what stands
    // in for this item's remaining clarify.
    clarifyView.queue.shift();
    state.inbox = state.inbox.filter(x => x.id !== item.id);
    renderInbox();
  }
  await openComposeFor({ id: p.id, content: p.content, area_id: areaId }, 'new');
}

// Two ways in, and the difference is whether the item has been filed yet:
//   'new'  — clarifyCreateProject already filed it as action [1]; leaving
//            resumes the clarify queue, because this item is done.
//   'pick'  — you chose an existing project from the search and NOTHING has
//            been filed; leaving goes back to the main sheet so you still pick
//            a verb. Ordering the project's actions must not silently commit
//            the item you were clarifying.
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
  const all = await fetch('/api/map').then(r => r.json()).catch(() => []);
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
    const created = await fetch('/api/inbox', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, status: 'active', area_id: c.areaId,
                             project_id: c.id, tags: tags.join(' ') }),
    }).then(r => r.json());
    pushUndo(`added "${content}"`, async () => {
      await fetch(`/api/inbox/${created.id}`, { method: 'DELETE' });
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
    await fetch(`/api/inbox/${fromId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ after_id: toId }),
    });
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
    await fetch(`/api/inbox/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ after_id: null }),
    });
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
      const res = await fetch('/api/buckets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      if (!res.ok) { alert(`Add bucket failed (${res.status})`); return; }
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
  const res = await fetch(`/api/buckets/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) { alert(`Bucket update failed (${res.status})`); return; }
  await reloadBuckets();
  renderBucketMgr();
  renderPeopleList();
}

async function reloadBuckets() {
  const buckets = await fetch('/api/buckets').then(r => r.json()).catch(() => []);
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
        <div class="pa-row"><label>Date</label><input type="date" id="pa-int-date" value="${escHtml(formatDateYMD(new Date()))}"></div>
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
        const res = await fetch(`/api/people/${personId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) { errEl.textContent = `Save failed (${res.status})`; return; }
        if (adopted) toast(`Logged to ${adopted.name} — already in your CRM`);
      } else {
        // A new person has nothing to append to, so this IS their notes.
        const body = notesAdd ? { ...fields, notes: notesAdd } : fields;
        if (peopleView.addAllowDuplicate) body.allow_duplicate = true;
        const res = await fetch('/api/people', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        // The server's own name guard, for the case the client could not see:
        // a people list loaded before someone else's session added them. It
        // hands back the person, so this becomes the log it should have been.
        if (res.status === 409) {
          const dup = (await res.json()).person;
          personId = dup.id;
          const pbody = prunedFields(fields);
          if (notesAdd) pbody.notes_append = notesAdd;
          const pres = await fetch(`/api/people/${personId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pbody) });
          if (!pres.ok) { errEl.textContent = `Save failed (${pres.status})`; return; }
          toast(`Logged to ${dup.name} — already in your CRM`);
        } else if (!res.ok) {
          errEl.textContent = `Add failed (${res.status})`; return;
        } else {
          personId = (await res.json()).id;
        }
      }
      if (intNote && intDate) {
        const ires = await fetch(`/api/people/${personId}/interactions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: intDate, note: intNote, source: intSource }) });
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
