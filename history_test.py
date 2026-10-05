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
say on that day.

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

# The ROUTINE half this file was written for is gone with the routines
# (2026-10-05) — routines are plain lists, and nothing resolves a routine's
# deadline any more. What stays is the mechanism: a recorded revision says what
# a field held BEFORE the day it changed, and row_as_of answers each day against
# the rule of its own time.
ROW = {'id': 1, 'offset_min': -60}
conn = storage.get_conn()
storage.record_revision(conn, 'probe', 1, 'offset_min', 0, day(0))
storage.record_revision(conn, 'probe', 1, 'offset_min', -30, day(0))
storage.record_revision(conn, 'probe', 1, 'offset_min', -15, day(-3))
conn.commit()
revs = storage._past_revisions(conn, 'probe', 1)
conn.close()


def offset_on(ymd):
    return storage.row_as_of(ROW, revs, ymd)['offset_min']


check('today takes the newest', offset_on(day(0)), -60)
check('tomorrow too', offset_on(day(1)), -60)
check('a day between two changes reads the middle value', offset_on(day(-1)), 0)
check('a day before the dated revision reads its old value', offset_on(day(-5)), -15)
check('a value comes back with its type', type(offset_on(day(-5))), int)

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
