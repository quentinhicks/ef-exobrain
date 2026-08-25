"""A change does not rewrite the past. Run: python history_test.py

Quentin, 2026-08-24: "when I changed the routine window settings it changed
the routine window settings in the past."

He was right, and it was the shape CLAUDE.md already names: a standing rule
resolved FOR A DATE was resolved against the rule as it is NOW. Gates survive
that by a different mechanism — a judged day is frozen with the window it was
judged against — but that only covers days money ran on, and nothing at all
covered routines. Changing an offset this morning changed what last Tuesday
said the routine was due at.

`row_revision` is the past half of `easing_pending`: the value a field held
BEFORE a change, from the day the change starts governing. `storage.row_as_of`
layers both halves, so a caller keeps asking one question — what did this row
say on that day — and `qr_judge._flow_on` is the single hop that makes every
routine answer honour it.

These checks run against a scratch database, never the real one.
"""

import json
import os
import sys
import tempfile
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

_tmp = tempfile.mkdtemp(prefix='qpa-history-')
os.chdir(_tmp)

import storage                      # noqa: E402  (after the chdir, like every suite here)
import qr_judge                     # noqa: E402

passed = 0
failed = 0


def check(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
        print(f'PASS  {name}')
    else:
        failed += 1
        print(f'FAIL  {name}: got {got!r}, wanted {want!r}')


def day(offset):
    return (date.today() + timedelta(days=offset)).isoformat()


storage.init_db()

# A gate at 09:00 and a routine that hangs off it, so the routine's deadline is
# the gate's close plus its offset — the field the report was about.
node_id = storage.qr_create_node('Desk', 'tok-history', '06:00', '09:00')
flow = storage.create_flow('Morning')
storage.update_flow(flow['id'], qr_node_id=node_id, offset_min=0)


def due_on(ymd):
    f = next(x for x in storage.get_flows() if x['id'] == flow['id'])
    return qr_judge.flow_day_window(f, ymd)[1]


check('the deadline starts at the gate close', due_on(day(0)), 9 * 60)
check('and the same last week', due_on(day(-7)), 9 * 60)

# ── the report: change it today ─────────────────────────────────────────────
storage.update_flow(flow['id'], offset_min=-30)      # earlier: a tightening
check('today moves', due_on(day(0)), 8 * 60 + 30)
check('tomorrow moves', due_on(day(1)), 8 * 60 + 30)
check('LAST WEEK DOES NOT', due_on(day(-7)), 9 * 60)
check('and neither does yesterday', due_on(day(-1)), 9 * 60)

# ── a second change stacks: each day resolves against the rule of its own time
storage.update_flow(flow['id'], offset_min=-60)
check('today takes the newest', due_on(day(0)), 8 * 60)
check('yesterday still holds the first value', due_on(day(-1)), 9 * 60)

# The earliest change AFTER a date is what says what the field held then, so a
# day between two changes reads the middle value — not the oldest, not the
# newest. (Recorded by hand: both changes above landed today, and the test
# cannot travel in time.)
conn = storage.get_conn()
storage.record_revision(conn, 'flow', flow['id'], 'offset_min', -15, day(-3))
conn.commit()
conn.close()
check('a day before the dated revision reads its old value', due_on(day(-5)), 8 * 60 + 45)
check('a day after it is unaffected by it', due_on(day(-1)), 9 * 60)

# ── the window field, not just the offset ──────────────────────────────────
src = storage.create_schedule_source(
    'rule', title='evenings', start=f'{day(-30)}T20:00:00', duration='PT1H',
    recurrenceRules=[{'frequency': 'daily', 'interval': 1}])
storage.update_flow(flow['id'], source_uid=src['uid'])
check('its own window governs today', due_on(day(0)), 21 * 60)
check('and the past keeps the gate-derived deadline', due_on(day(-1)), 9 * 60)

# ── the future half still works: a queued easing is NOT in force yet ────────
storage.update_flow(flow['id'], source_uid=None)
storage.update_flow(flow['id'], offset_min=90)       # later: an easing, waits 24h
check('a queued easing leaves today alone', due_on(day(0)), 8 * 60)
row = storage.get_conn().execute(
    "SELECT COUNT(*) AS n FROM easing_pending WHERE kind = 'flow' AND field = 'offset_min'"
).fetchone()
check('and is queued', row['n'], 1)

# ── row_as_of itself, both directions, in one call ─────────────────────────
mixed = [
    {'field': 'offset_min', 'old_value': 5, 'effective_date': day(0), 'past': True},
    {'field': 'source_uid', 'value': 'later', 'effective_date': day(3)},
]
check('past half applies before its date',
      storage.row_as_of({'offset_min': 99, 'source_uid': None}, mixed, day(-1))['offset_min'], 5)
check('past half does not apply on or after it',
      storage.row_as_of({'offset_min': 99, 'source_uid': None}, mixed, day(0))['offset_min'], 99)
check('future half applies from its date',
      storage.row_as_of({'offset_min': 99, 'source_uid': None}, mixed, day(3))['source_uid'], 'later')
check('and not before it',
      storage.row_as_of({'offset_min': 99, 'source_uid': None}, mixed, day(2))['source_uid'], None)

print()
print(f'{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
