let ACK_GRACE_MIN = 5;

// NP_H_MIN is only a sanity guard against a degenerate window if a render is
// measured before fonts settle — it must stay below the real 3-line height so
// it never pads the panel with dead space.
const NP_H_MIN = 48;
const NP_H_MAX = 520;

// The panel is a projection of the ENGAGE DAY now (blocks, routines, events,
// placed actions from /api/engage/day) — the daily plan text is gone. The
// salience ladder is unchanged: 0 on-plan (dim) → 1 handoff (brighten) →
// 2 overrun question. Content changes are absorbed silently; only
// clock-driven active-row changes fire the ladder.
const npState = {
  day: null,
  fetchedDate: null,
  active: null,
  clockKey: 'gap',
  mode: 0,
  prev: null,
  prevEnd: null,
  stay: null,
  stayEnd: null,
  brightTimer: null,
  ackTimer: null,
  interrupted: false,
  switchOpen: false,
  todosExpanded: false,
};

function nowMinutes() {
  if (window.__clockOverride != null) return window.__clockOverride;
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function npLocalDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Everything the panel shows is 24-hour, matching the day view.
function npFmt24(m) {
  const t = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function npEl(id) {
  return document.getElementById(id);
}

function npOverrun(m, end) {
  if (end == null) return 0;
  let d = m - end;
  if (d < -720) d += 1440;
  return Math.max(0, Math.floor(d));
}

function npSetSalience(cls) {
  npEl('np-root').className = cls;
}

let npLastHeight = 0;

function npResize(h) {
  if (h === npLastHeight) return;
  npLastHeight = h;
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_height) {
    window.pywebview.api.set_height(h);
  }
}

// Size the window to exactly what the panel renders. #np-root is auto-height,
// so its border box IS the content.
function npSyncHeight() {
  const h = Math.ceil(npEl('np-root').getBoundingClientRect().height);
  npResize(Math.min(Math.max(h, NP_H_MIN), NP_H_MAX));
}

// The row in force at minute m. Later start wins (the most specific thing you
// entered last); ties break event > routine > block — the hard landscape
// outranks the frame.
const NP_PRIO = { event: 3, routine: 2, block: 1 };

function npActiveAt(m) {
  const rows = npState.day ? npState.day.rows : [];
  const inside = rows.filter(r => r.start <= m && m < r.end);
  if (!inside.length) return null;
  inside.sort((a, b) => (b.start - a.start) || (NP_PRIO[b.kind] - NP_PRIO[a.kind]));
  return inside[0];
}

function npNextAt(m) {
  const rows = npState.day ? npState.day.rows : [];
  const ahead = rows.filter(r => r.start > m);
  return ahead.length ? ahead.reduce((a, b) => (a.start <= b.start ? a : b)) : null;
}

function npKeyOf(row) {
  return row ? `${row.kind}:${row.label}:${row.start}` : 'gap';
}

function npNowLabel() {
  // During a stay the shown (stayed) row is what the mark is about.
  const r = npState.mode === 3 ? npState.stay : npState.active;
  return r ? r.label : null;
}

// The active row's checklist: a routine's open routine_items, or the placed
// actions inside a block/event's span.
function npChecklist(row) {
  if (!row || !npState.day) return [];
  if (row.kind === 'routine') {
    return npState.day.routine_items
      .filter(i => i.area_id === row.area_id && i.done_date !== npState.day.date)
      .map(i => ({ type: 'routine', id: i.id, text: i.content }));
  }
  return npState.day.placed
    .filter(p => p.minute >= row.start && p.minute < row.end)
    .map(p => ({ type: 'action', id: p.id, text: p.content }));
}

async function npFetchDay() {
  const day = await fetch('/api/engage/day').then(r => r.json()).catch(() => null);
  if (!day) return;
  npState.day = day;
  npState.fetchedDate = day.date;
  // Content changes are silent: recompute the active row without salience.
  npState.active = npActiveAt(nowMinutes());
  npState.clockKey = npKeyOf(npState.active);
  renderPanel();
}

function npHandoff(row, key) {
  const prev = npState.mode === 3 ? npState.stay : npState.active;
  npState.prev = prev;
  npState.prevEnd = prev ? prev.end : null;
  npState.active = row;
  npState.clockKey = key;
  npState.stay = null;
  npState.todosExpanded = false;
  if (npState.brightTimer) clearTimeout(npState.brightTimer);
  if (npState.ackTimer) clearTimeout(npState.ackTimer);
  npState.ackTimer = null;
  npState.mode = 1;
  // Restart the pulse animation even on back-to-back handoffs: clear the
  // class, force a reflow, then re-apply.
  const root = npEl('np-root');
  root.className = '';
  void root.offsetWidth;
  npSetSalience('np-bright');
  npState.brightTimer = setTimeout(() => {
    if (npState.mode === 1) {
      npSetSalience('np-dim');
      if (!npState.ackTimer) npState.mode = 0;
    }
  }, 4000);
  if (prev) {
    npState.ackTimer = setTimeout(() => {
      npState.ackTimer = null;
      npState.mode = 2;
      npSetSalience('np-question');
      renderPanel();
    }, ACK_GRACE_MIN * 60000);
  }
}

function npAck() {
  if (npState.mode === 1) {
    if (npState.ackTimer) clearTimeout(npState.ackTimer);
    npState.ackTimer = null;
    npState.mode = 0;
    npSetSalience('np-dim');
    renderPanel();
  } else if (npState.mode === 3) {
    npState.mode = 0;
    npState.stay = null;
    npSetSalience('np-dim');
    renderPanel();
  }
}

function npTick() {
  if (npState.fetchedDate && npLocalDate() !== npState.fetchedDate) {
    npFetchDay();
  }
  const row = npActiveAt(nowMinutes());
  const key = npKeyOf(row);
  if (key !== npState.clockKey) {
    npHandoff(row, key);
  } else {
    npState.active = row;
  }
  renderPanel();
}

function renderPanel() {
  const m = nowMinutes();
  const bc = npEl('np-breadcrumb');
  const label = npEl('np-label');
  const elapsed = npEl('np-elapsed-text');
  const show = npState.mode === 3 ? npState.stay : npState.active;
  if (show) {
    bc.textContent = show.kind.toUpperCase();
    label.textContent = show.label;
    const range = npFmt24(show.start) + '–' + npFmt24(show.end);
    if (npState.mode === 3) {
      elapsed.textContent = 'overrun +' + npOverrun(m, npState.stayEnd) + ' min · ' + range;
    } else {
      elapsed.textContent = 'NOW · ' + Math.max(0, Math.floor(m - show.start)) + ' min in · ' + range;
    }
  } else {
    bc.textContent = '';
    const next = npNextAt(m);
    if (next) {
      label.textContent = 'nothing active';
      elapsed.textContent = 'next: ' + next.label + ' at ' + npFmt24(next.start);
    } else if (npState.day && npState.day.rows.length) {
      label.textContent = 'day complete';
      elapsed.textContent = '';
    } else {
      label.textContent = 'no fixed points today';
      elapsed.textContent = '';
    }
  }
  npRenderTodos(show);
  const q = npEl('np-question');
  if (npState.mode === 2 && npState.prev) {
    npEl('np-qtext').textContent = npState.prev.label +
      ' ended ' + npOverrun(m, npState.prevEnd) + ' min ago — still on it?';
    q.classList.remove('hidden');
  } else {
    q.classList.add('hidden');
  }
  npEl('np-badge').classList.toggle('hidden', !npState.interrupted);
  npSyncHeight();
}

// Collapsed to the first open item plus a visible count (the same collapse-
// with-count pattern the whole app uses). No open items = no row at all.
function npRenderTodos(show) {
  const el = npEl('np-todos');
  const open = npState.switchOpen ? [] : npChecklist(show);
  el.innerHTML = '';
  el.classList.toggle('hidden', !open.length);
  if (!open.length) return;
  if (open.length < 2) npState.todosExpanded = false;
  const shown = npState.todosExpanded ? open : open.slice(0, 1);
  for (let k = 0; k < shown.length; k++) {
    const t = shown[k];
    const row = document.createElement('div');
    row.className = 'np-todo';
    row.dataset.type = t.type;
    row.dataset.id = t.id;
    const check = document.createElement('span');
    check.className = 'np-todo-check';
    check.textContent = '○';
    const text = document.createElement('span');
    text.className = 'np-todo-text';
    text.textContent = t.text;
    row.appendChild(check);
    row.appendChild(text);
    if (k === 0 && open.length > 1) {
      const more = document.createElement('span');
      more.className = 'np-todo-more';
      more.textContent = npState.todosExpanded ? '⌃' : '⌄' + (open.length - 1);
      row.appendChild(more);
    }
    el.appendChild(row);
  }
}

// Checking off: a routine item is done for the day (PATCH), a placed action
// is complete (DELETE). Refetch after — never flip local state blind.
async function npTodoCheck(type, id) {
  if (npState.switchOpen) return;
  if (type === 'routine') {
    await fetch(`/api/routine-items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    });
  } else {
    await fetch(`/api/inbox/${id}`, { method: 'DELETE' });
  }
  fetch('/api/panel/saved', { method: 'POST' });
  await npFetchDay();
}

// --- switch mark: silence = on-task; a switch is a logged deviation ---
// The plan-slice editor died with the plan text: a switch is now just the
// REQUIRED reason, logged as an Observation against the active row.

function npOpenSwitch() {
  if (npState.switchOpen) { npEl('np-reason').focus(); return; }
  npState.switchOpen = true;
  npEl('np-reason').value = '';
  npEl('np-switch-save').disabled = true;
  npEl('np-switch-form').classList.remove('hidden');
  npSyncHeight();
  npEl('np-reason').focus();
}

function npCloseSwitch() {
  npState.switchOpen = false;
  npEl('np-switch-form').classList.add('hidden');
  npSyncHeight();
}

async function npSwitchSave() {
  const reason = npEl('np-reason').value.trim();
  if (!reason) return;
  await fetch('/api/observations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'switch', note: reason, now_block: npNowLabel() }),
  });
  npCloseSwitch();
  renderPanel();
}

function npMarkInterrupted() {
  if (npState.interrupted) {
    npState.interrupted = false;
  } else {
    npState.interrupted = true;
    fetch('/api/observations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'interruption', note: '', now_block: npNowLabel() }),
    });
  }
  renderPanel();
}

function initPanel() {
  npEl('np-root').addEventListener('click', npAck);

  // The switch form is a deliberate action, not an acknowledgement of a
  // handoff — keep its clicks from bubbling to the np-root ack handler.
  npEl('np-switch-form').addEventListener('click', e => e.stopPropagation());

  npEl('np-todos').addEventListener('click', e => {
    e.stopPropagation();
    if (e.target.closest('.np-todo-more')) {
      npState.todosExpanded = !npState.todosExpanded;
      renderPanel();
      return;
    }
    const row = e.target.closest('.np-todo');
    if (row) npTodoCheck(row.dataset.type, parseInt(row.dataset.id));
  });

  npEl('np-stay').addEventListener('click', e => {
    e.stopPropagation();
    npState.stay = npState.prev;
    npState.stayEnd = npState.prevEnd;
    npState.mode = 3;
    npSetSalience('np-dim');
    renderPanel();
  });

  npEl('np-advance').addEventListener('click', e => {
    e.stopPropagation();
    npState.mode = 0;
    npSetSalience('np-dim');
    renderPanel();
  });

  npEl('np-reason').addEventListener('input', () => {
    npEl('np-switch-save').disabled = !npEl('np-reason').value.trim();
  });

  npEl('np-switch-save').addEventListener('click', npSwitchSave);
  npEl('np-switch-cancel').addEventListener('click', npCloseSwitch);

  // Ctrl+Enter saves, Esc cancels — document-bound, since a window resize can
  // drop focus out of the form mid-edit.
  document.addEventListener('keydown', e => {
    if (!npState.switchOpen) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!npEl('np-reason').value.trim()) { npEl('np-reason').focus(); return; }
      npSwitchSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      npCloseSwitch();
    }
  });

  npFetchDay();
  setInterval(npFetchDay, 60000);
  setInterval(npTick, 5000);
}

initPanel();
