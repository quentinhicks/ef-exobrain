// The browser half of popup_viewport_test.py — run that, not this.
//   node popup_viewport_test.js <base-url>
// Opens every popup the app has, at every edge of three window sizes, and
// measures each one against the viewport. A popup that never opened fails
// too: a check that measured nothing has proved nothing.
const { chromium } = require('playwright');

const BASE = process.argv[2];
const SIZES = [
  { name: 'phone', width: 430, height: 930 },
  { name: 'laptop', width: 1400, height: 900 },
  { name: 'short', width: 900, height: 420 },
];
// Everything that floats over a page. A new popup joins this list AND goes
// through fitInViewport (client_rules_test holds that half).
const POPUPS = '#obj-menu, .wk-pop, #blk-hover, #drag-tip, #gate-pop, #event-pop, .tn-menu, .sheet, #app-toast';
const results = [];

const api = (path, method, body) => fetch(BASE + path, {
  method: method || 'GET', headers: { 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(r => r.json().catch(() => ({})));

async function seed() {
  const area = await api('/api/areas', 'POST', { name: 'Health', type: 'standard' });
  const mk = async (content, patch) => {
    const it = await api('/api/inbox', 'POST', { content });
    await api(`/api/inbox/${it.id}`, 'PATCH', patch);
    return it.id;
  };
  await mk('Run a marathon', { status: 'active', kind: 'project', area_id: area.id });
  await mk('Loose action', { status: 'active', on_projects: 1, area_id: area.id });
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Two blocks, so one is on screen whatever hour the suite runs at.
  for (const [s, e, label] of [[540, 720, 'Deep work'], [780, 1020, 'Admin']]) {
    await api('/api/day-blocks', 'POST', { date: today, start_min: s, end_min: e, label, color: '#6c8ebf' });
  }
}

// Which of `sel`'s visible elements hang outside the window, and how many
// were seen at all.
function measure(page, sel) {
  return page.evaluate(([all, want]) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const seen = el => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0
        && r.width > 0 && r.height > 0;
    };
    const name = el => (el.id ? '#' + el.id : '.' + [...el.classList].join('.'));
    const out = [];
    document.querySelectorAll(all).forEach(el => {
      if (!seen(el)) return;
      const r = el.getBoundingClientRect();
      if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) {
        out.push(`${name(el)} at [${Math.round(r.left)}, ${Math.round(r.top)}, ${Math.round(r.right)}, ${
          Math.round(r.bottom)}] in ${vw}x${vh}`);
      }
    });
    return { out, opened: [...document.querySelectorAll(want)].filter(seen).length };
  }, [POPUPS, sel]);
}

async function check(page, size, label, sel) {
  await page.waitForTimeout(120);
  const m = await measure(page, sel);
  const ok = m.opened > 0 && !m.out.length;
  results.push({ ok, line: `${ok ? 'PASS' : 'FAIL'}  ${size.name} ${label}${
    m.opened ? '' : ' - did not open'}${m.out.length ? ' - ' + m.out.join('; ') : ''}` });
}

const corners = s => [
  ['top-left', 4, 60], ['top-right', s.width - 4, 60], ['bottom-left', 4, s.height - 4],
  ['bottom-right', s.width - 4, s.height - 4], ['middle', s.width / 2, s.height / 2],
];

// A right-click (and so a finger's hold) on `sel`, at a point of our choosing:
// the menu opens at the pointer, so the pointer is what gets pushed to an edge.
const rightClickAt = (page, sel, x, y) => page.evaluate(([s, cx, cy]) => {
  const el = document.querySelector(s);
  if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
}, [sel, x, y]);

// A stand-in anchor at a point, for the popups placed beside an element.
const anchorAt = (page, x, y) => page.evaluate(([cx, cy]) => {
  let a = document.getElementById('pv-anchor');
  if (!a) {
    a = document.createElement('div');
    a.id = 'pv-anchor';
    a.style.cssText = 'position:fixed;width:40px;height:24px;pointer-events:none';
    document.body.appendChild(a);
  }
  a.style.setProperty('left', `${Math.max(0, Math.min(cx - 20, window.innerWidth - 40))}px`);
  a.style.setProperty('top', `${Math.max(0, Math.min(cy - 12, window.innerHeight - 24))}px`);
  a.dataset.name = 'A block with a long name that would run off the right edge of a narrow window';
  a.dataset.what = '9:00 AM – 12:00 PM · and what it is for, at some length';
}, [x, y]);

