"""WHEN a scheduled change starts governing - the day, not the day after.
Run: python effective_date_test.py

2026-09-02, Quentin's report, two halves of ONE cause: the effective date was
derived from the CLOCK alone, never from the date asked for or the time of day
the change actually decides.

  "even though both the morning gate and the night gate are over 24 hours on
   9/3, the editing starts at 9/4"

    effective_date_for rounded UP whenever apply_at had any time component at
    all. That round-up is right for a change landing at 16:24 against a 06:00
    gate - it cannot govern that morning, which already happened. It is wrong
    for the same change against a 22:00 gate, and wrong for a change landing at
    03:00 against either. So the round-up now asks WHAT MINUTE the change
    governs (the window's opening) instead of assuming the worst.

  "I tried to change the morning routine step time on Sunday, Sept 6, but then
   it said easing takes 24 hours"

    The routine half took no date AT ALL: _pend never passed apply_at, so every
    flow and flow_step easing was now + 24h whatever was asked for. Gates had
    had `effective_from` since 2026-08-17; routines simply never got it.

Both halves keep the rule that makes the forward date safe on the money path:
A DATE IS A FLOOR, NEVER A BYPASS. It can push a landing later, never earlier,
and an easing dated inside its own delay still serves the delay.
"""

import os
import sqlite3
import sys
import tempfile
from datetime import date as date_cls, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(tempfile.mkdtemp())
sys.path.insert(0, HERE)

import storage          # noqa: E402
import qr_judge         # noqa: E402

ok, bad = [], []


def check(label, cond, extra=''):
    (ok if cond else bad).append(('PASS' if cond else 'FAIL') + '  ' + label
                                 + (' - ' + str(extra) if extra else ''))


storage.init_db()

# ── The minute a change governs decides its day ──────────────
M6, M22 = 6 * 60, 22 * 60          # a 06:00 gate and a 22:00 gate

check('landing 03:00 governs a 06:00 gate THAT day',
      storage.effective_date_for('2026-09-03 03:00:00', M6) == '2026-09-03')
check('landing exactly at the opening still counts',
      storage.effective_date_for('2026-09-03 06:00:00', M6) == '2026-09-03')
check('...but a minute past it does not',
      storage.effective_date_for('2026-09-03 06:01:00', M6) == '2026-09-04')
check('the 16:24 case that the round-up existed for still rounds up',
      storage.effective_date_for('2026-09-03 16:24:00', M6) == '2026-09-04')
check('the same 16:24 change DOES govern a 22:00 gate that night',
      storage.effective_date_for('2026-09-03 16:24:00', M22) == '2026-09-03')
check('a second past the opening is past it (no free minute)',
      storage.effective_date_for('2026-09-03 06:00:01', M6) == '2026-09-04')

# With nothing to govern against the answer stays conservative - late, never
# wrong - because this is the money path and the caller told us nothing.
check('no governed minute keeps the old always-round-up answer',
      storage.effective_date_for('2026-09-03 03:00:00') == '2026-09-04')
check('...and midnight still needs no rounding either way',
      (storage.effective_date_for('2026-09-03 00:00:00'),
       storage.effective_date_for('2026-09-03 00:00:00', M6)) == ('2026-09-03', '2026-09-03'))

# ── A gate resolves its own opening ──────────────────────────
node = {'id': 1, 'window_start': '06:00', 'window_end': '09:00',
        'window_end_offset_days': 0, 'active': 1}
at = datetime(2026, 9, 3, 3, 0)
check('a gate patch asks the window it is about',
      qr_judge._governs_min(node, {}, at) == M6, qr_judge._governs_min(node, {}, at))
# Moving the opening EARLIER in the same patch is judged against the earlier of
# the two, so a change can never claim a day it could not have governed.
check('moving the opening earlier is judged against the earlier reading',
      qr_judge._governs_min(node, {'window_start': '04:00'}, at) == 4 * 60,
      qr_judge._governs_min(node, {'window_start': '04:00'}, at))
check('moving it later is judged against the CURRENT (earlier) opening',
      qr_judge._governs_min(node, {'window_start': '08:00'}, at) == M6,
      qr_judge._governs_min(node, {'window_start': '08:00'}, at))

# ── A routine easing can be dated, and the floor still holds ─
flow = storage.create_flow('Morning')
step = storage.create_flow_step(flow['id'], 'Meditate', days_of_week='0123456')
conn = sqlite3.connect(storage.DB_PATH)
conn.execute('UPDATE flow SET qr_node_id = 1 WHERE id = ?', (flow['id'],))
conn.commit()
conn.close()


def pending_row():
    c = sqlite3.connect(storage.DB_PATH)
    c.row_factory = sqlite3.Row
    r = c.execute("SELECT * FROM easing_pending WHERE kind = 'flow_step'").fetchone()
    c.close()
    return r


TODAY = date_cls.today()
SUNDAY = (TODAY + timedelta(days=4)).isoformat()

# Dropping a day from a GATED routine is an easing, so it queues.
storage.update_flow_step(step['id'], days_of_week='012345', effective_from=SUNDAY)
r = pending_row()
check('a routine easing dated four days out lands on that day, not tomorrow',
      r['effective_date'] == SUNDAY, r['effective_date'])
check('...and its apply_at is that morning, not now + 24h',
      r['apply_at'].startswith(SUNDAY), r['apply_at'])

# A FLOOR, never a bypass: a date inside the delay does not shorten it.
storage.update_flow_step(step['id'], days_of_week='01234',
                         effective_from=TODAY.isoformat())
r = pending_row()
check('an easing dated TODAY still serves its 24h',
      r['effective_date'] > TODAY.isoformat(), r['effective_date'])
storage.update_flow_step(step['id'], days_of_week='0123',
                         effective_from=(TODAY - timedelta(days=30)).isoformat())
check('...and dating it into the PAST cannot reach back either',
      pending_row()['effective_date'] > TODAY.isoformat(),
      pending_row()['effective_date'])

# No date at all behaves exactly as it did before any of this.
storage.update_flow_step(step['id'], days_of_week='012')
check('no date is the old behaviour, untouched',
      pending_row()['effective_date'] > TODAY.isoformat(),
      pending_row()['effective_date'])

for line in ok + bad:
    print(line)
print(f'\n{len(ok)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