async function run(browser, size) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const open = async path => {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
  };

  // ── Projects: the object menu, a row's menu, the strip menus, clarify ──
  await open('/projects');
  await page.waitForSelector('#map-body .map-row');
  for (const [where, x, y] of corners(size)) {
    await rightClickAt(page, '#map-body .mp-sec-title[data-obj]', x, y);
    await check(page, size, `area menu, ${where}`, '#obj-menu');
    await rightClickAt(page, '#map-body .map-row', x, y);
    await check(page, size, `row menu, ${where}`, '#obj-menu');
    await page.evaluate(() => closeObjectMenu());
  }
  for (const pill of ['#hz-pill', '#map-filter']) {
    await page.click(pill);
    await check(page, size, `strip menu ${pill}`, '.tn-menu');
    await page.keyboard.press('Escape');
  }
  for (const [where, x, y] of corners(size)) {
    await anchorAt(page, x, y);
    await page.evaluate(() => showBlockHover(document.getElementById('pv-anchor')));
    await check(page, size, `block hover, ${where}`, '#blk-hover');
    await page.evaluate(() => hideBlockHover());
    await page.evaluate(() => dragTip(document.getElementById('pv-anchor'), '11:45 PM → 12:15 AM +1d'));
    await check(page, size, `drag tip, ${where}`, '#drag-tip');
    await page.evaluate(() => dragTipHide());
    // The read-out, as tall as it gets, beside a pill at each edge.
    await page.evaluate(() => {
      const el = document.getElementById('gate-pop');
      el.classList.remove('hidden');
      el.innerHTML = '<div class="gp-note">' + 'A line of the read-out. '.repeat(120) + '</div>';
      placeGatePop(el, document.getElementById('pv-anchor'));
    });
    await check(page, size, `gate read-out, ${where}`, '#gate-pop');
    await page.evaluate(() => document.getElementById('gate-pop').classList.add('hidden'));
  }
  await page.evaluate(() => toast('A refusal said in words, long enough to wrap on a phone: ' + 'word '.repeat(40)));
  await check(page, size, 'toast', '#app-toast');
  await page.click('#map-body .map-row .map-text');
  await page.waitForSelector('#clarify-sheet:not(.hidden)');
  await check(page, size, 'clarify sheet', '#clarify-sheet');

  // ── Calendar: a block's card, the hours panel, the legend, its menu ──
  for (const path of ['/calendar', '/calendar/week']) {
    await open(path);
    await page.waitForSelector('#cal-week .wk-block');
    const view = path.endsWith('week') ? 'week' : 'day';
    for (const [where, x, y] of corners(size)) {
      await rightClickAt(page, '#cal-week .wk-block:not(.tl-block-cont)', x, y);
      await check(page, size, `${view} block card, ${where}`, '.wk-task-pop');
      await page.evaluate(() => { calWeek.pop = null; calWeek.taskPop = null; renderCalWeek(); });
    }
    await page.evaluate(() => { calWeek.pop = 'range'; renderCalWeek(); });
    await check(page, size, `${view} hours panel`, '.wk-range-pop');
    await page.evaluate(() => { calWeek.pop = 'legend'; renderCalWeek(); });
    await check(page, size, `${view} legend`, '.wk-legend-pop');
    await page.evaluate(() => { calWeek.pop = null; renderCalWeek(); });
    await page.click('#cal-filter');
    await check(page, size, `${view} strip menu`, '.tn-menu');
    await page.keyboard.press('Escape');
  }

  errors.forEach(e => results.push({ ok: false, line: `FAIL  ${size.name} page error - ${e}` }));
  await page.close();
}

(async () => {
  await seed();
  let browser;
  for (const channel of ['chrome', 'msedge']) {
    try { browser = await chromium.launch({ channel }); break; } catch (e) { /* the next one */ }
  }
  if (!browser) { console.log('NO BROWSER'); process.exit(3); }
  for (const size of SIZES) await run(browser, size);
  await browser.close();
  const bad = results.filter(r => !r.ok);
  (bad.length ? bad : []).forEach(r => console.log(r.line));
  console.log(`${results.length - bad.length} of ${results.length} popup placements inside the viewport`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.log('FAIL  the driver itself - ' + (e && e.message)); process.exit(1); });
